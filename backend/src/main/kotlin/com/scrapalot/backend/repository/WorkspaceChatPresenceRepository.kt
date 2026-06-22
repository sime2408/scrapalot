package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.workspace.WorkspaceChatPresence
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.time.Instant
import java.util.UUID

@Repository
interface WorkspaceChatPresenceRepository : JpaRepository<WorkspaceChatPresence, UUID> {
    fun findByWorkspaceIdAndIsOnlineTrue(workspaceId: UUID): List<WorkspaceChatPresence>

    fun findByUserIdAndWorkspaceId(
        userId: UUID,
        workspaceId: UUID
    ): WorkspaceChatPresence?

    fun findByUserId(userId: UUID): List<WorkspaceChatPresence>

    @Modifying
    @Query("UPDATE WorkspaceChatPresence p SET p.isOnline = false, p.lastSeenAt = :now WHERE p.userId = :userId")
    fun setAllOffline(
        @Param("userId") userId: UUID,
        @Param("now") now: Instant = Instant.now()
    )

    @Modifying
    @Query("UPDATE WorkspaceChatPresence p SET p.isOnline = false, p.lastSeenAt = :now WHERE p.isOnline = true AND p.lastSeenAt < :staleThreshold")
    fun cleanupStalePresence(
        @Param("staleThreshold") staleThreshold: Instant,
        @Param("now") now: Instant = Instant.now()
    )
}
