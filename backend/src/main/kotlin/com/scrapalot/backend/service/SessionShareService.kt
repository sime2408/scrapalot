package com.scrapalot.backend.service

import com.scrapalot.backend.domain.chat.SessionShare
import com.scrapalot.backend.dto.CreateSessionShareRequest
import com.scrapalot.backend.dto.SessionShareDTO
import com.scrapalot.backend.dto.SharedConversationDTO
import com.scrapalot.backend.dto.SharedMessageDTO
import com.scrapalot.backend.exception.NotFoundException
import com.scrapalot.backend.repository.MessageRepository
import com.scrapalot.backend.repository.SessionRepository
import com.scrapalot.backend.repository.SessionShareRepository
import org.slf4j.LoggerFactory
import org.springframework.data.domain.PageRequest
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.UUID

@Service
class SessionShareService(
    private val sessionShareRepository: SessionShareRepository,
    private val sessionRepository: SessionRepository,
    private val messageRepository: MessageRepository
) {
    private val logger = LoggerFactory.getLogger(SessionShareService::class.java)

    @Transactional
    fun createShare(
        sessionId: UUID,
        userId: UUID,
        request: CreateSessionShareRequest
    ): SessionShareDTO {
        // Verify session exists AND belongs to user (returns 404 for non-owners to prevent ID enumeration)
        sessionRepository
            .findByIdAndUserId(sessionId, userId)
            .orElseThrow { NotFoundException("Session not found") }

        // Return existing active share if one exists (idempotent)
        sessionShareRepository
            .findBySessionIdAndUserIdAndRevokedAtIsNull(sessionId, userId)
            ?.let { return it.toDTO() }

        val messageCount = messageRepository.countBySessionId(sessionId).toInt()
        if (messageCount == 0) {
            throw IllegalArgumentException("Cannot share an empty conversation")
        }

        val share =
            SessionShare(
                sessionId = sessionId,
                userId = userId,
                messageSnapshotCount = messageCount,
                expiresAt = request.expiresAt
            )

        val saved = sessionShareRepository.save(share)
        logger.info("Created share for session {} with token {}", sessionId, saved.shareToken.take(8))
        return saved.toDTO()
    }

    @Transactional
    fun revokeShare(
        sessionId: UUID,
        userId: UUID
    ) {
        val share =
            sessionShareRepository.findBySessionIdAndUserIdAndRevokedAtIsNull(sessionId, userId)
                ?: throw NotFoundException("No active share found for this session")

        share.revokedAt = Instant.now()
        sessionShareRepository.save(share)
        logger.info("Revoked share for session {}", sessionId)
    }

    @Transactional(readOnly = true)
    fun getShareForSession(
        sessionId: UUID,
        userId: UUID
    ): SessionShareDTO? {
        // Verify ownership
        if (!sessionRepository.existsByIdAndUserId(sessionId, userId)) {
            throw NotFoundException("Session not found")
        }
        return sessionShareRepository.findBySessionIdAndUserIdAndRevokedAtIsNull(sessionId, userId)?.toDTO()
    }

    @Transactional(readOnly = true)
    fun getSharedConversation(shareToken: String): SharedConversationDTO {
        val share =
            sessionShareRepository.findByShareTokenAndRevokedAtIsNull(shareToken)
                ?: throw NotFoundException("Shared conversation not found")

        // Check expiry
        share.expiresAt?.let { expiry ->
            if (Instant.now().isAfter(expiry)) {
                throw NotFoundException("This shared conversation has expired")
            }
        }

        val session =
            sessionRepository
                .findById(share.sessionId)
                .orElseThrow { NotFoundException("Shared conversation not found") }

        val messages =
            messageRepository.findBySessionIdOrderByCreatedAtAsc(
                share.sessionId,
                PageRequest.of(0, share.messageSnapshotCount)
            )

        return SharedConversationDTO(
            conversationName = session.conversationName,
            sharedAt = share.createdAt,
            messages =
                messages.content.map { msg ->
                    SharedMessageDTO(
                        role = msg.role,
                        content = msg.content,
                        createdAt = msg.createdAt
                    )
                }
        )
    }

    private fun SessionShare.toDTO() =
        SessionShareDTO(
            id = id ?: throw IllegalStateException("Share ID is null"),
            sessionId = sessionId,
            shareToken = shareToken,
            messageSnapshotCount = messageSnapshotCount,
            createdAt = createdAt,
            expiresAt = expiresAt,
            shareUrl = "/shared/$shareToken"
        )
}
