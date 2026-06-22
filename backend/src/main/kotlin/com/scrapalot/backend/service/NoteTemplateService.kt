package com.scrapalot.backend.service

import com.scrapalot.backend.domain.notes.NoteTemplate
import com.scrapalot.backend.repository.NoteTemplateRepository
import mu.KotlinLogging
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.NoSuchElementException
import java.util.UUID

private val logger = KotlinLogging.logger {}

@Service
@Transactional
class NoteTemplateService(
    private val noteTemplateRepository: NoteTemplateRepository,
    private val workspaceService: WorkspaceService,
) {
    @Transactional(readOnly = true)
    fun listForUser(
        userId: UUID,
        workspaceId: UUID?
    ): List<NoteTemplate> =
        if (workspaceId != null) {
            noteTemplateRepository.findVisibleToUser(userId, workspaceId)
        } else {
            noteTemplateRepository.findByUserIdOrderByUpdatedAtDesc(userId)
        }

    @Transactional(readOnly = true)
    fun findById(id: UUID): NoteTemplate? = noteTemplateRepository.findById(id).orElse(null)

    /**
     * Persist a new user template. Workspace permission is enforced when
     * the caller scoped the template to one.
     */
    fun create(
        userId: UUID,
        workspaceId: UUID?,
        name: String,
        description: String?,
        category: String?,
        expectedWordCount: String?,
        icon: String?,
        skeleton: String,
        defaultResearchContext: Map<String, Any?>?,
    ): NoteTemplate {
        if (workspaceId != null && !workspaceService.hasAccess(workspaceId, userId)) {
            throw IllegalArgumentException("User does not have access to this workspace")
        }
        val template =
            NoteTemplate(
                userId = userId,
                workspaceId = workspaceId,
                name = name.trim(),
                description = description?.trim()?.takeIf { it.isNotEmpty() },
                category = category?.takeIf { it.isNotEmpty() },
                expectedWordCount = expectedWordCount?.takeIf { it.isNotEmpty() },
                icon = icon?.takeIf { it.isNotEmpty() },
                skeleton = skeleton,
                defaultResearchContext = defaultResearchContext,
            )
        val saved = noteTemplateRepository.save(template)
        logger.info { "Created note template: id=${saved.id} user=$userId workspace=$workspaceId name=$name" }
        return saved
    }

    fun delete(
        id: UUID,
        userId: UUID
    ) {
        val template =
            noteTemplateRepository.findById(id).orElseThrow {
                NoSuchElementException("Template not found: $id")
            }
        if (template.userId != userId) {
            throw IllegalArgumentException("Only the template owner can delete it")
        }
        noteTemplateRepository.delete(template)
    }
}
