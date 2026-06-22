package com.scrapalot.backend.websocket

import mu.KotlinLogging
import org.springframework.messaging.simp.SimpMessagingTemplate
import org.springframework.stereotype.Service
import java.util.UUID

private val logger = KotlinLogging.logger {}

@Service
class NotificationService(
    private val messagingTemplate: SimpMessagingTemplate
) {
    /**
     * Send notification to a specific user
     */
    fun sendToUser(
        userId: UUID,
        notification: NotificationMessage
    ) {
        try {
            messagingTemplate.convertAndSendToUser(
                userId.toString(),
                "/queue/notifications",
                notification
            )
            logger.debug { "Sent notification to user $userId: ${notification.type}" }
        } catch (e: Exception) {
            logger.error(e) { "Failed to send notification to user $userId" }
        }
    }

    /**
     * Send notification to all users in a workspace
     */
    fun sendToWorkspace(
        workspaceId: UUID,
        notification: NotificationMessage
    ) {
        try {
            messagingTemplate.convertAndSend(
                "/topic/workspace/$workspaceId",
                notification
            )
            logger.debug { "Sent notification to workspace $workspaceId: ${notification.type}" }
        } catch (e: Exception) {
            logger.error(e) { "Failed to send notification to workspace $workspaceId" }
        }
    }

    /**
     * Broadcast notification to all connected users
     */
    fun broadcast(notification: NotificationMessage) {
        try {
            messagingTemplate.convertAndSend(
                "/topic/notifications",
                notification
            )
            logger.debug { "Broadcast notification: ${notification.type}" }
        } catch (e: Exception) {
            logger.error(e) { "Failed to broadcast notification" }
        }
    }

    /**
     * Send document processing progress update
     */
    fun sendDocumentProcessingUpdate(
        userId: UUID,
        documentId: UUID,
        fileName: String,
        status: String,
        progress: Int,
        message: String? = null,
        error: String? = null
    ) {
        val notification =
            DocumentProcessingNotification(
                documentId = documentId,
                fileName = fileName,
                status = status,
                progress = progress,
                message = message,
                error = error
            )

        try {
            messagingTemplate.convertAndSendToUser(
                userId.toString(),
                "/queue/document-processing",
                notification
            )
            logger.debug { "Sent document processing update to user $userId: $fileName ($progress%)" }
        } catch (e: Exception) {
            logger.error(e) { "Failed to send document processing update" }
        }
    }

    /**
     * Send entity update notification to workspace
     */
    fun sendEntityUpdate(
        workspaceId: UUID,
        entityType: String,
        entityId: UUID,
        action: String,
        userId: UUID,
        data: Map<String, Any>? = null
    ) {
        val notification =
            EntityUpdateNotification(
                entityType = entityType,
                entityId = entityId,
                action = action,
                userId = userId,
                data = data
            )

        try {
            messagingTemplate.convertAndSend(
                "/topic/workspace/$workspaceId/updates",
                notification
            )
            logger.debug { "Sent entity update to workspace $workspaceId: $entityType $action" }
        } catch (e: Exception) {
            logger.error(e) { "Failed to send entity update" }
        }
    }
}
