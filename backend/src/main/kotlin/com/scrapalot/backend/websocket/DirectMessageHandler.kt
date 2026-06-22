package com.scrapalot.backend.websocket

import com.scrapalot.backend.dto.DirectMessageRequest
import com.scrapalot.backend.service.DirectMessageService
import com.scrapalot.backend.service.UserService
import mu.KotlinLogging
import org.springframework.messaging.handler.annotation.MessageMapping
import org.springframework.messaging.handler.annotation.Payload
import org.springframework.messaging.simp.SimpMessageHeaderAccessor
import org.springframework.messaging.simp.SimpMessagingTemplate
import org.springframework.stereotype.Controller
import java.util.UUID

private val logger = KotlinLogging.logger {}

@Controller
class DirectMessageHandler(
    private val messagingTemplate: SimpMessagingTemplate,
    private val directMessageService: DirectMessageService,
    private val userService: UserService
) {
    @MessageMapping("/dm.send")
    fun handleSendMessage(
        @Payload request: DirectMessageRequest,
        headerAccessor: SimpMessageHeaderAccessor
    ) {
        val senderId = extractUserId(headerAccessor) ?: return

        if (!directMessageService.canUseDirectMessages(senderId)) {
            logger.warn { "User $senderId attempted DM without subscription" }
            return
        }

        if (request.content.isBlank() || request.content.length > DirectMessageService.MAX_CONTENT_LENGTH) {
            logger.warn { "Invalid DM content from user $senderId" }
            return
        }

        if (!directMessageService.areWorkspaceMembers(request.workspaceId, senderId, request.recipientId)) {
            logger.warn { "Users $senderId and ${request.recipientId} are not in the same workspace ${request.workspaceId}" }
            return
        }

        val conversation =
            directMessageService.getOrCreateConversation(
                senderId,
                request.recipientId,
                request.workspaceId
            )
        val conversationId = requireNotNull(conversation.id)

        val message = directMessageService.sendMessage(conversationId, senderId, request.content)

        // Send it to recipient's personal queue
        messagingTemplate.convertAndSendToUser(
            request.recipientId.toString(),
            "/queue/dm",
            mapOf(
                "type" to "message",
                "conversation_id" to conversationId.toString(),
                "message" to message
            )
        )

        // Send confirmation back to sender
        messagingTemplate.convertAndSendToUser(
            senderId.toString(),
            "/queue/dm",
            mapOf(
                "type" to "message",
                "conversation_id" to conversationId.toString(),
                "message" to message
            )
        )
    }

    @MessageMapping("/dm.typing")
    fun handleTyping(
        @Payload payload: Map<String, String>,
        headerAccessor: SimpMessageHeaderAccessor
    ) {
        val userId = extractUserId(headerAccessor) ?: return
        val conversationId = UUID.fromString(payload["conversation_id"] ?: return)
        val isTyping = payload["is_typing"]?.toBooleanStrictOrNull() ?: false

        if (!directMessageService.isParticipant(conversationId, userId)) return

        val recipientId = directMessageService.getOtherParticipant(conversationId, userId) ?: return
        val user = userService.findById(userId)

        messagingTemplate.convertAndSendToUser(
            recipientId.toString(),
            "/queue/dm",
            mapOf(
                "type" to "typing",
                "conversation_id" to conversationId.toString(),
                "user_id" to userId.toString(),
                "username" to (user?.username ?: "Unknown"),
                "is_typing" to isTyping
            )
        )
    }

    @MessageMapping("/dm.read")
    fun handleRead(
        @Payload payload: Map<String, String>,
        headerAccessor: SimpMessageHeaderAccessor
    ) {
        val userId = extractUserId(headerAccessor) ?: return
        val conversationId = UUID.fromString(payload["conversation_id"] ?: return)

        if (!directMessageService.isParticipant(conversationId, userId)) return

        directMessageService.markAsRead(conversationId, userId)

        val recipientId = directMessageService.getOtherParticipant(conversationId, userId) ?: return

        messagingTemplate.convertAndSendToUser(
            recipientId.toString(),
            "/queue/dm",
            mapOf(
                "type" to "read",
                "conversation_id" to conversationId.toString(),
                "user_id" to userId.toString()
            )
        )
    }

    private fun extractUserId(headerAccessor: SimpMessageHeaderAccessor): UUID? = headerAccessor.extractUserId()
}
