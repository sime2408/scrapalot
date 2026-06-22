package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.chat.Session
import org.springframework.data.domain.Page
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.Optional
import java.util.UUID

/**
 * Repository for Session entity
 * Provides database operations for chat sessions
 */
@Suppress("unused")
@Repository
interface SessionRepository : JpaRepository<Session, UUID> {
    /**
     * Find all sessions for a specific user with pagination
     */
    fun findByUserIdOrderByUpdatedAtDesc(
        userId: UUID,
        pageable: Pageable
    ): Page<Session>

    /**
     * Find all sessions for a user and collection
     */
    fun findByUserIdAndCollectionIdOrderByUpdatedAtDesc(
        userId: UUID,
        collectionId: UUID,
        pageable: Pageable
    ): Page<Session>

    /**
     * Find a session by ID and user ID (for access control)
     */
    fun findByIdAndUserId(
        id: UUID,
        userId: UUID
    ): Optional<Session>

    /**
     * Count sessions for a user
     */
    fun countByUserId(userId: UUID): Long

    /**
     * Count sessions for a user and collection
     */
    fun countByUserIdAndCollectionId(
        userId: UUID,
        collectionId: UUID
    ): Long

    /**
     * Find sessions by user ID and name pattern
     */
    @Query("SELECT s FROM Session s WHERE s.userId = :userId AND LOWER(s.conversationName) LIKE LOWER(CONCAT('%', :query, '%')) ORDER BY s.updatedAt DESC")
    fun searchByUserIdAndName(
        @Param("userId") userId: UUID,
        @Param("query") query: String,
        pageable: Pageable
    ): Page<Session>

    /**
     * Find a session by the exact conversation name for a user
     */
    fun findByUserIdAndConversationName(
        userId: UUID,
        conversationName: String
    ): Session?

    /**
     * Find the first session for a user and collection (most recently updated)
     */
    fun findFirstByUserIdAndCollectionIdOrderByUpdatedAtDesc(
        userId: UUID,
        collectionId: UUID
    ): Session?

    /**
     * Delete all sessions for a user
     */
    fun deleteByUserId(userId: UUID)

    /**
     * Delete sessions by user and collection
     */
    fun deleteByUserIdAndCollectionId(
        userId: UUID,
        collectionId: UUID
    )

    /**
     * Check if a session exists and belongs to a user
     */
    fun existsByIdAndUserId(
        id: UUID,
        userId: UUID
    ): Boolean

    /**
     * Find sessions for a user in a specific folder
     */
    fun findByUserIdAndSessionFolderIdOrderByUpdatedAtDesc(
        userId: UUID,
        sessionFolderId: UUID,
        pageable: Pageable
    ): Page<Session>

    /**
     * Find unfiled sessions (no folder assigned)
     */
    fun findByUserIdAndSessionFolderIdIsNullOrderByUpdatedAtDesc(
        userId: UUID,
        pageable: Pageable
    ): Page<Session>

    /**
     * Count sessions in a specific folder
     */
    fun countByUserIdAndSessionFolderId(
        userId: UUID,
        sessionFolderId: UUID
    ): Long

    /**
     * Clear folder references when a folder is deleted
     */
    @Modifying
    @Query("UPDATE Session s SET s.sessionFolderId = NULL WHERE s.sessionFolderId = :folderId")
    fun clearFolderReferences(
        @Param("folderId") folderId: UUID
    )
}
