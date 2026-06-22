package com.scrapalot.backend.controller.chat

import com.scrapalot.backend.dto.WorkspaceChatMessageResponse
import com.scrapalot.backend.dto.WorkspaceChatPresenceResponse
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.service.WorkspaceChatService
import com.scrapalot.backend.service.WorkspaceService
import com.scrapalot.backend.utils.authenticatedUserId
import com.scrapalot.backend.utils.requireAccess
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toResponseEntity
import org.springframework.http.ResponseEntity
import org.springframework.messaging.simp.SimpMessagingTemplate
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/chat")
class WorkspaceChatController(
    private val workspaceChatService: WorkspaceChatService,
    private val workspaceService: WorkspaceService,
    private val userService: UserService,
    private val messagingTemplate: SimpMessagingTemplate
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    @GetMapping("/messages")
    fun getMessages(
        @PathVariable workspaceId: UUID,
        @RequestParam(defaultValue = "50") limit: Int,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<WorkspaceChatMessageResponse>> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireAccess(workspaceId, userId)
            requireChatAccess(userId)
            workspaceChatService.getMessages(workspaceId, limit)
        }.toResponseEntity()

    @GetMapping("/online-users")
    fun getOnlineUsers(
        @PathVariable workspaceId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<WorkspaceChatPresenceResponse>> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireAccess(workspaceId, userId)
            workspaceChatService.getOnlineUsers(workspaceId)
        }.toResponseEntity()

    @GetMapping("/members")
    fun getMembers(
        @PathVariable workspaceId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<WorkspaceChatPresenceResponse>> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireAccess(workspaceId, userId)
            workspaceChatService.getWorkspaceMembersWithPresence(workspaceId)
        }.toResponseEntity()

    @GetMapping("/access")
    fun checkAccess(
        @PathVariable workspaceId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> =
        resultOf {
            val userId = userDetails.userId()
            val hasAccess = workspaceChatService.canUseWorkspaceChat(userId)
            val isMember = workspaceChatService.isWorkspaceMember(workspaceId, userId)
            val canModerate = isMember && workspaceChatService.isModerator(workspaceId, userId)
            mapOf(
                "hasFeature" to hasAccess,
                "isMember" to isMember,
                "canChat" to (hasAccess && isMember),
                "canModerate" to canModerate
            )
        }.toResponseEntity()

    @DeleteMapping("/messages/{messageId}")
    fun deleteMessage(
        @PathVariable workspaceId: UUID,
        @PathVariable messageId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireAccess(workspaceId, userId)
            requireChatAccess(userId)
            val deletedId =
                workspaceChatService.deleteMessage(workspaceId, messageId, userId)
                    ?: throw SecurityException("Cannot delete this message")
            broadcastDeletion(workspaceId, listOf(deletedId))
            mapOf("deleted_ids" to listOf(deletedId.toString()))
        }.toResponseEntity()

    @PostMapping("/messages/{messageId}/rollback")
    fun rollbackFrom(
        @PathVariable workspaceId: UUID,
        @PathVariable messageId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireAccess(workspaceId, userId)
            requireChatAccess(userId)
            if (!workspaceChatService.isModerator(workspaceId, userId)) {
                throw SecurityException("Only the team leader or system admin can rollback the conversation")
            }
            val ids = workspaceChatService.rollbackFrom(workspaceId, messageId, userId)
            if (ids.isNotEmpty()) broadcastDeletion(workspaceId, ids)
            mapOf("deleted_ids" to ids.map { it.toString() })
        }.toResponseEntity()

    @DeleteMapping("/messages")
    fun clearMessages(
        @PathVariable workspaceId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireAccess(workspaceId, userId)
            requireChatAccess(userId)
            if (!workspaceChatService.isModerator(workspaceId, userId)) {
                throw SecurityException("Only the team leader or system admin can clear the conversation")
            }
            val ok = workspaceChatService.clearAll(workspaceId, userId)
            if (ok) broadcastClear(workspaceId)
            mapOf("cleared" to ok)
        }.toResponseEntity()

    private fun broadcastDeletion(
        workspaceId: UUID,
        ids: List<UUID>
    ) {
        messagingTemplate.convertAndSend(
            "/topic/workspace.$workspaceId.chat.deletions",
            mapOf("type" to "deleted", "ids" to ids.map { it.toString() })
        )
    }

    private fun broadcastClear(workspaceId: UUID) {
        messagingTemplate.convertAndSend(
            "/topic/workspace.$workspaceId.chat.deletions",
            mapOf("type" to "cleared")
        )
    }

    private fun requireChatAccess(userId: UUID) {
        if (!workspaceChatService.canUseWorkspaceChat(userId)) {
            throw SecurityException("Workspace chat requires Pro or Enterprise subscription")
        }
    }
}
