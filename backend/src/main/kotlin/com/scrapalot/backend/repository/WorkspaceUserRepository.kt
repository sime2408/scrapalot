package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.workspace.WorkspaceUser
import com.scrapalot.backend.domain.workspace.WorkspaceUserId
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.UUID

@Suppress("unused")
@Repository
interface WorkspaceUserRepository : JpaRepository<WorkspaceUser, WorkspaceUserId> {
    fun findByWorkspaceId(workspaceId: UUID): List<WorkspaceUser>

    fun findByUserId(userId: UUID): List<WorkspaceUser>

    fun findByWorkspaceIdAndUserId(
        workspaceId: UUID,
        userId: UUID
    ): WorkspaceUser?

    fun existsByWorkspaceIdAndUserId(
        workspaceId: UUID,
        userId: UUID
    ): Boolean

    fun deleteByWorkspaceIdAndUserId(
        workspaceId: UUID,
        userId: UUID
    ): Int

    @Query("SELECT COUNT(wu) FROM WorkspaceUser wu WHERE wu.workspaceId = :workspaceId")
    fun countByWorkspaceId(
        @Param("workspaceId") workspaceId: UUID
    ): Long

    @Query("SELECT wu.permission FROM WorkspaceUser wu WHERE wu.workspaceId = :workspaceId AND wu.userId = :userId")
    fun findPermissionByWorkspaceIdAndUserId(
        @Param("workspaceId") workspaceId: UUID,
        @Param("userId") userId: UUID
    ): String?
}
