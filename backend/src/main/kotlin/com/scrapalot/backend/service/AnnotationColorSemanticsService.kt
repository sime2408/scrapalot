package com.scrapalot.backend.service

import com.scrapalot.backend.domain.workspace.AnnotationColorSemantics
import com.scrapalot.backend.repository.AnnotationColorSemanticsRepository
import org.springframework.security.access.AccessDeniedException
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.OffsetDateTime
import java.util.UUID

/**
 * Workspace-level mapping of annotation colors (hex) to human labels.
 * Read access requires workspace membership; write access requires
 * workspace edit permission (admin / write).
 */
@Service
class AnnotationColorSemanticsService(
    private val repository: AnnotationColorSemanticsRepository,
    private val workspaceService: WorkspaceService,
) {
    /**
     * Hex strings the annotation popovers expose. Anything outside this
     * set is rejected to keep the swatches stable; if the design system
     * changes the palette, update both this constant and the popover.
     */
    private val allowedColors =
        setOf(
            "#ffd400", // yellow
            "#ff6666", // red
            "#5fb236", // green
            "#2ea8e5", // blue
            "#a28ae5", // purple
            "#e56eee", // magenta
            "#f19837", // orange
            "#aaaaaa", // gray
        )

    @Transactional(readOnly = true)
    fun get(
        workspaceId: UUID,
        requestedBy: UUID
    ): Map<String, String> {
        if (!workspaceService.hasAccess(workspaceId, requestedBy)) {
            throw AccessDeniedException("User has no access to workspace $workspaceId")
        }
        return repository
            .findById(workspaceId)
            .map { it.colorToLabel }
            .orElse(emptyMap())
    }

    @Transactional
    fun put(
        workspaceId: UUID,
        colorToLabel: Map<String, String>,
        requestedBy: UUID
    ): Map<String, String> {
        if (!workspaceService.canEdit(workspaceId, requestedBy)) {
            throw AccessDeniedException("User cannot edit workspace $workspaceId")
        }

        // Validate: keys must be in the allowed palette, values are
        // trimmed and capped at 64 chars; empty values delete the entry.
        val sanitized =
            colorToLabel
                .filterKeys { it in allowedColors }
                .mapValues { (_, label) -> label.trim().take(64) }
                .filterValues { it.isNotEmpty() }

        val existing = repository.findById(workspaceId).orElse(null)
        val now = OffsetDateTime.now()
        val saved =
            if (existing == null) {
                repository.save(AnnotationColorSemantics(workspaceId = workspaceId, colorToLabel = sanitized, createdAt = now, updatedAt = now))
            } else {
                existing.colorToLabel = sanitized
                existing.updatedAt = now
                repository.save(existing)
            }
        return saved.colorToLabel
    }
}
