package com.scrapalot.backend.websocket

import com.scrapalot.backend.dto.WorkspaceChatMessageRequest
import com.scrapalot.backend.dto.WorkspaceChatMessageResponse
import com.scrapalot.backend.dto.WorkspaceChatPresenceUpdate
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.service.WorkspaceChatService
import mu.KotlinLogging
import org.springframework.messaging.handler.annotation.MessageMapping
import org.springframework.messaging.handler.annotation.Payload
import org.springframework.messaging.simp.SimpMessageHeaderAccessor
import org.springframework.messaging.simp.SimpMessagingTemplate
import org.springframework.stereotype.Controller
import java.util.UUID

private val logger = KotlinLogging.logger {}

@Controller
class WorkspaceChatHandler(
    private val messagingTemplate: SimpMessagingTemplate,
    private val workspaceChatService: WorkspaceChatService,
    private val userService: UserService
) {
    @MessageMapping("/workspace.chat.send")
    fun handleChatMessage(
        @Payload request: WorkspaceChatMessageRequest,
        headerAccessor: SimpMessageHeaderAccessor
    ) {
        val userId = extractUserId(headerAccessor) ?: return

        if (!workspaceChatService.canUseWorkspaceChat(userId)) {
            logger.warn { "User $userId attempted workspace chat without subscription" }
            return
        }

        if (!workspaceChatService.isWorkspaceMember(request.workspaceId, userId)) {
            logger.warn { "User $userId is not a member of workspace ${request.workspaceId}" }
            return
        }

        if (request.content.isBlank() || request.content.length > 4000) {
            logger.warn { "Invalid message content from user $userId" }
            return
        }

        val message = workspaceChatService.sendMessage(request.workspaceId, userId, request.content)
        broadcastMessage(request.workspaceId, message)
    }

    @MessageMapping("/workspace.chat.join")
    fun handleJoin(
        @Payload payload: Map<String, String>,
        headerAccessor: SimpMessageHeaderAccessor
    ) {
        val userId = extractUserId(headerAccessor) ?: return
        val workspaceId = UUID.fromString(payload["workspace_id"] ?: payload["workspaceId"] ?: return)

        if (!workspaceChatService.canUseWorkspaceChat(userId)) return
        if (!workspaceChatService.isWorkspaceMember(workspaceId, userId)) return

        val presence = workspaceChatService.setOnline(userId, workspaceId)
        broadcastPresence(workspaceId, presence)
        logger.info { "User $userId joined workspace chat $workspaceId" }
    }

    @MessageMapping("/workspace.chat.leave")
    fun handleLeave(
        @Payload payload: Map<String, String>,
        headerAccessor: SimpMessageHeaderAccessor
    ) {
        val userId = extractUserId(headerAccessor) ?: return
        val workspaceId = UUID.fromString(payload["workspace_id"] ?: payload["workspaceId"] ?: return)

        val presence = workspaceChatService.setOffline(userId, workspaceId)
        broadcastPresence(workspaceId, presence)
        logger.info { "User $userId left workspace chat $workspaceId" }
    }

    @MessageMapping("/workspace.chat.heartbeat")
    fun handleHeartbeat(
        @Payload payload: Map<String, String>,
        headerAccessor: SimpMessageHeaderAccessor
    ) {
        val userId = extractUserId(headerAccessor) ?: return
        val workspaceId = UUID.fromString(payload["workspace_id"] ?: payload["workspaceId"] ?: return)
        workspaceChatService.heartbeat(userId, workspaceId)
    }

    @MessageMapping("/workspace.chat.typing")
    fun handleTyping(
        @Payload payload: Map<String, String>,
        headerAccessor: SimpMessageHeaderAccessor
    ) {
        val userId = extractUserId(headerAccessor) ?: return
        val workspaceId = UUID.fromString(payload["workspace_id"] ?: payload["workspaceId"] ?: return)
        val isTyping = (payload["is_typing"] ?: payload["isTyping"])?.toBooleanStrictOrNull() ?: false

        val user = userService.findById(userId)
        messagingTemplate.convertAndSend(
            "/topic/workspace.$workspaceId.chat.typing",
            mapOf(
                "user_id" to userId.toString(),
                "username" to (user?.username ?: "Unknown"),
                "is_typing" to isTyping
            )
        )
    }

    // ── WebRTC Signaling ─────────────────────────────────────────────────

    @MessageMapping("/workspace.call.offer")
    fun handleCallOffer(
        @Payload payload: Map<String, Any>,
        headerAccessor: SimpMessageHeaderAccessor
    ) {
        val fromUserId = extractUserId(headerAccessor) ?: return
        val toUserId = payload["to_user_id"]?.toString() ?: return
        val workspaceId = payload["workspace_id"]?.toString() ?: return

        val fromUser = userService.findById(fromUserId)
        logger.info { "WebRTC offer from $fromUserId to $toUserId in workspace $workspaceId" }

        messagingTemplate.convertAndSendToUser(
            toUserId,
            "/queue/call",
            mapOf(
                "type" to "offer",
                "from_user_id" to fromUserId.toString(),
                "from_username" to (fromUser?.username ?: "Unknown"),
                "from_first_name" to (fromUser?.firstName ?: ""),
                "from_last_name" to (fromUser?.lastName ?: ""),
                "from_profile_picture" to (fromUser?.profilePicture ?: ""),
                "workspace_id" to workspaceId,
                "sdp" to (payload["sdp"] ?: "")
            )
        )
    }

    @MessageMapping("/workspace.call.answer")
    fun handleCallAnswer(
        @Payload payload: Map<String, Any>,
        headerAccessor: SimpMessageHeaderAccessor
    ) {
        val fromUserId = extractUserId(headerAccessor) ?: return
        val toUserId = payload["to_user_id"]?.toString() ?: return

        logger.info { "WebRTC answer from $fromUserId to $toUserId" }

        messagingTemplate.convertAndSendToUser(
            toUserId,
            "/queue/call",
            mapOf(
                "type" to "answer",
                "from_user_id" to fromUserId.toString(),
                "sdp" to (payload["sdp"] ?: "")
            )
        )
    }

    @MessageMapping("/workspace.call.ice")
    fun handleICECandidate(
        @Payload payload: Map<String, Any>,
        headerAccessor: SimpMessageHeaderAccessor
    ) {
        val fromUserId = extractUserId(headerAccessor) ?: return
        val toUserId = payload["to_user_id"]?.toString() ?: return

        messagingTemplate.convertAndSendToUser(
            toUserId,
            "/queue/call",
            mapOf(
                "type" to "ice-candidate",
                "from_user_id" to fromUserId.toString(),
                "candidate" to (payload["candidate"] ?: "")
            )
        )
    }

    @MessageMapping("/workspace.call.hangup")
    fun handleCallHangup(
        @Payload payload: Map<String, Any>,
        headerAccessor: SimpMessageHeaderAccessor
    ) {
        val fromUserId = extractUserId(headerAccessor) ?: return
        val toUserId = payload["to_user_id"]?.toString() ?: return

        logger.info { "WebRTC hangup from $fromUserId to $toUserId" }

        messagingTemplate.convertAndSendToUser(
            toUserId,
            "/queue/call",
            mapOf(
                "type" to "hangup",
                "from_user_id" to fromUserId.toString()
            )
        )
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private fun broadcastMessage(
        workspaceId: UUID,
        message: WorkspaceChatMessageResponse
    ) {
        messagingTemplate.convertAndSend("/topic/workspace.$workspaceId.chat.messages", message)
    }

    private fun broadcastPresence(
        workspaceId: UUID,
        presence: WorkspaceChatPresenceUpdate
    ) {
        messagingTemplate.convertAndSend("/topic/workspace.$workspaceId.chat.presence", presence)
    }

    private fun extractUserId(headerAccessor: SimpMessageHeaderAccessor): UUID? = headerAccessor.extractUserId()
}
