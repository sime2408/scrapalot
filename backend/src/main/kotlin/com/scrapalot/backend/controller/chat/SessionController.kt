package com.scrapalot.backend.controller.chat

import com.scrapalot.backend.dto.CreateSessionRequest
import com.scrapalot.backend.dto.SessionDTO
import com.scrapalot.backend.dto.SessionListResponse
import com.scrapalot.backend.dto.SessionMetricsResponse
import com.scrapalot.backend.dto.SessionAttachmentDTO
import com.scrapalot.backend.dto.SetSessionMarkerRequest
import com.scrapalot.backend.dto.SetSessionPinRequest
import com.scrapalot.backend.dto.UpdateSessionRequest
import com.scrapalot.backend.service.SessionAttachmentService
import com.scrapalot.backend.service.SessionService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.*
import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.security.SecurityRequirement
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1/sessions")
@Tag(name = "Sessions", description = "Chat session management")
@SecurityRequirement(name = "bearerAuth")
class SessionController(
    private val sessionService: SessionService,
    private val sessionAttachmentService: SessionAttachmentService,
    private val userService: UserService
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    @GetMapping
    @Operation(summary = "Get all sessions", description = "Get all chat sessions for the authenticated user")
    fun getSessions(
        @AuthenticationPrincipal userDetails: UserDetails,
        @RequestParam(defaultValue = "0") page: Int,
        @RequestParam(defaultValue = "50") pageSize: Int,
        @RequestParam(required = false) collectionId: UUID?,
        @RequestParam(required = false) folderId: UUID?,
        @RequestParam(required = false, defaultValue = "false") unfiledOnly: Boolean
    ): ResponseEntity<SessionListResponse> =
        resultOf {
            val userId = userDetails.userId()
            sessionService.getSessionsByUserId(userId, page, pageSize, collectionId, folderId, unfiledOnly)
        }.toResponseEntity()

    @GetMapping("/{sessionId}")
    @Operation(summary = "Get session by ID", description = "Get a specific chat session by ID")
    fun getSessionById(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable sessionId: UUID
    ): ResponseEntity<SessionDTO> =
        resultOf {
            val userId = userDetails.userId()
            sessionService.getSessionById(sessionId, userId)
        }.toResponseEntity()

    @PostMapping
    @Operation(summary = "Create session", description = "Create a new chat session")
    fun createSession(
        @AuthenticationPrincipal userDetails: UserDetails,
        @Valid @RequestBody request: CreateSessionRequest
    ): ResponseEntity<SessionDTO> =
        resultOf {
            val userId = userDetails.userId()
            sessionService.createSession(userId, request)
        }.toResponseEntity(HttpStatus.CREATED)

    @PutMapping("/{sessionId}")
    @Operation(summary = "Update session", description = "Update an existing chat session")
    fun updateSession(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable sessionId: UUID,
        @Valid @RequestBody request: UpdateSessionRequest
    ): ResponseEntity<SessionDTO> =
        resultOf {
            val userId = userDetails.userId()
            sessionService.updateSession(sessionId, userId, request)
        }.toResponseEntity()

    @PutMapping("/{sessionId}/marker")
    @Operation(summary = "Set session marker", description = "Set or clear a session's priority marker (icon + color)")
    fun setSessionMarker(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable sessionId: UUID,
        @RequestBody request: SetSessionMarkerRequest
    ): ResponseEntity<SessionDTO> =
        resultOf {
            val userId = userDetails.userId()
            sessionService.setSessionMarker(sessionId, userId, request.markerIcon, request.markerColor)
        }.toResponseEntity()

    @PutMapping("/{sessionId}/pin")
    @Operation(summary = "Pin or unpin session", description = "Pin a session to the top of its sidebar group, or unpin it")
    fun setSessionPin(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable sessionId: UUID,
        @RequestBody request: SetSessionPinRequest
    ): ResponseEntity<SessionDTO> =
        resultOf {
            val userId = userDetails.userId()
            sessionService.setSessionPin(sessionId, userId, request.isPinned)
        }.toResponseEntity()

    @DeleteMapping("/{sessionId}")
    @Operation(summary = "Delete session", description = "Delete a chat session")
    fun deleteSession(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable sessionId: UUID
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            sessionService.deleteSession(sessionId, userId)
        }.toNoContentResponse()

    @GetMapping("/search")
    @Operation(summary = "Search sessions", description = "Search sessions by conversation name")
    fun searchSessions(
        @AuthenticationPrincipal userDetails: UserDetails,
        @RequestParam query: String,
        @RequestParam(defaultValue = "0") page: Int,
        @RequestParam(defaultValue = "50") pageSize: Int
    ): ResponseEntity<SessionListResponse> =
        resultOf {
            val userId = userDetails.userId()
            sessionService.searchSessions(userId, query, page, pageSize)
        }.toResponseEntity()

    @GetMapping("/by-name")
    @Operation(summary = "Get session by name", description = "Find a session by deterministic name (collection + documents)")
    fun getSessionByName(
        @AuthenticationPrincipal userDetails: UserDetails,
        @RequestParam collectionId: UUID,
        @RequestParam(required = false) documentIds: List<UUID>?
    ): ResponseEntity<SessionDTO?> =
        resultOf {
            val userId = userDetails.userId()
            sessionService.getSessionByName(userId, collectionId, documentIds ?: emptyList())
        }.toResponseEntity()

    @GetMapping("/by-collection")
    @Operation(summary = "Get session by collection", description = "Find the most recent session for a collection")
    fun getSessionByCollection(
        @AuthenticationPrincipal userDetails: UserDetails,
        @RequestParam collectionId: UUID
    ): ResponseEntity<SessionDTO?> =
        resultOf {
            val userId = userDetails.userId()
            sessionService.getSessionByCollection(userId, collectionId)
        }.toResponseEntity()

    @GetMapping("/{sessionId}/metrics")
    @Operation(summary = "Get session metrics", description = "Get aggregated token usage metrics for a session")
    fun getSessionMetrics(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable sessionId: UUID
    ): ResponseEntity<SessionMetricsResponse> =
        resultOf {
            val userId = userDetails.userId()
            sessionService.getSessionMetrics(sessionId, userId)
        }.toResponseEntity()

    @GetMapping("/{sessionId}/attachments")
    @Operation(summary = "List session attachments", description = "Get the documents kept attached to this chat session")
    fun getSessionAttachments(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable sessionId: UUID
    ): ResponseEntity<List<SessionAttachmentDTO>> =
        resultOf {
            val userId = userDetails.userId()
            sessionAttachmentService.listForSession(sessionId, userId)
        }.toResponseEntity()

    @DeleteMapping("/{sessionId}/attachments/{attachmentId}")
    @Operation(summary = "Remove session attachment", description = "Detach a document from this chat session")
    fun deleteSessionAttachment(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable sessionId: UUID,
        @PathVariable attachmentId: UUID
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            sessionAttachmentService.delete(sessionId, attachmentId, userId)
        }.toNoContentResponse()
}
