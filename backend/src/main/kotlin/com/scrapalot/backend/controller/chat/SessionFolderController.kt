package com.scrapalot.backend.controller.chat

import com.scrapalot.backend.dto.CreateSessionFolderRequest
import com.scrapalot.backend.dto.MoveSessionRequest
import com.scrapalot.backend.dto.SessionFolderDTO
import com.scrapalot.backend.dto.UpdateSessionFolderRequest
import com.scrapalot.backend.service.SessionFolderService
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
@RequestMapping("/api/v1/session-folders")
@Tag(name = "Session Folders", description = "Session folder management")
@SecurityRequirement(name = "bearerAuth")
class SessionFolderController(
    private val sessionFolderService: SessionFolderService,
    private val userService: UserService
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    @GetMapping
    @Operation(summary = "List folders", description = "Get all session folders for the authenticated user")
    fun getFolders(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<SessionFolderDTO>> =
        resultOf {
            val userId = userDetails.userId()
            sessionFolderService.getFoldersByUserId(userId)
        }.toResponseEntity()

    @PostMapping
    @Operation(summary = "Create folder", description = "Create a new session folder")
    fun createFolder(
        @AuthenticationPrincipal userDetails: UserDetails,
        @Valid @RequestBody request: CreateSessionFolderRequest
    ): ResponseEntity<SessionFolderDTO> =
        resultOf {
            val userId = userDetails.userId()
            sessionFolderService.createFolder(userId, request)
        }.toResponseEntity(HttpStatus.CREATED)

    @PutMapping("/{folderId}")
    @Operation(summary = "Update folder", description = "Rename or reorder a session folder")
    fun updateFolder(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable folderId: UUID,
        @Valid @RequestBody request: UpdateSessionFolderRequest
    ): ResponseEntity<SessionFolderDTO> =
        resultOf {
            val userId = userDetails.userId()
            sessionFolderService.updateFolder(folderId, userId, request)
        }.toResponseEntity()

    @DeleteMapping("/{folderId}")
    @Operation(summary = "Delete folder", description = "Delete a session folder (sessions become unfiled)")
    fun deleteFolder(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable folderId: UUID
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            sessionFolderService.deleteFolder(folderId, userId)
        }.toNoContentResponse()

    @PostMapping("/move-session/{sessionId}")
    @Operation(summary = "Move session", description = "Move a session to a folder or unfiled")
    fun moveSession(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable sessionId: UUID,
        @Valid @RequestBody request: MoveSessionRequest
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            sessionFolderService.moveSession(sessionId, userId, request)
        }.toNoContentResponse()
}
