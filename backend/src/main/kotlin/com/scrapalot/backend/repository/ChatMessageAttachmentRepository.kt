package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.chat.ChatMessageAttachment
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.time.LocalDateTime
import java.util.UUID

/**
 * Persistence layer for [ChatMessageAttachment]. Read-side is consumed by the
 * Python AI backend over gRPC (Python is the message reader, Kotlin is the
 * SOT for chat history). Write-side is driven by the Python image / audio
 * orchestrators which call back over gRPC after persisting the artifact bytes.
 */
@Suppress("unused")
@Repository
interface ChatMessageAttachmentRepository : JpaRepository<ChatMessageAttachment, UUID> {
    fun findByMessageIdOrderByCreatedAtAsc(messageId: UUID): List<ChatMessageAttachment>

    fun findByKindAndCreatedAtBefore(
        kind: String,
        cutoff: LocalDateTime
    ): List<ChatMessageAttachment>

    @Query(
        """
        SELECT a FROM ChatMessageAttachment a
        WHERE a.messageId IN :messageIds
        ORDER BY a.createdAt ASC
        """
    )
    fun findAllByMessageIds(
        @Param("messageIds") messageIds: Collection<UUID>
    ): List<ChatMessageAttachment>
}
