package com.scrapalot.backend.controller.profile

import com.scrapalot.backend.domain.profile.AgentProfile
import com.scrapalot.backend.dto.AgentProfileResponse
import com.scrapalot.backend.dto.AgentProfilesListResponse
import com.scrapalot.backend.repository.AgentProfileRepository
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.authenticatedUserId
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toResponseEntity
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

/**
 * Agent profiles REST.
 *
 * v1 ships read-only endpoints for the picker. Workspace-scoped CRUD
 * (clone-from-system, edit, delete) lands in a follow-up — for now
 * users pick one of the four seeded system profiles
 * (legal / medical / academic / technical).
 *
 *   GET /api/v1/agent-profiles?workspace_id=...   list visible profiles
 */
@RestController
@RequestMapping("/api/v1/agent-profiles")
class AgentProfileController(
    private val repo: AgentProfileRepository,
    private val userService: UserService,
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    @GetMapping
    fun listVisible(
        @RequestParam(name = "workspace_id", required = false) workspaceId: UUID?,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<AgentProfilesListResponse> =
        resultOf {
            // Authentication-only — we don't gate on workspace access here
            // because system profiles are visible to everyone and
            // workspace profiles are filtered by workspaceId argument.
            userDetails.userId()
            val rows = repo.findVisibleForWorkspace(workspaceId)
            AgentProfilesListResponse(profiles = rows.map { it.toResponse() })
        }.toResponseEntity()
}

private fun AgentProfile.toResponse() =
    AgentProfileResponse(
        id = id ?: UUID.randomUUID(),
        workspaceId = workspaceId,
        slug = slug,
        name = name,
        description = description,
        icon = icon,
        systemPrompt = systemPrompt,
        ragStrategy = ragStrategy,
        citationStyle = citationStyle,
        toolAllowlist = toolAllowlist,
        isSystem = isSystem,
        createdAt = createdAt.toString(),
        updatedAt = updatedAt.toString(),
    )
