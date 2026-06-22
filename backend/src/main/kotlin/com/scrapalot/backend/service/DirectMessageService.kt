package com.scrapalot.backend.service

import com.scrapalot.backend.domain.chat.DirectConversation
import com.scrapalot.backend.domain.chat.DirectMessage
import com.scrapalot.backend.dto.DirectConversationResponse
import com.scrapalot.backend.dto.DirectMessageResponse
import com.scrapalot.backend.repository.DirectConversationRepository
import com.scrapalot.backend.repository.DirectMessageRepository
import com.scrapalot.backend.repository.UserRepository
import com.scrapalot.backend.repository.WorkspaceUserRepository
import org.springframework.data.domain.PageRequest
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.UUID

@Service
@Transactional
class DirectMessageService(
    private val conversationRepository: DirectConversationRepository,
    private val messageRepository: DirectMessageRepository,
    private val userRepository: UserRepository,
    private val workspaceUserRepository: WorkspaceUserRepository,
    private val subscriptionService: SubscriptionService
) {
    companion object {
        const val MAX_MESSAGES_PER_CONVERSATION = 100
        const val MAX_CONTENT_LENGTH = 4000
    }

    @Transactional(readOnly = true)
    fun canUseDirectMessages(userId: UUID): Boolean = subscriptionService.hasFeature(userId, "direct_messages")

    @Transactional(readOnly = true)
    fun areWorkspaceMembers(
        workspaceId: UUID,
        userA: UUID,
        userB: UUID
    ): Boolean =
        workspaceUserRepository.existsByWorkspaceIdAndUserId(workspaceId, userA) &&
            workspaceUserRepository.existsByWorkspaceIdAndUserId(workspaceId, userB)

    fun getOrCreateConversation(
        userA: UUID,
        userB: UUID,
        workspaceId: UUID
    ): DirectConversation {
        val existing = conversationRepository.findByParticipantsAndWorkspace(userA, userB, workspaceId)
        if (existing != null) return existing

        // Always store smaller UUID as participantOne for consistent lookups
        val (one, two) = if (userA < userB) userA to userB else userB to userA
        return conversationRepository.save(
            DirectConversation(
                participantOneId = one,
                participantTwoId = two,
                workspaceId = workspaceId
            )
        )
    }

    fun sendMessage(
        conversationId: UUID,
        senderId: UUID,
        content: String
    ): DirectMessageResponse {
        val conversation =
            conversationRepository
                .findById(conversationId)
                .orElseThrow { IllegalArgumentException("Conversation not found") }

        require(senderId == conversation.participantOneId || senderId == conversation.participantTwoId) {
            "User is not a participant of this conversation"
        }

        val message =
            messageRepository.save(
                DirectMessage(
                    conversationId = conversationId,
                    senderId = senderId,
                    content = content.trim()
                )
            )

        // Update conversation timestamp
        conversationRepository.save(conversation.copy(updatedAt = Instant.now()))

        // Enforce max 100 messages per conversation
        trimOldMessages(conversationId)

        return enrichMessage(message)
    }

    @Transactional(readOnly = true)
    fun getMessages(
        conversationId: UUID,
        userId: UUID
    ): List<DirectMessageResponse> {
        val conversation =
            conversationRepository
                .findById(conversationId)
                .orElseThrow { IllegalArgumentException("Conversation not found") }

        require(userId == conversation.participantOneId || userId == conversation.participantTwoId) {
            "User is not a participant of this conversation"
        }

        val pageable = PageRequest.of(0, MAX_MESSAGES_PER_CONVERSATION)
        val messages = messageRepository.findByConversationIdOrderByCreatedAtDesc(conversationId, pageable)
        return messages.reversed().map { enrichMessage(it) }
    }

    fun markAsRead(
        conversationId: UUID,
        userId: UUID
    ) {
        messageRepository.markAllRead(conversationId, userId, Instant.now())
    }

    @Transactional(readOnly = true)
    fun getConversations(
        userId: UUID,
        workspaceId: UUID? = null
    ): List<DirectConversationResponse> {
        val conversations =
            if (workspaceId != null) {
                conversationRepository.findAllByParticipantAndWorkspace(userId, workspaceId)
            } else {
                conversationRepository.findAllByParticipant(userId)
            }

        return conversations.map { conv ->
            val otherUserId = if (conv.participantOneId == userId) conv.participantTwoId else conv.participantOneId
            val otherUser = userRepository.findById(otherUserId).orElse(null)
            val unreadCount = messageRepository.countUnreadByConversation(requireNotNull(conv.id), userId)

            // Get last message preview
            val lastMessages =
                messageRepository.findByConversationIdOrderByCreatedAtDesc(
                    requireNotNull(conv.id),
                    PageRequest.of(0, 1)
                )
            val lastMessage = lastMessages.firstOrNull()

            DirectConversationResponse(
                id = requireNotNull(conv.id),
                workspaceId = conv.workspaceId,
                otherUserId = otherUserId,
                otherUsername = otherUser?.username,
                otherFirstName = otherUser?.firstName,
                otherLastName = otherUser?.lastName,
                otherProfilePicture = otherUser?.profilePicture,
                lastMessage = lastMessage?.content?.take(100),
                lastMessageAt = lastMessage?.createdAt,
                unreadCount = unreadCount,
                createdAt = conv.createdAt
            )
        }
    }

    @Transactional(readOnly = true)
    fun isParticipant(
        conversationId: UUID,
        userId: UUID
    ): Boolean {
        val conversation = conversationRepository.findById(conversationId).orElse(null) ?: return false
        return userId == conversation.participantOneId || userId == conversation.participantTwoId
    }

    @Transactional(readOnly = true)
    fun getOtherParticipant(
        conversationId: UUID,
        userId: UUID
    ): UUID? {
        val conversation = conversationRepository.findById(conversationId).orElse(null) ?: return null
        return if (conversation.participantOneId == userId) {
            conversation.participantTwoId
        } else if (conversation.participantTwoId == userId) {
            conversation.participantOneId
        } else {
            null
        }
    }

    private fun trimOldMessages(conversationId: UUID) {
        val count = messageRepository.countByConversationId(conversationId)
        if (count > MAX_MESSAGES_PER_CONVERSATION) {
            val excess = (count - MAX_MESSAGES_PER_CONVERSATION).toInt()
            val oldestIds =
                messageRepository.findOldestMessageIds(
                    conversationId,
                    PageRequest.of(0, excess)
                )
            if (oldestIds.isNotEmpty()) {
                messageRepository.deleteAllById(oldestIds)
            }
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
