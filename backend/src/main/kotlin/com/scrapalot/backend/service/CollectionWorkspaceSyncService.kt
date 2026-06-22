package com.scrapalot.backend.service

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.repository.CollectionRepository
import com.scrapalot.backend.repository.WorkspaceRepository
import mu.KotlinLogging
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Service

private val logger = KotlinLogging.logger {}

@Service
class CollectionWorkspaceSyncService(
    private val collectionRepository: CollectionRepository,
    private val workspaceRepository: WorkspaceRepository,
    private val stringRedisTemplate: StringRedisTemplate,
    private val objectMapper: ObjectMapper
) {
    companion object {
        const val SNAPSHOT_KEY = "scrapalot:sync:collection_workspace_snapshot"
    }

    // Rewrite the snapshot on boot so a schema-extended payload (e.g. the new
    // parent_collection_id + graph_tier fields) lands in Redis without waiting
    // for the next collection CRUD. Mirrors ConnectorSyncSnapshotService.onStartup.
    @EventListener(ApplicationReadyEvent::class)
    fun onStartup() = runCatching { refreshSnapshot() }

    fun refreshSnapshot() {
        try {
            val workspaces = workspaceRepository.findAll()
            val wsMap = workspaces.associateBy { it.id }
            val collections = collectionRepository.findAll()

            val snapshot =
                collections.map { c ->
                    val ws = wsMap[c.workspaceId]
                    mapOf(
                        "collection_id" to c.id.toString(),
                        "workspace_id" to c.workspaceId.toString(),
                        "owner_user_id" to (ws?.userId?.toString() ?: ""),
                        "collection_name" to c.name,
                        "workspace_name" to (ws?.name ?: ""),
                        "description" to (c.description ?: ""),
                        // parent + graph_tier so the Python replica can resolve the
                        // inherited graph tier on a cold start (walk parent chain).
                        "parent_collection_id" to (c.parentCollectionId?.toString() ?: ""),
                        "graph_tier" to (c.graphTier?.toString() ?: "")
                    )
                }

            stringRedisTemplate.opsForValue().set(SNAPSHOT_KEY, objectMapper.writeValueAsString(snapshot))
            logger.debug { "Refreshed collection_workspace snapshot with ${snapshot.size} entries" }
        } catch (e: Exception) {
            logger.error(e) { "Failed to refresh collection_workspace snapshot" }
        }
    }
}
