package com.scrapalot.backend.controller.notes

import mu.KotlinLogging
import org.springframework.messaging.handler.annotation.DestinationVariable
import org.springframework.messaging.handler.annotation.MessageMapping
import org.springframework.messaging.handler.annotation.Payload
import org.springframework.messaging.handler.annotation.SendTo
import org.springframework.messaging.simp.SimpMessageHeaderAccessor
import org.springframework.stereotype.Controller
import java.util.UUID

private val logger = KotlinLogging.logger {}

/**
 * WebSocket controller for real-time note collaboration.
 *
 * STOMP message destinations:
 * - Client -> Server: /app/notes/{noteId}/update
 * - Server -> Client: /topic/notes/{noteId}
 *
 * Message format:
 * {
 *   "type": "yjs-update",
 *   "update": "base64-encoded-yjs-update",
 *   "userId": "uuid",
 *   "timestamp": 1234567890
 * }
 */
@Controller
class NoteCollaborationController {
    /**
     * Handle note update messages from clients.
     * Broadcasts Y.js updates to all connected collaborators.
     */
    @MessageMapping("/notes/{noteId}/update")
    @SendTo("/topic/notes/{noteId}")
    fun handleNoteUpdate(
        @DestinationVariable noteId: UUID,
        @Payload message: Map<String, Any>,
        headerAccessor: SimpMessageHeaderAccessor
    ): Map<String, Any> = enrichWithMetadata(message, headerAccessor, noteId, "Note update")

    @MessageMapping("/notes/{noteId}/cursor")
    @SendTo("/topic/notes/{noteId}/cursors")
    fun handleCursorUpdate(
        @DestinationVariable noteId: UUID,
        @Payload cursorData: Map<String, Any>,
        headerAccessor: SimpMessageHeaderAccessor
    ): Map<String, Any> = enrichWithMetadata(cursorData, headerAccessor, noteId, "Cursor update", includeServerTimestamp = false)

    @MessageMapping("/notes/{noteId}/awareness")
    @SendTo("/topic/notes/{noteId}/awareness")
    fun handleAwarenessUpdate(
        @DestinationVariable noteId: UUID,
        @Payload awarenessData: Map<String, Any>,
        headerAccessor: SimpMessageHeaderAccessor
    ): Map<String, Any> = enrichWithMetadata(awarenessData, headerAccessor, noteId, "Awareness update", includeServerTimestamp = false)

    private fun enrichWithMetadata(
        data: Map<String, Any>,
        headerAccessor: SimpMessageHeaderAccessor,
        noteId: UUID,
        logPrefix: String,
        includeServerTimestamp: Boolean = true
    ): Map<String, Any> {
        val userId = headerAccessor.sessionAttributes?.get("userId") as? String
        logger.debug { "$logPrefix: noteId=$noteId, userId=$userId" }

        return data.toMutableMap().apply {
            this["userId"] = userId ?: "unknown"
            this["timestamp"] = System.currentTimeMillis()
            if (includeServerTimestamp) {
                this["serverTimestamp"] = System.currentTimeMillis()
            }
        }
    }
}
