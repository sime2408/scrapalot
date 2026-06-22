package com.scrapalot.backend.dto

import jakarta.validation.constraints.*
import java.util.UUID

// Workspace Response
data class WorkspaceResponse(
    val id: UUID,
    val name: String,
    // Stable slug used as the `model` field by OpenAI-SDK clients
    // ("scrapalot:my-workspace[:my-collection]").
    val slug: String,
    val description: String?,
    val userId: UUID,
    val isPublic: Boolean,
    val isShared: Boolean,
    val settings: Map<String, Any>?,
    val createdAt: String,
    val updatedAt: String
)

// Create Workspace Request
data class CreateWorkspaceRequest(
    @field:NotBlank(message = "Workspace name is required")
    @field:Size(min = 1, max = 100, message = "Workspace name must be between 1 and 100 characters")
    val name: String,
    @field:Size(max = 500, message = "Description cannot exceed 500 characters")
    val description: String? = null
)

// Update Workspace Request
data class UpdateWorkspaceRequest(
    @field:Size(min = 1, max = 100, message = "Workspace name must be between 1 and 100 characters")
    val name: String? = null,
    @field:Size(max = 500, message = "Description cannot exceed 500 characters")
    val description: String? = null,
    val isPublic: Boolean? = null,
    val settings: Map<String, Any>? = null
)

// Share Workspace Request
@Suppress("JpaImmutableNotNullablePropertyInspection") // DTO, not a JPA entity — val fields with @NotNull are intentional
data class ShareWorkspaceRequest(
    @field:NotNull(message = "User ID is required")
    val userId: UUID,
    @field:NotBlank(message = "Permission is required")
    @field:Pattern(regexp = "^(read|write|admin)$", message = "Permission must be 'read', 'write', or 'admin'")
    val permission: String = "read"
)

// Workspace User Response
data class WorkspaceUserResponse(
    val workspaceId: UUID,
    val userId: UUID,
    val username: String? = null,
    val email: String? = null,
    val profilePicture: String? = null,
    val permission: String,
    val addedAt: String
)

// Pagination metadata
data class PaginationResponse(
    val page: Int,
    val pageSize: Int,
    val total: Int,
    val pages: Int
)

// Paginated Workspaces Response
data class PaginatedWorkspacesResponse(
    val workspaces: List<WorkspaceResponse>,
    val pagination: PaginationResponse
)

// Workspace Role Response (matches Python backend format)
data class WorkspaceRoleResponse(
    val workspaceId: UUID,
    val role: String, // "owner", "editor", "viewer"
    val isOwner: Boolean,
    val permissions: WorkspacePermissions
)

data class WorkspacePermissions(
    val canRead: Boolean,
    val canEdit: Boolean,
    val canDelete: Boolean,
    val canShare: Boolean
)

// Update Workspace User Role Request
data class UpdateWorkspaceRoleRequest(
    @field:NotBlank(message = "Permission is required")
    @field:Pattern(regexp = "^(read|write|admin)$", message = "Permission must be 'read', 'write', or 'admin'")
    val permission: String
)
