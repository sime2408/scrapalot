package com.scrapalot.backend.websocket

import com.scrapalot.backend.service.WorkspaceChatService
import mu.KotlinLogging
import org.springframework.context.event.EventListener
import org.springframework.messaging.simp.SimpMessagingTemplate
import org.springframework.messaging.simp.stomp.StompHeaderAccessor
import org.springframework.stereotype.Component
import org.springframework.web.socket.messaging.SessionConnectedEvent
import org.springframework.web.socket.messaging.SessionDisconnectEvent
import org.springframework.web.socket.messaging.SessionSubscribeEvent
import org.springframework.web.socket.messaging.SessionUnsubscribeEvent
import java.util.UUID

private val logger = KotlinLogging.logger {}

@Component
class WebSocketEventListener(
    private val workspaceChatService: WorkspaceChatService,
    private val messagingTemplate: SimpMessagingTemplate
) {
    @EventListener
    fun handleWebSocketConnectListener(event: SessionConnectedEvent) {
        val headerAccessor = StompHeaderAccessor.wrap(event.message)
        val sessionId = headerAccessor.sessionId
        logger.info { "WebSocket connected: sessionId=$sessionId" }
    }

    @EventListener
    fun handleWebSocketDisconnectListener(event: SessionDisconnectEvent) {
        val headerAccessor = StompHeaderAccessor.wrap(event.message)
        val sessionId = headerAccessor.sessionId
        val userId = headerAccessor.sessionAttributes?.get("userId") as? String

        if (userId != null) {
            try {
                val uuid = UUID.fromString(userId)
                val presenceRecords = workspaceChatService.getPresenceRecordsForUser(uuid)
                workspaceChatService.setAllOffline(uuid)

                presenceRecords.forEach { presence ->
                    messagingTemplate.convertAndSend(
                        "/topic/workspace.${presence.workspaceId}.chat.presence",
                        mapOf(
                            "userId" to userId,
                            "workspaceId" to presence.workspaceId.toString(),
                            "isOnline" to false,
                            "lastSeenAt" to
                                java.time.Instant
                                    .now()
                                    .toString()
                        )
                    )
                }
                logger.info { "WebSocket disconnected: sessionId=$sessionId, userId=$userId — set offline in all workspaces" }
            } catch (e: Exception) {
                logger.error(e) { "Failed to update presence on disconnect for user $userId" }
            }
        } else {
            logger.info { "WebSocket disconnected: sessionId=$sessionId" }
        }
    }

    @EventListener
    fun handleWebSocketSubscribeListener(event: SessionSubscribeEvent) {
        val headerAccessor = StompHeaderAccessor.wrap(event.message)
        val sessionId = headerAccessor.sessionId
        val destination = headerAccessor.destination
        logger.debug { "WebSocket subscribed: sessionId=$sessionId, destination=$destination" }
    }

    @EventListener
    fun handleWebSocketUnsubscribeListener(event: SessionUnsubscribeEvent) {
        val headerAccessor = StompHeaderAccessor.wrap(event.message)
        val sessionId = headerAccessor.sessionId
        logger.debug { "WebSocket unsubscribed: sessionId=$sessionId" }
    }
}
