package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.workspace.WorkspaceChatMessage
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.time.Instant
import java.util.UUID

@Suppress("unused")
@Repository
interface WorkspaceChatMessageRepository : JpaRepository<WorkspaceChatMessage, UUID> {
    fun findByWorkspaceIdOrderByCreatedAtDesc(
        workspaceId: UUID,
        pageable: Pageable
    ): List<WorkspaceChatMessage>

    fun findByWorkspaceIdAndCreatedAtAfterOrderByCreatedAtAsc(
        workspaceId: UUID,
        after: Instant
    ): List<WorkspaceChatMessage>

    fun countByWorkspaceId(workspaceId: UUID): Long

    fun findByIdAndWorkspaceId(
        id: UUID,
        workspaceId: UUID
    ): WorkspaceChatMessage?

    @Query("select m.id from WorkspaceChatMessage m where m.workspaceId = :workspaceId")
    fun findIdsByWorkspaceId(
        @Param("workspaceId") workspaceId: UUID
    ): List<UUID>

    @Query("select m.id from WorkspaceChatMessage m where m.workspaceId = :workspaceId and m.createdAt >= :createdAt")
    fun findIdsByWorkspaceIdAndCreatedAtFrom(
        @Param("workspaceId") workspaceId: UUID,
        @Param("createdAt") createdAt: Instant
    ): List<UUID>
}
