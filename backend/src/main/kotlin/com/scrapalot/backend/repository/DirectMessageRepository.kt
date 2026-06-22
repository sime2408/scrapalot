package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.chat.DirectMessage
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.stereotype.Repository
import java.time.Instant
import java.util.UUID

@Repository
interface DirectMessageRepository : JpaRepository<DirectMessage, UUID> {
    fun findByConversationIdOrderByCreatedAtDesc(
        conversationId: UUID,
        pageable: Pageable
    ): List<DirectMessage>

    @Query(
        """
        SELECT COUNT(m) FROM DirectMessage m
        WHERE m.conversationId = :conversationId
          AND m.senderId != :userId
          AND m.readAt IS NULL
        """
    )
    fun countUnreadByConversation(
        conversationId: UUID,
        userId: UUID
    ): Long

    @Modifying
    @Query(
        """
        UPDATE DirectMessage m SET m.readAt = :now
        WHERE m.conversationId = :conversationId
          AND m.senderId != :userId
          AND m.readAt IS NULL
        """
    )
    fun markAllRead(
        conversationId: UUID,
        userId: UUID,
        now: Instant = Instant.now()
    )

    fun countByConversationId(conversationId: UUID): Long

    @Query(
        """
        SELECT m.id FROM DirectMessage m
        WHERE m.conversationId = :conversationId
        ORDER BY m.createdAt ASC
        """
    )
    fun findOldestMessageIds(
        conversationId: UUID,
        pageable: Pageable
    ): List<UUID>
}
