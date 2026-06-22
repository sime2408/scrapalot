package com.scrapalot.backend.controller.notes

import com.scrapalot.backend.domain.notes.NoteTemplate
import com.scrapalot.backend.service.NoteTemplateService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.authenticatedUserId
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toResponseEntity
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

/**
 * Persists user-created note templates.
 * System templates (Academic IMRaD, Peer review, etc.) still live in
 * the frontend catalog; this controller deals exclusively with the
 * user's "Save as new template" output.
 */
@RestController
@RequestMapping("/api/v1/notes/templates")
class NoteTemplateController(
    private val noteTemplateService: NoteTemplateService,
    private val userService: UserService,
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    @GetMapping
    fun listTemplates(
        @RequestParam("workspace_id", required = false) workspaceId: UUID?,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<List<Map<String, Any?>>> =
        resultOf {
            val userId = userDetails.userId()
            noteTemplateService.listForUser(userId, workspaceId).map { it.toResponse() }
        }.toResponseEntity()

    @PostMapping
    fun createTemplate(
        @RequestBody body: Map<String, Any?>,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Map<String, Any?>> =
        resultOf {
            val userId = userDetails.userId()
            val workspaceId = (body["workspace_id"] as? String)?.let(UUID::fromString)
            val name =
                (body["name"] as? String)?.trim()
                    ?: throw IllegalArgumentException("'name' is required")
            val skeleton =
                (body["skeleton"] as? String)
                    ?: throw IllegalArgumentException("'skeleton' is required")
            if (name.isEmpty()) throw IllegalArgumentException("'name' cannot be blank")

            @Suppress("UNCHECKED_CAST")
            val defaultContext = body["default_research_context"] as? Map<String, Any?>

            val template =
                noteTemplateService.create(
                    userId = userId,
                    workspaceId = workspaceId,
                    name = name,
                    description = body["description"] as? String,
                    category = body["category"] as? String,
                    expectedWordCount = body["expected_word_count"] as? String,
                    icon = body["icon"] as? String,
                    skeleton = skeleton,
                    defaultResearchContext = defaultContext,
                )
            template.toResponse()
        }.toResponseEntity(HttpStatus.CREATED)

    @DeleteMapping("/{templateId}")
    fun deleteTemplate(
        @PathVariable templateId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Map<String, Any?>> =
        resultOf {
            val userId = userDetails.userId()
            noteTemplateService.delete(templateId, userId)
            mapOf("success" to true)
        }.toResponseEntity()

    private fun NoteTemplate.toResponse(): Map<String, Any?> =
        mapOf(
            "id" to id?.toString(),
            "user_id" to userId.toString(),
            "workspace_id" to workspaceId?.toString(),
            "name" to name,
            "description" to description,
            "category" to category,
            "expected_word_count" to expectedWordCount,
            "icon" to icon,
            "skeleton" to skeleton,
            "default_research_context" to defaultResearchContext,
            "created_at" to createdAt.toString(),
            "updated_at" to updatedAt.toString(),
        )
}
