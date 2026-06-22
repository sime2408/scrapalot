package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.notes.Note
import org.springframework.data.domain.Page
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.UUID

@Suppress("unused")
@Repository
interface NoteRepository : JpaRepository<Note, UUID> {
    fun findByWorkspaceId(workspaceId: UUID): List<Note>

    fun findByWorkspaceIdOrderByUpdatedAtDesc(workspaceId: UUID): List<Note>

    fun findByWorkspaceIdOrderByUpdatedAtDesc(
        workspaceId: UUID,
        pageable: Pageable
    ): Page<Note>

    fun findByUserId(userId: UUID): List<Note>

    fun findByWorkspaceIdAndUserId(
        workspaceId: UUID,
        userId: UUID
    ): List<Note>

    fun findBySessionId(sessionId: UUID): List<Note>

    fun deleteBySessionId(sessionId: UUID)

    fun findByIsPinnedTrueAndWorkspaceId(workspaceId: UUID): List<Note>

    @Query(
        """
        SELECT n FROM Note n
        WHERE n.workspaceId = :workspaceId
        AND (n.userId = :userId OR n.isPublic = true OR EXISTS (
            SELECT 1 FROM NoteShare ns WHERE ns.noteId = n.id AND ns.userId = :userId
        ))
        ORDER BY n.updatedAt DESC
    """
    )
    fun findAccessibleNotes(
        @Param("workspaceId") workspaceId: UUID,
        @Param("userId") userId: UUID
    ): List<Note>

    @Query(
        """
        SELECT n FROM Note n
        WHERE n.workspaceId = :workspaceId
        AND LOWER(n.title) LIKE LOWER(CONCAT('%', :query, '%'))
        ORDER BY n.updatedAt DESC
    """
    )
    fun searchByTitle(
        @Param("workspaceId") workspaceId: UUID,
        @Param("query") query: String
    ): List<Note>

    // Notes linked to a document
    fun findByDocumentIdAndUserId(
        documentId: String,
        userId: UUID
    ): List<Note>

    // Category-scoped paginated accessible notes for the Datoteka → Otvori dialog.
    // category=null + matchUncategorized=true → rows where n.category IS NULL
    // category=null + matchUncategorized=false → all categories (no filter)
    // category=<value>                         → exact match
    // q=null / blank                            → no title filter; otherwise substring
    @Query(
        """
        SELECT n FROM Note n
        WHERE n.workspaceId = :workspaceId
        AND (n.userId = :userId OR n.isPublic = true OR EXISTS (
            SELECT 1 FROM NoteShare ns WHERE ns.noteId = n.id AND ns.userId = :userId
        ))
        AND (
            (:matchUncategorized = true AND n.category IS NULL)
            OR (:matchUncategorized = false AND (:category IS NULL OR n.category = :category))
        )
        AND (:q IS NULL OR :q = '' OR LOWER(n.title) LIKE LOWER(CONCAT('%', :q, '%')))
        ORDER BY n.updatedAt DESC
    """
    )
    fun findAccessibleNotesByCategory(
        @Param("workspaceId") workspaceId: UUID,
        @Param("userId") userId: UUID,
        @Param("category") category: String?,
        @Param("matchUncategorized") matchUncategorized: Boolean,
        @Param("q") q: String?,
        pageable: Pageable
    ): Page<Note>
}
