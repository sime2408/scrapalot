package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.workspace.Workspace
import org.springframework.data.domain.Page
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.UUID

@Suppress("unused")
@Repository
interface WorkspaceRepository : JpaRepository<Workspace, UUID> {
    fun findByUserId(userId: UUID): List<Workspace>

    fun findByUserIdOrderByCreatedAtDesc(userId: UUID): List<Workspace>

    fun findByUserIdOrderByCreatedAtDesc(
        userId: UUID,
        pageable: Pageable
    ): Page<Workspace>

    @Query(
        """
        SELECT w FROM Workspace w
        WHERE w.userId = :userId
        ORDER BY w.createdAt ASC
    """
    )
    fun findOldestByUserId(
        @Param("userId") userId: UUID,
        pageable: Pageable
    ): List<Workspace>

    @Query(
        """
        SELECT DISTINCT w FROM Workspace w
        LEFT JOIN WorkspaceUser wu ON w.id = wu.workspaceId
        WHERE w.userId = :userId OR wu.userId = :userId
        ORDER BY w.createdAt DESC
    """
    )
    fun findAllAccessibleWorkspaces(
        @Param("userId") userId: UUID
    ): List<Workspace>

    fun existsByIdAndUserId(
        id: UUID,
        userId: UUID
    ): Boolean

    fun findBySlugAndUserId(
        slug: String,
        userId: UUID
    ): Workspace?

    fun existsBySlugAndUserId(
        slug: String,
        userId: UUID
    ): Boolean
}
