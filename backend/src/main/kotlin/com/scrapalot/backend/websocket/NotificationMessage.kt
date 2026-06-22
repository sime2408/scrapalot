package com.scrapalot.backend.websocket

import mu.KotlinLogging
import org.springframework.messaging.simp.SimpMessageHeaderAccessor
import java.time.Instant
import java.util.UUID

private val wsLogger = KotlinLogging.logger {}

/**
 * WebSocket notification message types
 */
enum class NotificationType {
    DOCUMENT_PROCESSING_STARTED,
    DOCUMENT_PROCESSING_PROGRESS,
    DOCUMENT_PROCESSING_COMPLETED,
    DOCUMENT_PROCESSING_FAILED,
    COLLECTION_UPDATED,
    WORKSPACE_UPDATED,
    NOTE_UPDATED,
    NOTE_SHARED,
    COMMENT_ADDED,
    SYSTEM_NOTIFICATION
}

/**
 * Generic WebSocket notification message
 */
data class NotificationMessage(
    val id: UUID = UUID.randomUUID(),
    val type: NotificationType,
    val title: String,
    val message: String,
    val data: Map<String, Any>? = null,
    val timestamp: Instant = Instant.now(),
    val userId: UUID? = null,
    val workspaceId: UUID? = null
)

/**
 * Document processing progress notification
 */
data class DocumentProcessingNotification(
    val documentId: UUID,
    val fileName: String,
    val status: String, // "processing", "completed", "failed"
    val progress: Int, // 0-100
    val message: String? = null,
    val error: String? = null
)

/**
 * Real-time update notification
 */
data class EntityUpdateNotification(
    val entityType: String, // "workspace", "collection", "document", "note"
    val entityId: UUID,
    val action: String, // "created", "updated", "deleted"
    val userId: UUID,
    val data: Map<String, Any>? = null
)

fun SimpMessageHeaderAccessor.extractUserId(): UUID? {
    val userId = (sessionAttributes ?: return null)["userId"] as? String ?: return null
    return try {
        UUID.fromString(userId)
    } catch (e: IllegalArgumentException) {
        wsLogger.error { "Invalid userId in WebSocket session: $userId" }
        null
    }
}
