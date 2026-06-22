package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.profile.AgentProfile
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.UUID

@Repository
interface AgentProfileRepository : JpaRepository<AgentProfile, UUID> {
    /** Visible to a user in a given workspace: all system profiles +
     *  workspace-owned profiles for that workspace. */
    @Query(
        """
            SELECT p FROM AgentProfile p
            WHERE p.isSystem = TRUE
               OR p.workspaceId = :workspaceId
            ORDER BY p.isSystem DESC, p.name ASC
        """,
    )
    fun findVisibleForWorkspace(
        @Param("workspaceId") workspaceId: UUID?
    ): List<AgentProfile>

    /** Lookup by slug for the layered system-prompt builder.
     *  Prefers workspace-owned override over system profile when both exist. */
    @Query(
        """
            SELECT p FROM AgentProfile p
            WHERE p.slug = :slug
              AND (p.isSystem = TRUE OR p.workspaceId = :workspaceId)
            ORDER BY p.isSystem ASC
        """,
    )
    fun findBySlug(
        @Param("slug") slug: String,
        @Param("workspaceId") workspaceId: UUID?
    ): List<AgentProfile>

    fun findAllByIsSystemTrue(): List<AgentProfile>
}
