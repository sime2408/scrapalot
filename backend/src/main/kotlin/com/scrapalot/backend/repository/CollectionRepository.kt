package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.collection.Collection
import org.springframework.data.domain.Page
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.UUID

@Suppress("unused")
@Repository
interface CollectionRepository : JpaRepository<Collection, UUID> {
    fun findByWorkspaceId(workspaceId: UUID): List<Collection>

    fun findByWorkspaceIdOrderByCreatedAtDesc(workspaceId: UUID): List<Collection>

    fun findByWorkspaceIdOrderByCreatedAtDesc(
        workspaceId: UUID,
        pageable: Pageable
    ): Page<Collection>

    // Paginated version that respects Pageable sort
    fun findByWorkspaceId(
        workspaceId: UUID,
        pageable: Pageable
    ): Page<Collection>

    fun existsByIdAndWorkspaceId(
        id: UUID,
        workspaceId: UUID
    ): Boolean

    fun countByWorkspaceId(workspaceId: UUID): Long

    @Query(
        """
        SELECT c FROM Collection c
        WHERE c.workspaceId IN :workspaceIds
        ORDER BY c.createdAt DESC
    """
    )
    fun findByWorkspaceIdIn(
        @Param("workspaceIds") workspaceIds: List<UUID>
    ): List<Collection>

    // Paginated version that respects Pageable sort (no ORDER BY in query)
    @Query(
        """
        SELECT c FROM Collection c
        WHERE c.workspaceId IN :workspaceIds
    """
    )
    fun findByWorkspaceIdIn(
        @Param("workspaceIds") workspaceIds: List<UUID>,
        pageable: Pageable
    ): Page<Collection>

    // Nested collections
    fun findByParentCollectionId(parentCollectionId: UUID): List<Collection>

    fun findByParentCollectionIdIsNullAndWorkspaceId(workspaceId: UUID): List<Collection>

    @Query(
        value = """
        WITH RECURSIVE descendants AS (
            SELECT id FROM scrapalot.collections WHERE id = :parentId
            UNION ALL
            SELECT c.id FROM scrapalot.collections c
            JOIN descendants d ON c.parent_collection_id = d.id
            WHERE c.depth <= 3
        )
        SELECT id FROM descendants WHERE id != :parentId
    """,
        nativeQuery = true
    )
    fun findDescendantIds(
        @Param("parentId") parentId: UUID
    ): List<UUID>

    fun findBySlugAndWorkspaceId(
        slug: String,
        workspaceId: UUID
    ): Collection?

    fun existsBySlugAndWorkspaceId(
        slug: String,
        workspaceId: UUID
    ): Boolean
}
