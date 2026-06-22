package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.chat.Message
import org.springframework.data.domain.Page
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.Optional
import java.util.UUID

/**
 * Repository for Message entity
 * Provides database operations for chat messages
 */
@Suppress("unused")
@Repository
interface MessageRepository : JpaRepository<Message, UUID> {
    /**
     * Find all messages for a specific session with pagination
     */
    fun findBySessionIdOrderByCreatedAtAsc(
        sessionId: UUID,
        pageable: Pageable
    ): Page<Message>

    /**
     * Find messages newest-first with pagination. Used by the chat UI's
     * infinite-scroll history: page 0 is the most recent window, higher pages
     * reach further back. The service reverses each window back to chronological
     * order before returning so the client can prepend older pages as-is.
     */
    fun findBySessionIdOrderByCreatedAtDesc(
        sessionId: UUID,
        pageable: Pageable
    ): Page<Message>

    /**
     * Find all messages for a session (no pagination, for retrieval)
     */
    fun findBySessionIdOrderByCreatedAtAsc(sessionId: UUID): List<Message>

    /**
     * Count messages in a session
     */
    fun countBySessionId(sessionId: UUID): Long

    /**
     * Find messages by content search
     */
    @Query("SELECT m FROM Message m WHERE m.sessionId = :sessionId AND LOWER(m.content) LIKE LOWER(CONCAT('%', :query, '%')) ORDER BY m.createdAt ASC")
    fun searchBySessionIdAndContent(
        @Param("sessionId") sessionId: UUID,
        @Param("query") query: String,
        pageable: Pageable
    ): Page<Message>

    /**
     * Find the latest message in a session
     */
    fun findFirstBySessionIdOrderByCreatedAtDesc(sessionId: UUID): Optional<Message>

    /**
     * Find messages by role
     */
    fun findBySessionIdAndRoleOrderByCreatedAtAsc(
        sessionId: UUID,
        role: String,
        pageable: Pageable
    ): Page<Message>

    /**
     * Delete all messages for a session
     */
    fun deleteBySessionId(sessionId: UUID)

    /**
     * Check if a message exists in session
     */
    fun existsByIdAndSessionId(
        id: UUID,
        sessionId: UUID
    ): Boolean

    /**
     * Update feedback (binary + optional fine-grained detail) on a message
     */
    @Query("UPDATE Message m SET m.feedback = :feedback, m.feedbackDetail = :feedbackDetail WHERE m.id = :id")
    @org.springframework.data.jpa.repository.Modifying
    @org.springframework.transaction.annotation.Transactional
    fun updateFeedback(
        @Param("id") id: UUID,
        @Param("feedback") feedback: Short?,
        @Param("feedbackDetail") feedbackDetail: Short?
    )
}
