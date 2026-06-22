package com.scrapalot.backend.controller.user

import com.scrapalot.backend.domain.workspace.Workspace
import com.scrapalot.backend.domain.workspace.WorkspaceUser
import com.scrapalot.backend.dto.CreateWorkspaceRequest
import com.scrapalot.backend.dto.PaginatedWorkspacesResponse
import com.scrapalot.backend.dto.PaginationResponse
import com.scrapalot.backend.dto.ShareWorkspaceRequest
import com.scrapalot.backend.dto.UpdateWorkspaceRequest
import com.scrapalot.backend.dto.UpdateWorkspaceRoleRequest
import com.scrapalot.backend.dto.WorkspacePermissions
import com.scrapalot.backend.dto.WorkspaceResponse
import com.scrapalot.backend.dto.WorkspaceRoleResponse
import com.scrapalot.backend.dto.WorkspaceUserResponse
import com.scrapalot.backend.service.EmailService
import com.scrapalot.backend.service.SubscriptionService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.service.WorkspaceService
import com.scrapalot.backend.utils.*
import jakarta.validation.Valid
import mu.KotlinLogging
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import java.util.UUID

private val logger = KotlinLogging.logger {}

@RestController
@RequestMapping("/api/v1/workspaces")
class WorkspaceController(
    private val workspaceService: WorkspaceService,
    private val userService: UserService,
    private val subscriptionService: SubscriptionService,
    private val emailService: EmailService
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    @GetMapping
    fun getWorkspaces(
        @RequestParam(defaultValue = "1") page: Int,
        @RequestParam(name = "page_size", defaultValue = "20") pageSize: Int,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<PaginatedWorkspacesResponse> =
        resultOf {
            val userId = userDetails.userId()

            val allWorkspaces = workspaceService.findAllAccessibleWorkspaces(userId)
            val total = allWorkspaces.size

            val startIndex = (page - 1) * pageSize
            val endIndex = minOf(startIndex + pageSize, total)
            val paginatedWorkspaces =
                if (startIndex < total) {
                    allWorkspaces.subList(startIndex, endIndex)
                } else {
                    emptyList()
                }

            val totalPages = if (total > 0) ((total + pageSize - 1) / pageSize) else 0

            PaginatedWorkspacesResponse(
                workspaces = paginatedWorkspaces.map { it.toResponse() },
                pagination =
                    PaginationResponse(
                        page = page,
                        pageSize = pageSize,
                        total = total,
                        pages = totalPages
                    )
            )
        }.toResponseEntity()

    @GetMapping("/default")
    fun getDefaultWorkspace(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<WorkspaceResponse> =
        resultOf {
            logger.debug("Getting default workspace for user: {}", userDetails.username)
            val userId = userDetails.userId()

            workspaceService
                .getDefaultWorkspace(userId)
                .orNotFound("Default workspace not found")
                .toResponse()
        }.toResponseEntity()

    @GetMapping("/{workspaceId}")
    fun getWorkspace(
        @PathVariable workspaceId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<WorkspaceResponse> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireAccess(workspaceId, userId)

            workspaceService
                .findById(workspaceId)
                .orNotFound("Workspace not found: $workspaceId")
                .toResponse()
        }.toResponseEntity()

    @GetMapping("/{workspaceId}/my-role")
    fun getMyWorkspaceRole(
        @PathVariable workspaceId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<WorkspaceRoleResponse> =
        resultOf {
            val userId = userDetails.userId()

            val permission =
                workspaceService
                    .getUserPermission(workspaceId, userId)
                    .orNotFound("No access to workspace")

            val isOwner = workspaceService.isOwner(workspaceId, userId)

            val role =
                when (permission) {
                    "admin" -> "owner"
                    "write" -> "editor"
                    "read" -> "viewer"
                    else -> "viewer"
                }

            val permissions =
                WorkspacePermissions(
                    canRead = true,
                    canEdit = role in listOf("owner", "editor"),
                    canDelete = role == "owner",
                    canShare = role == "owner"
                )

            WorkspaceRoleResponse(
                workspaceId = workspaceId,
                role = role,
                isOwner = isOwner,
                permissions = permissions
            )
        }.toResponseEntity()

    @PostMapping
    fun createWorkspace(
        @Valid @RequestBody request: CreateWorkspaceRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<WorkspaceResponse> =
        resultOf {
            val userId = userDetails.userId()

            workspaceService
                .createWorkspace(
                    name = request.name,
                    userId = userId,
                    description = request.description
                ).toResponse()
        }.toResponseEntity(HttpStatus.CREATED)

    @PutMapping("/{workspaceId}")
    fun updateWorkspace(
        @PathVariable workspaceId: UUID,
        @Valid @RequestBody request: UpdateWorkspaceRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<WorkspaceResponse> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireEdit(workspaceId, userId)

            workspaceService
                .updateWorkspace(
                    workspaceId = workspaceId,
                    name = request.name,
                    description = request.description
                ).toResponse()
        }.toResponseEntity()

    @DeleteMapping("/{workspaceId}")
    fun deleteWorkspace(
        @PathVariable workspaceId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireOwner(workspaceId, userId, "Only workspace owner can delete workspace")

            workspaceService.deleteWorkspace(workspaceId)
        }.toNoContentResponse()

    // Sharing Management

    @GetMapping("/{workspaceId}/users")
    fun getWorkspaceUsers(
        @PathVariable workspaceId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<WorkspaceUserResponse>> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireAccess(workspaceId, userId)

            workspaceService
                .getWorkspaceUsers(workspaceId)
                .map { wu ->
                    val user = userService.findById(wu.userId)
                    wu.toResponse().copy(username = user?.username, email = user?.email, profilePicture = user?.profilePicture)
                }
        }.toResponseEntity()

    @PostMapping("/{workspaceId}/share")
    fun shareWorkspace(
        @PathVariable workspaceId: UUID,
        @Valid @RequestBody request: ShareWorkspaceRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<WorkspaceUserResponse> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireOwner(workspaceId, userId, "Only workspace owner can share workspace")
            // shared_workspaces has been a plan key since migration 081 but was
            // never enforced. Gate the OWNER initiating the share here at the
            // controller — NOT inside WorkspaceService.shareWorkspace, which the
            // invitation flow calls internally to add a (possibly free) invitee
            // to the admin's workspace.
            subscriptionService.requireFeature(userId, "shared_workspaces")

            val response =
                workspaceService
                    .shareWorkspace(
                        workspaceId = workspaceId,
                        targetUserId = request.userId,
                        permission = request.permission
                    ).toResponse()

            // Best-effort share notification. A mail failure must never fail the
            // share itself — the access grant has already committed — so we
            // swallow and log instead of propagating into the resultOf result.
            notifyWorkspaceShared(workspaceId, sharerUserId = userId, targetUserId = request.userId, permission = request.permission)

            response
        }.toResponseEntity(HttpStatus.CREATED)

    @PutMapping("/{workspaceId}/share/{userId}")
    fun updateWorkspaceUserRole(
        @PathVariable workspaceId: UUID,
        @PathVariable userId: UUID,
        @Valid @RequestBody request: UpdateWorkspaceRoleRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<WorkspaceUserResponse> =
        resultOf {
            val currentUserId = userDetails.userId()
            workspaceService.requireOwner(workspaceId, currentUserId, "Only workspace owner can change user roles")

            workspaceService.updateUserRole(workspaceId, userId, request.permission)

            workspaceService
                .getWorkspaceUsers(workspaceId)
                .first { it.userId == userId }
                .toResponse()
        }.toResponseEntity()

    @DeleteMapping("/{workspaceId}/users/{userId}")
    fun removeUserFromWorkspace(
        @PathVariable workspaceId: UUID,
        @PathVariable userId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val currentUserId = userDetails.userId()
            workspaceService.requireOwner(workspaceId, currentUserId, "Only workspace owner can remove users")

            workspaceService.removeWorkspaceAccess(workspaceId, userId)
        }.toNoContentResponse()

    private fun notifyWorkspaceShared(
        workspaceId: UUID,
        sharerUserId: UUID,
        targetUserId: UUID,
        permission: String
    ) {
        runCatching {
            val target = userService.findById(targetUserId) ?: return
            val email = target.email?.takeIf { it.isNotBlank() } ?: return
            val sharer = userService.findById(sharerUserId)
            val sharerName =
                listOfNotNull(sharer?.firstName, sharer?.lastName)
                    .filter { it.isNotBlank() }
                    .joinToString(" ")
                    .ifBlank { sharer?.username ?: sharer?.email ?: "A Scrapalot user" }
            val workspaceName = workspaceService.findById(workspaceId)?.name ?: "a workspace"
            val recipientName = target.firstName?.takeIf { it.isNotBlank() } ?: target.username

            emailService.sendWorkspaceShared(
                toEmail = email,
                recipientName = recipientName,
                sharerName = sharerName,
                workspaceId = workspaceId.toString(),
                workspaceName = workspaceName,
                permissionLabel = permissionLabel(permission)
            )
        }.onFailure { e ->
            logger.warn(e) { "Failed to send workspace-shared notification for workspace $workspaceId to user $targetUserId" }
        }
    }

    private fun permissionLabel(permission: String): String =
        when (permission.lowercase()) {
            "read", "viewer", "view" -> "Viewer (read-only)"
            "write", "editor", "edit" -> "Editor"
            "admin" -> "Admin"
            else -> permission.replaceFirstChar { it.uppercase() }
        }
}

private fun Workspace.toResponse() =
    WorkspaceResponse(
        id = id.orThrow("Entity"),
        name = name,
        slug = slug,
        description = description,
        userId = userId,
        isPublic = isPublic,
        isShared = isShared,
        settings = emptyMap(), // Workspace entity doesn't have settings
        createdAt = createdAt.toString(),
        updatedAt = updatedAt.toString()
    )

private fun WorkspaceUser.toResponse() =
    WorkspaceUserResponse(
        workspaceId = workspaceId,
        userId = userId,
        permission = permission,
        addedAt = createdAt.toString() // Using createdAt as addedAt
    )
