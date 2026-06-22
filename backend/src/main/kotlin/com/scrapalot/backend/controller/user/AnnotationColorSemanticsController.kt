package com.scrapalot.backend.controller.user

import com.scrapalot.backend.service.AnnotationColorSemanticsService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.authenticatedUserId
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import java.util.UUID

/**
 * Workspace-level annotation color → label map. Any member can read;
 * only members with edit permission (admin / write) can update.
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/annotation-color-semantics")
class AnnotationColorSemanticsController(
    private val service: AnnotationColorSemanticsService,
    private val userService: UserService,
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    @GetMapping
    fun get(
        @PathVariable workspaceId: UUID,
        @AuthenticationPrincipal user: UserDetails,
    ): ResponseEntity<Map<String, Any?>> {
        val map = service.get(workspaceId, user.userId())
        return ResponseEntity.ok(mapOf("color_to_label" to map))
    }

    @PutMapping
    fun put(
        @PathVariable workspaceId: UUID,
        @RequestBody body: UpdateAnnotationColorSemanticsRequest,
        @AuthenticationPrincipal user: UserDetails,
    ): ResponseEntity<Map<String, Any?>> {
        val updated = service.put(workspaceId, body.color_to_label, user.userId())
        return ResponseEntity.ok(mapOf("color_to_label" to updated))
    }
}

data class UpdateAnnotationColorSemanticsRequest(
    val color_to_label: Map<String, String> = emptyMap(),
)
