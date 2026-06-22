package com.scrapalot.backend.service

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.repository.WorkspaceUserRepository
import mu.KotlinLogging
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Service

private val logger = KotlinLogging.logger {}

/**
 * Publishes the full workspace-membership set to Redis so the Python AI service
 * can resolve "which workspaces is this user a member of?" without reaching into
 * the backend database directly.
 *
 * Mirrors [CollectionWorkspaceSyncService]: a single JSON snapshot key (Redis
 * DB 1) holding every (workspace_id, user_id, permission) row, refreshed on
 * boot and after every share / unshare. Membership changes are rare, so a
 * snapshot — rather than an incremental stream — keeps both sides in lockstep
 * with minimal moving parts.
 */
@Service
class WorkspaceMemberSyncService(
    private val workspaceUserRepository: WorkspaceUserRepository,
    private val stringRedisTemplate: StringRedisTemplate,
    private val objectMapper: ObjectMapper
) {
    companion object {
        const val SNAPSHOT_KEY = "scrapalot:sync:workspace_members_snapshot"
    }

    @EventListener(ApplicationReadyEvent::class)
    fun onStartup() = runCatching { refreshSnapshot() }

    fun refreshSnapshot() {
        try {
            val snapshot =
                workspaceUserRepository.findAll().map { wu ->
                    mapOf(
                        "workspace_id" to wu.workspaceId.toString(),
                        "user_id" to wu.userId.toString(),
                        "permission" to wu.permission
                    )
                }
            stringRedisTemplate.opsForValue().set(SNAPSHOT_KEY, objectMapper.writeValueAsString(snapshot))
            logger.debug { "Refreshed workspace_members snapshot with ${snapshot.size} entries" }
        } catch (e: Exception) {
            logger.error(e) { "Failed to refresh workspace_members snapshot" }
        }
    }
}
