package com.scrapalot.backend.controller.messaging

import com.scrapalot.backend.dto.AdminMessageRequest
import com.scrapalot.backend.dto.DirectConversationResponse
import com.scrapalot.backend.dto.DirectMessageResponse
import com.scrapalot.backend.service.AdminMessageService
import com.scrapalot.backend.service.DirectMessageService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.authenticatedUserId
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toResponseEntity
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1/messages")
class DirectMessageController(
    private val directMessageService: DirectMessageService,
    private val adminMessageService: AdminMessageService,
    private val userService: UserService
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    // ---- Admin messaging overlay (NOT gated by subscription — admin messages must
    // reach every user, including free ones; authorization is by participant + kind). ----

    @GetMapping("/admin")
    fun getAdminThreads(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<DirectConversationResponse>> = resultOf { adminMessageService.getAdminThreads(userDetails.userId()) }.toResponseEntity()

    @GetMapping("/admin/{conversationId}")
    fun getAdminMessages(
        @PathVariable conversationId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<DirectMessageResponse>> = resultOf { adminMessageService.getAdminMessages(conversationId, userDetails.userId()) }.toResponseEntity()

    @PostMapping("/admin/{conversationId}/reply")
    fun replyToAdmin(
        @PathVariable conversationId: UUID,
        @RequestBody request: AdminMessageRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<DirectMessageResponse> = resultOf { adminMessageService.reply(userDetails.userId(), conversationId, request.content) }.toResponseEntity()

    @PostMapping("/admin/{conversationId}/read")
    fun markAdminRead(
        @PathVariable conversationId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Boolean>> =
        resultOf {
            adminMessageService.markRead(conversationId, userDetails.userId())
            mapOf("success" to true)
        }.toResponseEntity()

    @PostMapping("/admin/{conversationId}/dismiss")
    fun dismissAdmin(
        @PathVariable conversationId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Boolean>> =
        resultOf {
            adminMessageService.dismiss(conversationId, userDetails.userId())
            mapOf("success" to true)
        }.toResponseEntity()

    @GetMapping("/conversations")
    fun getConversations(
        @RequestParam(required = false) workspaceId: UUID?,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<DirectConversationResponse>> =
        resultOf {
            val userId = userDetails.userId()
            requireDmAccess(userId)
            directMessageService.getConversations(userId, workspaceId)
        }.toResponseEntity()

    @GetMapping("/conversations/{conversationId}")
    fun getMessages(
        @PathVariable conversationId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<DirectMessageResponse>> =
        resultOf {
            val userId = userDetails.userId()
            requireDmAccess(userId)
            directMessageService.getMessages(conversationId, userId)
        }.toResponseEntity()

    @PostMapping("/conversations/{conversationId}/read")
    fun markAsRead(
        @PathVariable conversationId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Boolean>> =
        resultOf {
            val userId = userDetails.userId()
            requireDmAccess(userId)
            directMessageService.markAsRead(conversationId, userId)
            mapOf("success" to true)
        }.toResponseEntity()

    @GetMapping("/access")
    fun checkAccess(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Boolean>> =
        resultOf {
            val userId = userDetails.userId()
            mapOf("has_feature" to directMessageService.canUseDirectMessages(userId))
        }.toResponseEntity()

    private fun requireDmAccess(userId: UUID) {
        if (!directMessageService.canUseDirectMessages(userId)) {
            throw SecurityException("Direct messages require Pro or Enterprise subscription")
        }
    }
}
