package com.scrapalot.backend.service

import com.scrapalot.backend.domain.workspace.WorkspaceChatMessage
import com.scrapalot.backend.domain.workspace.WorkspaceChatPresence
import com.scrapalot.backend.dto.WorkspaceChatMessageResponse
import com.scrapalot.backend.dto.WorkspaceChatPresenceResponse
import com.scrapalot.backend.dto.WorkspaceChatPresenceUpdate
import com.scrapalot.backend.repository.UserRepository
import com.scrapalot.backend.repository.WorkspaceChatMessageRepository
import com.scrapalot.backend.repository.WorkspaceChatPresenceRepository
import com.scrapalot.backend.repository.WorkspaceUserRepository
import org.springframework.data.domain.PageRequest
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID

@Service
@Transactional
class WorkspaceChatService(
    private val messageRepository: WorkspaceChatMessageRepository,
    private val presenceRepository: WorkspaceChatPresenceRepository,
    private val userRepository: UserRepository,
    private val workspaceUserRepository: WorkspaceUserRepository,
    private val subscriptionService: SubscriptionService,
    private val workspaceService: WorkspaceService
) {
    companion object {
        const val STALE_PRESENCE_MINUTES = 5L
        const val DEFAULT_MESSAGE_LIMIT = 200
    }

    @Transactional(readOnly = true)
    fun canUseWorkspaceChat(userId: UUID): Boolean = subscriptionService.hasFeature(userId, "workspace_chat")

    @Transactional(readOnly = true)
    fun isWorkspaceMember(
        workspaceId: UUID,
        userId: UUID
    ): Boolean = workspaceUserRepository.existsByWorkspaceIdAndUserId(workspaceId, userId)

    fun sendMessage(
        workspaceId: UUID,
        senderId: UUID,
        content: String
    ): WorkspaceChatMessageResponse {
        val message =
            WorkspaceChatMessage(
                workspaceId = workspaceId,
                senderId = senderId,
                content = content.trim()
            )
        val saved = messageRepository.save(message)
        return enrichMessage(saved)
    }

    @Transactional(readOnly = true)
    fun getMessages(
        workspaceId: UUID,
        limit: Int = DEFAULT_MESSAGE_LIMIT
    ): List<WorkspaceChatMessageResponse> {
        val pageable = PageRequest.of(0, limit)
        val messages = messageRepository.findByWorkspaceIdOrderByCreatedAtDesc(workspaceId, pageable)
        return messages.reversed().map { enrichMessage(it) }
    }

    @Transactional(readOnly = true)
    fun isModerator(
        workspaceId: UUID,
        userId: UUID
    ): Boolean {
        if (workspaceService.isOwner(workspaceId, userId)) return true
        val user = userRepository.findById(userId).orElse(null) ?: return false
        return user.role.equals("admin", ignoreCase = true)
    }

    /**
     * Delete a single message. Sender may delete own messages; moderators
     * (workspace owner or system admin) may delete any message.
     * Returns the deleted message id, or null if the caller lacks permission.
     */
    fun deleteMessage(
        workspaceId: UUID,
        messageId: UUID,
        userId: UUID
    ): UUID? {
        val message = messageRepository.findByIdAndWorkspaceId(messageId, workspaceId) ?: return null
        val canDelete = message.senderId == userId || isModerator(workspaceId, userId)
        if (!canDelete) return null
        messageRepository.deleteById(messageId)
        return messageId
    }

    /**
     * Rollback the conversation from the given message onward (inclusive).
     * Restricted to moderators because it removes other users' messages too.
     */
    fun rollbackFrom(
        workspaceId: UUID,
        messageId: UUID,
        userId: UUID
    ): List<UUID> {
        if (!isModerator(workspaceId, userId)) return emptyList()
        val pivot = messageRepository.findByIdAndWorkspaceId(messageId, workspaceId) ?: return emptyList()
        val ids = messageRepository.findIdsByWorkspaceIdAndCreatedAtFrom(workspaceId, pivot.createdAt)
        if (ids.isNotEmpty()) messageRepository.deleteAllByIdInBatch(ids)
        return ids
    }

    /**
     * Wipe all messages in a workspace. Moderators only.
     */
    fun clearAll(
        workspaceId: UUID,
        userId: UUID
    ): Boolean {
        if (!isModerator(workspaceId, userId)) return false
        val ids = messageRepository.findIdsByWorkspaceId(workspaceId)
        if (ids.isNotEmpty()) messageRepository.deleteAllByIdInBatch(ids)
        return true
    }

    fun setOnline(
        userId: UUID,
        workspaceId: UUID
    ): WorkspaceChatPresenceUpdate {
        val presence = presenceRepository.findByUserIdAndWorkspaceId(userId, workspaceId)
        val updated =
            if (presence != null) {
                presenceRepository.save(presence.copy(isOnline = true, lastSeenAt = Instant.now()))
            } else {
                presenceRepository.save(
                    WorkspaceChatPresence(
                        userId = userId,
                        workspaceId = workspaceId,
                        isOnline = true,
                        lastSeenAt = Instant.now()
                    )
                )
            }
        return enrichPresenceUpdate(updated)
    }

    fun setOffline(
        userId: UUID,
        workspaceId: UUID
    ): WorkspaceChatPresenceUpdate {
        val presence = presenceRepository.findByUserIdAndWorkspaceId(userId, workspaceId)
        val updated =
            if (presence != null) {
                presenceRepository.save(presence.copy(isOnline = false, lastSeenAt = Instant.now()))
            } else {
                presenceRepository.save(
                    WorkspaceChatPresence(
                        userId = userId,
                        workspaceId = workspaceId,
                        isOnline = false,
                        lastSeenAt = Instant.now()
                    )
                )
            }
        return enrichPresenceUpdate(updated)
    }

    fun setAllOffline(userId: UUID) {
        presenceRepository.setAllOffline(userId)
    }

    @Transactional(readOnly = true)
    fun getPresenceRecordsForUser(userId: UUID): List<WorkspaceChatPresence> = presenceRepository.findByUserId(userId).filter { it.isOnline }

    fun heartbeat(
        userId: UUID,
        workspaceId: UUID
    ) {
        val presence = presenceRepository.findByUserIdAndWorkspaceId(userId, workspaceId)
        if (presence != null) {
            presenceRepository.save(presence.copy(isOnline = true, lastSeenAt = Instant.now()))
        } else {
            presenceRepository.save(
                WorkspaceChatPresence(
                    userId = userId,
                    workspaceId = workspaceId,
                    isOnline = true,
                    lastSeenAt = Instant.now()
                )
            )
        }
    }

    @Transactional(readOnly = true)
    fun getOnlineUsers(workspaceId: UUID): List<WorkspaceChatPresenceResponse> =
        presenceRepository
            .findByWorkspaceIdAndIsOnlineTrue(workspaceId)
            .map { enrichPresence(it) }

    @Transactional(readOnly = true)
    fun getWorkspaceMembersWithPresence(workspaceId: UUID): List<WorkspaceChatPresenceResponse> {
        val members = workspaceUserRepository.findByWorkspaceId(workspaceId)
        return members.map { wu ->
            val presence = presenceRepository.findByUserIdAndWorkspaceId(wu.userId, workspaceId)
            val user = userRepository.findById(wu.userId).orElse(null)
            WorkspaceChatPresenceResponse(
                userId = wu.userId,
                username = user?.username,
                firstName = user?.firstName,
                lastName = user?.lastName,
                profilePicture = user?.profilePicture,
                isOnline = presence?.isOnline ?: false,
                lastSeenAt = presence?.lastSeenAt ?: wu.createdAt
            )
        }
    }

    @Scheduled(fixedRate = 60_000)
    @Transactional
    fun cleanupStalePresence() {
        val threshold = Instant.now().minus(STALE_PRESENCE_MINUTES, ChronoUnit.MINUTES)
        presenceRepository.cleanupStalePresence(threshold)
    }

    private fun enrichMessage(message: WorkspaceChatMessage): WorkspaceChatMessageResponse {
        val user = userRepository.findById(message.senderId).orElse(null)
        return WorkspaceChatMessageResponse(
            id = requireNotNull(message.id) { "Message must have an ID" },
            workspaceId = message.workspaceId,
            senderId = message.senderId,
            senderUsername = user?.username,
            senderFirstName = user?.firstName,
            senderLastName = user?.lastName,
            senderProfilePicture = user?.profilePicture,
            content = message.content,
            createdAt = message.createdAt
        )
    }

    private fun enrichPresence(presence: WorkspaceChatPresence): WorkspaceChatPresenceResponse {
        val user = userRepository.findById(presence.userId).orElse(null)
        return WorkspaceChatPresenceResponse(
            userId = presence.userId,
            username = user?.username,
            firstName = user?.firstName,
            lastName = user?.lastName,
            profilePicture = user?.profilePicture,
            isOnline = presence.isOnline,
            lastSeenAt = presence.lastSeenAt
        )
    }

    private fun enrichPresenceUpdate(presence: WorkspaceChatPresence): WorkspaceChatPresenceUpdate {
        val user = userRepository.findById(presence.userId).orElse(null)
        return WorkspaceChatPresenceUpdate(
            userId = presence.userId,
            workspaceId = presence.workspaceId,
            username = user?.username,
            firstName = user?.firstName,
            lastName = user?.lastName,
            profilePicture = user?.profilePicture,
            isOnline = presence.isOnline,
            lastSeenAt = presence.lastSeenAt
        )
    }
}
