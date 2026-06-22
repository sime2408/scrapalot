package com.scrapalot.backend.utils

import com.scrapalot.backend.domain.auth.User
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.service.WorkspaceService
import org.springframework.data.domain.PageRequest
import org.springframework.data.domain.Sort
import org.springframework.security.core.userdetails.UserDetails
import java.util.UUID

/**
 * Controller helper extensions for common patterns.
 * Reduces boilerplate in REST controllers.
 */

/**
 * Get an authenticated user from UserDetails with a Result pattern.
 * Replaces manual null-checking in controllers.
 */
fun UserDetails.getAuthenticatedUser(userService: UserService): Result<User> = userService.findByEmailOrUsername(username).toResult("User not found: $username")

/**
 * Get the authenticated user's UUID directly.
 * Combines getAuthenticatedUser() and ID extraction in one call.
 * Use when you only need the user ID (most endpoints).
 */
fun UserDetails.authenticatedUserId(userService: UserService): UUID = getAuthenticatedUser(userService).getOrThrow().id.orThrow("User")

/**
 * Require the user has view access to the workspace.
 * Throws SecurityException (403) if access is denied.
 */
fun WorkspaceService.requireAccess(
    workspaceId: UUID,
    userId: UUID,
    message: String = "Access denied to workspace"
) {
    hasAccess(workspaceId, userId).toAuthResult(message).getOrThrow()
}

/**
 * Require the user has edit access to the workspace.
 * Throws SecurityException (403) if edit access is denied.
 */
fun WorkspaceService.requireEdit(
    workspaceId: UUID,
    userId: UUID,
    message: String = "Edit access denied to workspace"
) {
    canEdit(workspaceId, userId).toAuthResult(message).getOrThrow()
}

/**
 * Require the user is the workspace owner.
 * Throws SecurityException (403) if the user is not the owner.
 */
fun WorkspaceService.requireOwner(
    workspaceId: UUID,
    userId: UUID,
    message: String = "Only the workspace owner can perform this action"
) {
    isOwner(workspaceId, userId).toAuthResult(message).getOrThrow()
}

/**
 * Build Spring Data Sort from sortBy and sortOrder parameters.
 * Supports "asc" and "desc" ordering.
 */
fun buildSort(
    sortBy: String = "name",
    sortOrder: String = "asc"
): Sort =
    if (sortOrder.equals("desc", ignoreCase = true)) {
        Sort.by(sortBy).descending()
    } else {
        Sort.by(sortBy).ascending()
    }

/**
 * Build Spring Data PageRequest with 1-based to 0-based conversion.
 * Frontend uses 1-based pagination, Spring uses 0-based.
 */
fun buildPageRequest(
    page: Int = 1,
    limit: Int = 20,
    sortBy: String = "name",
    sortOrder: String = "asc"
): PageRequest {
    val pageIndex = (page - 1).coerceAtLeast(0)
    val sort = buildSort(sortBy, sortOrder)
    return PageRequest.of(pageIndex, limit, sort)
}

/**
 * Extension to validate an admin role.
 */
fun User.isAdmin(): Boolean = role.equals("admin", ignoreCase = true)

/**
 * DSL for building update maps with only non-null values.
 * Example: updateMap { "firstName" to firstName; "lastName" to lastName }
 */
inline fun buildUpdateMap(block: UpdateMapBuilder.() -> Unit): Map<String, Any?> = UpdateMapBuilder().apply(block).build()

class UpdateMapBuilder {
    private val map = mutableMapOf<String, Any?>()

    infix fun String.to(value: Any?) {
        value?.let { map[this] = it }
    }

    fun build(): Map<String, Any?> = map.toMap()
}
