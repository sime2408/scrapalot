package com.scrapalot.backend.service

import com.scrapalot.backend.domain.chat.DirectConversation
import com.scrapalot.backend.domain.chat.DirectMessage
import com.scrapalot.backend.dto.DirectConversationResponse
import com.scrapalot.backend.dto.DirectMessageResponse
import com.scrapalot.backend.repository.DirectConversationRepository
import com.scrapalot.backend.repository.DirectMessageRepository
import com.scrapalot.backend.repository.UserRepository
import com.scrapalot.backend.utils.runAfterCommit
import mu.KotlinLogging
import org.springframework.data.domain.PageRequest
import org.springframework.messaging.simp.SimpMessagingTemplate
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.UUID

private val logger = KotlinLogging.logger {}

/**
 * Admin → user messaging overlay on the direct-message tables.
 *
 * Reuses [DirectConversation]/[DirectMessage] but with `workspace_id = NULL` and a
 * `kind` discriminator (`admin_dm` | `admin_broadcast`), so admin messages bypass the
 * workspace-membership + subscription gating that the peer [DirectMessageService]
 * enforces. Delivery reuses the same `/user/queue/dm` channel with `type = "admin_message"`
 * so the frontend routes it to the notification bell + prominent toast (and the existing
 * peer DM hook, which only handles `type = "message"`, ignores it).
 *
 * Convention: admin = participantOne (sender), target user = participantTwo (recipient).
 */
@Service
@Transactional
class AdminMessageService(
    private val conversationRepository: DirectConversationRepository,
    private val messageRepository: DirectMessageRepository,
    private val userRepository: UserRepository,
    private val messagingTemplate: SimpMessagingTemplate
) {
    companion object {
        const val MAX_CONTENT_LENGTH = 4000
        const val MAX_MESSAGES_PER_CONVERSATION = 100
        const val KIND_DM = "admin_dm"
        const val KIND_BROADCAST = "admin_broadcast"
        private const val QUEUE_DM = "/queue/dm"
    }

    private fun getOrCreateAdminConversation(
        adminId: UUID,
        userId: UUID,
        kind: String
    ): DirectConversation =
        conversationRepository.findAdminConversation(adminId, userId, kind)
            ?: conversationRepository.save(
                DirectConversation(
                    participantOneId = adminId,
                    participantTwoId = userId,
                    workspaceId = null,
                    kind = kind
                )
            )

    /** Admin sends a (replyable) direct message to a single user. */
    fun sendTargeted(
        adminId: UUID,
        userId: UUID,
        content: String
    ): DirectMessageResponse {
        val text = validateContent(content)
        val conversation = getOrCreateAdminConversation(adminId, userId, KIND_DM)
        val conversationId = requireNotNull(conversation.id)

        val saved = messageRepository.save(DirectMessage(conversationId = conversationId, senderId = adminId, content = text))
        conversationRepository.save(conversation.copy(updatedAt = Instant.now()))
        trimOldMessages(conversationId)

        val enriched = enrichMessage(saved)
        runAfterCommit { pushAdminMessage(userId, conversationId, KIND_DM, enriched) }
        return enriched
    }

    /** Admin broadcasts an announcement to every active user (read-only per recipient). */
    fun broadcast(
        adminId: UUID,
        content: String
    ): Int {
        val text = validateContent(content)
        val recipients = userRepository.findByIsActive(true).mapNotNull { it.id }.filter { it != adminId }

        val deliveries = mutableListOf<Triple<UUID, UUID, DirectMessageResponse>>()
        for (userId in recipients) {
            val conversation = getOrCreateAdminConversation(adminId, userId, KIND_BROADCAST)
            val conversationId = requireNotNull(conversation.id)
            val saved = messageRepository.save(DirectMessage(conversationId = conversationId, senderId = adminId, content = text))
            conversationRepository.save(conversation.copy(updatedAt = Instant.now()))
            trimOldMessages(conversationId)
            deliveries += Triple(userId, conversationId, enrichMessage(saved))
        }

        runAfterCommit {
            deliveries.forEach { (userId, conversationId, message) ->
                pushAdminMessage(userId, conversationId, KIND_BROADCAST, message)
            }
        }
        logger.info { "Admin $adminId broadcast delivered to ${deliveries.size} users" }
        return deliveries.size
    }

    /** A user (or the admin) replies in an admin_dm thread. Broadcasts are read-only. */
    fun reply(
        userId: UUID,
        conversationId: UUID,
        content: String
    ): DirectMessageResponse {
        val text = validateContent(content)
        val conversation = loadAdminConversation(conversationId, userId)
        require(conversation.kind == KIND_DM) { "Cannot reply to a broadcast announcement" }

        val saved = messageRepository.save(DirectMessage(conversationId = conversationId, senderId = userId, content = text))
        conversationRepository.save(conversation.copy(updatedAt = Instant.now()))
        trimOldMessages(conversationId)

        val recipientId = otherParticipant(conversation, userId)
        val enriched = enrichMessage(saved)
        runAfterCommit { pushAdminMessage(recipientId, conversationId, KIND_DM, enriched) }
        return enriched
    }

    @Transactional(readOnly = true)
    fun getAdminThreads(userId: UUID): List<DirectConversationResponse> =
        conversationRepository.findAdminThreadsForParticipant(userId).map { conv ->
            val convId = requireNotNull(conv.id)
            val otherUserId = otherParticipant(conv, userId)
            val otherUser = userRepository.findById(otherUserId).orElse(null)
            val unread = messageRepository.countUnreadByConversation(convId, userId)
            val last = messageRepository.findByConversationIdOrderByCreatedAtDesc(convId, PageRequest.of(0, 1)).firstOrNull()
            DirectConversationResponse(
                id = convId,
                workspaceId = null,
                otherUserId = otherUserId,
                otherUsername = otherUser?.username,
                otherFirstName = otherUser?.firstName,
                otherLastName = otherUser?.lastName,
                otherProfilePicture = otherUser?.profilePicture,
                lastMessage = last?.content?.take(100),
                lastMessageAt = last?.createdAt,
                unreadCount = unread,
                createdAt = conv.createdAt,
                kind = conv.kind
            )
        }

    @Transactional(readOnly = true)
    fun getAdminMessages(
        conversationId: UUID,
        userId: UUID
    ): List<DirectMessageResponse> {
        loadAdminConversation(conversationId, userId)
        val pageable = PageRequest.of(0, MAX_MESSAGES_PER_CONVERSATION)
        return messageRepository.findByConversationIdOrderByCreatedAtDesc(conversationId, pageable).reversed().map { enrichMessage(it) }
    }

    /** Mark a thread's incoming messages read (clears the unread badge) without removing it
     *  from the bell — used when a user opens a thread to read it. */
    fun markRead(
        conversationId: UUID,
        userId: UUID
    ) {
        loadAdminConversation(conversationId, userId)
        messageRepository.markAllRead(conversationId, userId, Instant.now())
    }

    /**
     * Dismiss == clear the thread from this user's notification bell. Marks the thread's
     * incoming messages read AND stamps the caller's per-participant dismissed_at, so the
     * thread leaves the list (not just the unread badge). A later message bumps the
     * conversation's updated_at past dismissed_at and re-surfaces it.
     */
    fun dismiss(
        conversationId: UUID,
        userId: UUID
    ) {
        val conversation = loadAdminConversation(conversationId, userId)
        val now = Instant.now()
        messageRepository.markAllRead(conversationId, userId, now)
        if (conversation.participantOneId == userId) {
            conversation.participantOneDismissedAt = now
        } else {
            conversation.participantTwoDismissedAt = now
        }
        conversationRepository.save(conversation)
    }

    // ---- helpers ----

    private fun loadAdminConversation(
        conversationId: UUID,
        userId: UUID
    ): DirectConversation {
        val conversation =
            conversationRepository.findById(conversationId).orElseThrow { IllegalArgumentException("Conversation not found") }
        require(conversation.workspaceId == null && conversation.kind in setOf(KIND_DM, KIND_BROADCAST)) {
            "Not an admin conversation"
        }
        require(userId == conversation.participantOneId || userId == conversation.participantTwoId) {
            "User is not a participant of this conversation"
        }
        return conversation
    }

    private fun otherParticipant(
        conversation: DirectConversation,
        userId: UUID
    ): UUID = if (conversation.participantOneId == userId) conversation.participantTwoId else conversation.participantOneId

    private fun validateContent(content: String): String {
        val text = content.trim()
        require(text.isNotBlank()) { "Message content cannot be empty" }
        require(text.length <= MAX_CONTENT_LENGTH) { "Message exceeds $MAX_CONTENT_LENGTH characters" }
        return text
    }

    private fun pushAdminMessage(
        recipientId: UUID,
        conversationId: UUID,
        kind: String,
        message: DirectMessageResponse
    ) {
        messagingTemplate.convertAndSendToUser(
            recipientId.toString(),
            QUEUE_DM,
            mapOf(
                "type" to "admin_message",
                "kind" to kind,
                "conversation_id" to conversationId.toString(),
                "message" to message
            )
        )
    }

    private fun trimOldMessages(conversationId: UUID) {
        val count = messageRepository.countByConversationId(conversationId)
        if (count > MAX_MESSAGES_PER_CONVERSATION) {
            val excess = (count - MAX_MESSAGES_PER_CONVERSATION).toInt()
            val oldestIds = messageRepository.findOldestMessageIds(conversationId, PageRequest.of(0, excess))
            if (oldestIds.isNotEmpty()) messageRepository.deleteAllById(oldestIds)
        }
    }

    private fun enrichMessage(message: DirectMessage): DirectMessageResponse {
        val user = userRepository.findById(message.senderId).orElse(null)
        return DirectMessageResponse(
            id = requireNotNull(message.id) { "Message must have an ID" },
            conversationId = message.conversationId,
            senderId = message.senderId,
            senderUsername = user?.username,
            senderFirstName = user?.firstName,
            senderLastName = user?.lastName,
            senderProfilePicture = user?.profilePicture,
            content = message.content,
            readAt = message.readAt,
            createdAt = message.createdAt
        )
    }
}
