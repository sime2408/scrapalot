package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.notes.NoteTemplate
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.UUID

@Repository
interface NoteTemplateRepository : JpaRepository<NoteTemplate, UUID> {
    /**
     * Templates visible to a user inside a workspace:
     *   - owned by the user AND (workspace_id is null OR matches the request)
     * null workspaceId means "any workspace" — caller should pass null for
     * the cross-workspace browser if ever needed.
     */
    @Query(
        """
        SELECT t FROM NoteTemplate t
        WHERE t.userId = :userId
          AND (t.workspaceId IS NULL OR t.workspaceId = :workspaceId)
        ORDER BY t.updatedAt DESC
        """,
    )
    fun findVisibleToUser(
        @Param("userId") userId: UUID,
        @Param("workspaceId") workspaceId: UUID,
    ): List<NoteTemplate>

    fun findByUserIdOrderByUpdatedAtDesc(userId: UUID): List<NoteTemplate>
}
