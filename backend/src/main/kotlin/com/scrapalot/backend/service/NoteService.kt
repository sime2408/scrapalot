package com.scrapalot.backend.service

import com.scrapalot.backend.domain.notes.Note
import com.scrapalot.backend.domain.notes.NoteComment
import com.scrapalot.backend.domain.notes.NoteShare
import com.scrapalot.backend.domain.notes.NoteVersion
import com.scrapalot.backend.repository.NoteCommentRepository
import com.scrapalot.backend.repository.NoteRepository
import com.scrapalot.backend.repository.NoteShareRepository
import com.scrapalot.backend.repository.NoteVersionRepository
import com.scrapalot.backend.utils.orThrow
import mu.KotlinLogging
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.NoSuchElementException
import java.util.UUID

private val logger = KotlinLogging.logger {}

@Service
@Transactional
class NoteService(
    private val noteRepository: NoteRepository,
    private val noteVersionRepository: NoteVersionRepository,
    private val noteShareRepository: NoteShareRepository,
    private val noteCommentRepository: NoteCommentRepository,
    private val noteImageStore: NoteImageStore,
    private val workspaceService: WorkspaceService
) {
    @Transactional(readOnly = true)
    fun findById(id: UUID): Note? = noteRepository.findById(id).orElse(null)

    @Transactional(readOnly = true)
    fun findAccessibleNotes(
        workspaceId: UUID,
        userId: UUID
    ): List<Note> = noteRepository.findAccessibleNotes(workspaceId, userId)

    /**
     * Paginated category-scoped lookup for the Datoteka → Otvori dialog.
     * @param category  "academic" / "writing" / "social" / "personal" / "review" /
     *                  "uncategorized" / null (all categories).
     * @param q         optional title substring filter.
     */
    @Transactional(readOnly = true)
    fun findAccessibleNotesByCategory(
        workspaceId: UUID,
        userId: UUID,
        category: String?,
        q: String?,
        pageable: org.springframework.data.domain.Pageable
    ): org.springframework.data.domain.Page<Note> {
        val matchUncategorized = category == "uncategorized"
        val normalized = if (matchUncategorized) null else category
        return noteRepository.findAccessibleNotesByCategory(
            workspaceId = workspaceId,
            userId = userId,
            category = normalized,
            matchUncategorized = matchUncategorized,
            q = q,
            pageable = pageable
        )
    }

    @Transactional(readOnly = true)
    fun searchByTitle(
        workspaceId: UUID,
        query: String
    ): List<Note> = noteRepository.searchByTitle(workspaceId, query)

    @Transactional(readOnly = true)
    fun findByDocumentId(
        documentId: String,
        userId: UUID
    ): List<Note> = noteRepository.findByDocumentIdAndUserId(documentId, userId)

    fun createNote(
        title: String,
        content: String?,
        workspaceId: UUID,
        userId: UUID,
        noteType: String = "markdown",
        tags: List<String>? = null,
        sessionId: UUID? = null,
        documentId: String? = null,
        category: String? = null,
        isPublic: Boolean = false,
        isPinned: Boolean = false
    ): Note {
        // Validate workspace access
        if (!workspaceService.hasAccess(workspaceId, userId)) {
            throw IllegalArgumentException("User does not have access to this workspace")
        }

        val note =
            Note(
                title = title,
                content = content,
                noteType = noteType,
                tags = tags,
                workspaceId = workspaceId,
                userId = userId,
                sessionId = sessionId,
                documentId = documentId,
                category = category,
                isPublic = isPublic,
                isPinned = isPinned,
                createdAt = Instant.now(),
                updatedAt = Instant.now()
            )

        val saved = noteRepository.save(note)

        // Create initial version
        createVersion(saved.id.orThrow("SavedNote"), userId, content ?: "", "Initial version")

        logger.info { "Created note: ${saved.id} in workspace: $workspaceId" }
        return saved
    }

    /**
     * Overwrite the Research Context JSON blob on
     * a note. Pass `context = null` to clear the field entirely. No
     * merge; the frontend reconciles shape because the blob schema
     * evolves faster than a server bump can keep up with.
     */
    fun setResearchContext(
        noteId: UUID,
        userId: UUID,
        context: Map<String, Any?>?,
    ): Note {
        val note =
            noteRepository.findById(noteId).orElseThrow {
                NoSuchElementException("Note not found: $noteId")
            }
        if (!canEdit(noteId, userId)) {
            throw IllegalArgumentException("User does not have permission to edit this note")
        }
        val updated =
            note.copy(
                researchContext = context,
                updatedAt = Instant.now(),
            )
        return noteRepository.save(updated)
    }

    fun updateNote(
        noteId: UUID,
        userId: UUID,
        title: String? = null,
        content: String? = null,
        tags: List<String>? = null,
        category: String? = null,
        isPinned: Boolean? = null,
        createVersion: Boolean = true,
        emoji: String? = null,
        status: String? = null,
        headerImageUrl: String? = null,
        fontScale: String? = null,
    ): Note {
        val note =
            noteRepository.findById(noteId).orElseThrow {
                NoSuchElementException("Note not found: $noteId")
            }

        // Check permissions
        if (!canEdit(noteId, userId)) {
            throw IllegalArgumentException("User does not have permission to edit this note")
        }

        // Tri-state for the page-head columns:
        //   null  → keep current value
        //   ""    → clear (set to null in DB)
        //   else  → set to the supplied value
        // null/empty body fields preserve, explicit "" clears — matches the
        // pattern in UpdateNoteRequest where the regex allows "" alongside
        // the predefined enum.
        fun resolvePageHead(
            incoming: String?,
            current: String?
        ): String? =
            when {
                incoming == null -> current
                incoming.isBlank() -> null
                else -> incoming
            }

        val updated =
            note.copy(
                title = title ?: note.title,
                content = content ?: note.content,
                tags = tags ?: note.tags,
                category = category ?: note.category,
                isPinned = isPinned ?: note.isPinned,
                emoji = resolvePageHead(emoji, note.emoji),
                status = resolvePageHead(status, note.status),
                headerImageUrl = resolvePageHead(headerImageUrl, note.headerImageUrl),
                fontScale = resolvePageHead(fontScale, note.fontScale),
                updatedAt = Instant.now()
            )

        val saved = noteRepository.save(updated)

        // Create version if content changed and requested
        if (createVersion && content != null && content != note.content) {
            val maxVersion = noteVersionRepository.findMaxVersionNumber(noteId) ?: 0
            createVersion(noteId, userId, content, "Version ${maxVersion + 1}")
        }

        // Delete image files that disappeared from the note content.
        // Source of truth is the HTML itself — no tracking table.
        if (content != null && content != note.content) {
            noteImageStore.deleteRemoved(previousHtml = note.content, currentHtml = content)
        }

        logger.info { "Updated note: $noteId" }
        return saved
    }

    fun deleteNote(
        noteId: UUID,
        userId: UUID
    ) {
        val note =
            noteRepository.findById(noteId).orElseThrow {
                NoSuchElementException("Note not found: $noteId")
            }

        // Only owner can delete
        if (note.userId != userId) {
            throw IllegalArgumentException("Only the note owner can delete it")
        }

        // Delete associated data
        noteVersionRepository.deleteByNoteId(noteId)
        noteShareRepository.deleteByNoteId(noteId)
        noteCommentRepository.deleteByNoteId(noteId)

        // Delete any image files referenced by the current HTML. Runs
        // before noteRepository.deleteById so `note.content` is still
        // the authoritative source of the filenames to remove.
        noteImageStore.deleteAllInContent(note.content)

        noteRepository.deleteById(noteId)
        logger.info { "Deleted note: $noteId" }
    }

    private fun createVersion(
        noteId: UUID,
        userId: UUID,
        content: String,
        changeSummary: String
    ): NoteVersion {
        val versionNumber = (noteVersionRepository.findMaxVersionNumber(noteId) ?: 0) + 1

        val version =
            NoteVersion(
                noteId = noteId,
                userId = userId,
                versionNumber = versionNumber,
                content = content,
                changeSummary = changeSummary,
                createdAt = Instant.now()
            )

        return noteVersionRepository.save(version)
    }

    @Transactional(readOnly = true)
    fun getVersions(noteId: UUID): List<NoteVersion> = noteVersionRepository.findByNoteIdOrderByVersionNumberDesc(noteId)

    fun restoreVersion(
        noteId: UUID,
        versionId: UUID,
        userId: UUID
    ): Note {
        val version =
            noteVersionRepository.findById(versionId).orElseThrow {
                NoSuchElementException("Version not found: $versionId")
            }

        if (version.noteId != noteId) {
            throw IllegalArgumentException("Version does not belong to this note")
        }

        // 7.9 — capture the CURRENT state as a 'restore'-kind snapshot
        // BEFORE overwriting, so the user can undo the restore. This
        // also gives the UI an anchor to render "Restored from
        // version X" once it walks the parent_version_id chain.
        val current =
            noteRepository.findById(noteId).orElseThrow {
                NoSuchElementException("Note not found: $noteId")
            }
        if (current.content != version.content) {
            val maxVersion = noteVersionRepository.findMaxVersionNumber(noteId) ?: 0
            noteVersionRepository.save(
                NoteVersion(
                    noteId = noteId,
                    userId = userId,
                    versionNumber = maxVersion + 1,
                    content = current.content ?: "",
                    changeSummary = "Pre-restore snapshot",
                    kind = "restore",
                    parentVersionId = versionId,
                    createdAt = Instant.now()
                )
            )
        }

        return updateNote(noteId, userId, content = version.content, createVersion = true)
    }

    /** 7.9 — create an explicit named version of the current note state.
     *  Differs from the implicit auto-snapshot taken on every update in
     *  that the user supplies a short label and optional message; these
     *  are surfaced in the versions sidebar so the writer can navigate
     *  meaningful save-points instead of every keystroke-coalesced
     *  auto entry. */
    fun saveNamedVersion(
        noteId: UUID,
        userId: UUID,
        label: String,
        message: String?
    ): NoteVersion {
        val note =
            noteRepository.findById(noteId).orElseThrow {
                NoSuchElementException("Note not found: $noteId")
            }
        val versionNumber = (noteVersionRepository.findMaxVersionNumber(noteId) ?: 0) + 1
        val version =
            NoteVersion(
                noteId = noteId,
                userId = userId,
                versionNumber = versionNumber,
                content = note.content ?: "",
                changeSummary = label,
                kind = "named",
                label = label,
                message = message,
                createdAt = Instant.now()
            )
        return noteVersionRepository.save(version)
    }

    fun shareNote(
        noteId: UUID,
        targetUserId: UUID,
        permission: String,
        currentUserId: UUID
    ): NoteShare {
        val note =
            noteRepository.findById(noteId).orElseThrow {
                NoSuchElementException("Note not found: $noteId")
            }

        // Only owner can share
        if (note.userId != currentUserId) {
            throw IllegalArgumentException("Only the note owner can share it")
        }

        val existing = noteShareRepository.findByNoteIdAndUserId(noteId, targetUserId)
        if (existing != null) {
            val updated = existing.copy(permission = permission, updatedAt = Instant.now())
            return noteShareRepository.save(updated)
        }

        val share =
            NoteShare(
                noteId = noteId,
                userId = targetUserId,
                permission = permission,
                createdAt = Instant.now(),
                updatedAt = Instant.now()
            )

        logger.info { "Shared note: $noteId with user: $targetUserId, permission: $permission" }
        return noteShareRepository.save(share)
    }

    fun removeShare(
        noteId: UUID,
        targetUserId: UUID,
        currentUserId: UUID
    ) {
        val note =
            noteRepository.findById(noteId).orElseThrow {
                NoSuchElementException("Note not found: $noteId")
            }

        if (note.userId != currentUserId) {
            throw IllegalArgumentException("Only the note owner can remove sharing")
        }

        noteShareRepository.deleteByNoteIdAndUserId(noteId, targetUserId)
        logger.info { "Removed share for note: $noteId from user: $targetUserId" }
    }

    fun addComment(
        noteId: UUID,
        userId: UUID,
        content: String,
        parentCommentId: UUID? = null
    ): NoteComment {
        noteRepository.findById(noteId).orElseThrow {
            NoSuchElementException("Note not found: $noteId")
        }

        // Check if user has access to note
        if (!canView(noteId, userId)) {
            throw IllegalArgumentException("User does not have access to this note")
        }

        val comment =
            NoteComment(
                noteId = noteId,
                userId = userId,
                parentCommentId = parentCommentId,
                content = content,
                isResolved = false,
                createdAt = Instant.now(),
                updatedAt = Instant.now()
            )

        logger.info { "Added comment to note: $noteId by user: $userId" }
        return noteCommentRepository.save(comment)
    }

    fun updateComment(
        commentId: UUID,
        noteId: UUID,
        userId: UUID,
        content: String
    ): NoteComment {
        val comment =
            noteCommentRepository.findById(commentId).orElseThrow {
                NoSuchElementException("Comment not found: $commentId")
            }

        if (comment.noteId != noteId) {
            throw NoSuchElementException("Comment not found in this note")
        }

        if (comment.userId != userId) {
            throw SecurityException("Only the comment creator can update it")
        }

        val updated = comment.copy(content = content, updatedAt = Instant.now())
        logger.info { "Updated comment: $commentId on note: $noteId" }
        return noteCommentRepository.save(updated)
    }

    fun deleteComment(
        commentId: UUID,
        noteId: UUID,
        userId: UUID
    ) {
        val comment =
            noteCommentRepository.findById(commentId).orElseThrow {
                NoSuchElementException("Comment not found: $commentId")
            }

        if (comment.noteId != noteId) {
            throw NoSuchElementException("Comment not found in this note")
        }

        val note =
            noteRepository.findById(noteId).orElseThrow {
                NoSuchElementException("Note not found: $noteId")
            }

        // Comment creator or note owner can delete
        if (comment.userId != userId && note.userId != userId) {
            throw SecurityException("Only the comment creator or note owner can delete it")
        }

        noteCommentRepository.deleteById(commentId)
        logger.info { "Deleted comment: $commentId from note: $noteId" }
    }

    fun resolveComment(
        commentId: UUID,
        @Suppress("UNUSED_PARAMETER") userId: UUID
    ): NoteComment {
        val comment =
            noteCommentRepository.findById(commentId).orElseThrow {
                NoSuchElementException("Comment not found: $commentId")
            }

        val updated = comment.copy(isResolved = !comment.isResolved, updatedAt = Instant.now())
        return noteCommentRepository.save(updated)
    }

    @Transactional(readOnly = true)
    fun getComments(noteId: UUID): List<NoteComment> = noteCommentRepository.findByNoteIdOrderByCreatedAtAsc(noteId)

    private fun canView(
        noteId: UUID,
        userId: UUID
    ): Boolean {
        val note = noteRepository.findById(noteId).orElse(null) ?: return false

        // Owner can always view
        if (note.userId == userId) return true

        // Public notes can be viewed by anyone with workspace access
        if (note.isPublic && workspaceService.hasAccess(note.workspaceId, userId)) return true

        // Check if note is shared with user
        return noteShareRepository.existsByNoteIdAndUserId(noteId, userId)
    }

    private fun canEdit(
        noteId: UUID,
        userId: UUID
    ): Boolean {
        val note = noteRepository.findById(noteId).orElse(null) ?: return false

        // Owner can always edit
        if (note.userId == userId) return true

        // Check if user has write permission via share
        val share = noteShareRepository.findByNoteIdAndUserId(noteId, userId)
        return share?.permission in listOf("write", "owner")
    }
}
