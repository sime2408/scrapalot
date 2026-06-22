package com.scrapalot.backend.controller.chat

import com.scrapalot.backend.dto.CreateSessionShareRequest
import com.scrapalot.backend.dto.SessionShareDTO
import com.scrapalot.backend.dto.SharedConversationDTO
import com.scrapalot.backend.service.SessionShareService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.*
import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.security.SecurityRequirement
import io.swagger.v3.oas.annotations.tags.Tag
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import java.util.UUID

@RestController
@Tag(name = "Session Sharing", description = "Share conversations via public links")
class SessionShareController(
    private val sessionShareService: SessionShareService,
    private val userService: UserService
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    // --- Authenticated endpoints ---

    @PostMapping("/api/v1/sessions/{sessionId}/share")
    @SecurityRequirement(name = "bearerAuth")
    @Operation(summary = "Create a share link for a conversation")
    fun createShare(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable sessionId: UUID,
        @RequestBody(required = false) request: CreateSessionShareRequest?
    ): ResponseEntity<SessionShareDTO> =
        resultOf {
            sessionShareService.createShare(sessionId, userDetails.userId(), request ?: CreateSessionShareRequest())
        }.toResponseEntity(HttpStatus.CREATED)

    @DeleteMapping("/api/v1/sessions/{sessionId}/share")
    @SecurityRequirement(name = "bearerAuth")
    @Operation(summary = "Revoke a share link")
    fun revokeShare(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable sessionId: UUID
    ): ResponseEntity<Void> =
        resultOf {
            sessionShareService.revokeShare(sessionId, userDetails.userId())
        }.toNoContentResponse()

    @GetMapping("/api/v1/sessions/{sessionId}/share")
    @SecurityRequirement(name = "bearerAuth")
    @Operation(summary = "Get active share info for a conversation")
    fun getShare(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable sessionId: UUID
    ): ResponseEntity<SessionShareDTO?> =
        resultOf {
            sessionShareService.getShareForSession(sessionId, userDetails.userId())
        }.toResponseEntity()

    // --- Public endpoint (no auth) ---

    @GetMapping("/api/v1/shared/{shareToken}")
    @Operation(summary = "View a shared conversation (public, no auth required)")
    fun getSharedConversation(
        @PathVariable shareToken: String
    ): ResponseEntity<SharedConversationDTO> =
        resultOf {
            sessionShareService.getSharedConversation(shareToken)
        }.toResponseEntity()
}
