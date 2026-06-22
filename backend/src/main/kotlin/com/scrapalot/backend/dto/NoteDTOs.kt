package com.scrapalot.backend.dto

import jakarta.validation.constraints.*
import java.util.UUID

// Note Response
data class NoteResponse(
    val id: UUID,
    val title: String,
    val content: String?,
    val noteType: String,
    val tags: List<String>?,
    val workspaceId: UUID,
    val userId: UUID,
    val sessionId: UUID?,
    val documentId: String?,
    /** One of academic/writing/social/personal/review, or null = uncategorized. */
    val category: String?,
    val isPublic: Boolean,
    val isPinned: Boolean,
    /** Migration 116 — page-head emoji rendered next to the H1 title. */
    val emoji: String?,
    /** Migration 116 — draft|in_progress|in_review|done|blocked|on_hold. */
    val status: String?,
    /** Migration 116 — banner image URL shown above the title. */
    val headerImageUrl: String?,
    /** Migration 116 — small|default|large|xlarge editor font scale. */
    val fontScale: String?,
    val createdAt: String,
    val updatedAt: String
)

/** Paginated notes list for the Datoteka → Otvori dialog. */
data class PaginatedNotesResponse(
    val items: List<NoteResponse>,
    val page: Int,
    val pageSize: Int,
    val total: Long
)

// Create Note Request
@Suppress("JpaImmutableNotNullablePropertyInspection") // DTO, not a JPA entity — val fields with @NotNull are intentional
data class CreateNoteRequest(
    @field:NotBlank(message = "Note title is required")
    @field:Size(min = 1, max = 255, message = "Note title must be between 1 and 255 characters")
    val title: String,
    @field:Size(max = 1000000, message = "Content cannot exceed 1MB")
    val content: String? = null,
    @field:NotNull(message = "Workspace ID is required")
    val workspaceId: UUID,
    @field:Pattern(regexp = "^(markdown|text|rich)$", message = "Note type must be 'markdown', 'text', or 'rich'")
    val noteType: String = "markdown",
    @field:Size(max = 20, message = "Cannot have more than 20 tags")
    val tags: List<
        @Size(max = 50, message = "Tag cannot exceed 50 characters")
        String
    >? = null,
    val sessionId: UUID? = null,
    val documentId: String? = null,
    @field:Pattern(
        regexp = "^(academic|writing|social|personal|review)$",
        message = "Category must be one of: academic, writing, social, personal, review"
    )
    val category: String? = null,
    val isPublic: Boolean = false,
    val isPinned: Boolean = false
)

// Update Note Request
data class UpdateNoteRequest(
    @field:Size(min = 1, max = 255, message = "Note title must be between 1 and 255 characters")
    val title: String? = null,
    @field:Size(max = 1000000, message = "Content cannot exceed 1MB")
    val content: String? = null,
    @field:Size(max = 20, message = "Cannot have more than 20 tags")
    val tags: List<
        @Size(max = 50, message = "Tag cannot exceed 50 characters")
        String
    >? = null,
    @field:Pattern(
        regexp = "^(academic|writing|social|personal|review)$",
        message = "Category must be one of: academic, writing, social, personal, review"
    )
    val category: String? = null,
    val isPinned: Boolean? = null,
    val createVersion: Boolean = true,
    // Migration 116 — page-head metadata. All four fields use the
    // tri-state convention shared with the rest of this DTO:
    //   - field omitted (JSON missing)  → keep current value
    //   - field = ""                    → clear (set to null)
    //   - field = "<value>"             → set to that value
    // The service layer collapses "" → null after validation.
    @field:Size(max = 16, message = "Emoji must be ≤ 16 characters")
    val emoji: String? = null,
    @field:Pattern(
        regexp = "^(|draft|in_progress|in_review|done|blocked|on_hold)$",
        message = "Status must be one of: draft, in_progress, in_review, done, blocked, on_hold"
    )
    val status: String? = null,
    @field:Size(max = 2048, message = "Header image URL must be ≤ 2048 characters")
    val headerImageUrl: String? = null,
    @field:Pattern(
        regexp = "^(|small|default|large|xlarge)$",
        message = "Font scale must be one of: small, default, large, xlarge"
    )
    val fontScale: String? = null
)

// Note Version Response
data class NoteVersionResponse(
    val id: UUID,
    val noteId: UUID,
    val userId: UUID,
    val versionNumber: Int,
    val content: String,
    val changeSummary: String,
    val createdAt: String,
    /** 7.9 — `auto` | `named` | `restore` */
    val kind: String = "auto",
    val label: String? = null,
    val message: String? = null,
    val parentVersionId: UUID? = null
)

/** 7.9 — body for POST /notes/{id}/versions/save-named. Label is
 *  required because the named-save action exists exactly to give the
 *  user something to navigate by; message is optional commit text. */
@Suppress("JpaImmutableNotNullablePropertyInspection")
data class SaveNamedVersionRequest(
    @field:NotBlank(message = "Label is required")
    @field:Size(max = 120, message = "Label must be ≤ 120 characters")
    val label: String,
    @field:Size(max = 4000, message = "Message must be ≤ 4000 characters")
    val message: String? = null
)

// Share Note Request
@Suppress("JpaImmutableNotNullablePropertyInspection") // DTO, not a JPA entity — val fields with @NotNull are intentional
data class ShareNoteRequest(
    @field:NotNull(message = "User ID is required")
    val userId: UUID,
    @field:NotBlank(message = "Permission is required")
    @field:Pattern(regexp = "^(read|write|owner)$", message = "Permission must be 'read', 'write', or 'owner'")
    val permission: String = "read"
)

// Note Comment Response
data class NoteCommentResponse(
    val id: UUID,
    val noteId: UUID,
    val userId: UUID,
    val parentCommentId: UUID?,
    val content: String,
    val isResolved: Boolean,
    val createdAt: String,
    val updatedAt: String
)

// Create Comment Request
data class CreateCommentRequest(
    @field:NotBlank(message = "Comment content is required")
    @field:Size(min = 1, max = 10000, message = "Comment must be between 1 and 10000 characters")
    val content: String,
    val parentCommentId: UUID? = null
)

// Update Comment Request
data class UpdateCommentRequest(
    @field:NotBlank(message = "Comment content is required")
    @field:Size(min = 1, max = 10000, message = "Comment must be between 1 and 10000 characters")
    val content: String
)

// Note Image Response
data class NoteImageResponse(
    val url: String,
    val filename: String
)

// Collaboration Cleared Response
data class CollaborationClearedResponse(
    val success: Boolean,
    val message: String
)

// Migration 117 — note reactions
@Suppress("JpaImmutableNotNullablePropertyInspection")
data class AddReactionRequest(
    @field:NotBlank(message = "Emoji is required")
    @field:Size(max = 32, message = "Emoji must be ≤ 32 characters")
    val emoji: String,
)

data class NoteReactionResponse(
    val id: UUID,
    val noteId: UUID,
    val userId: UUID,
    val emoji: String,
    val createdAt: String,
)

/** Aggregated chip view — the meta row renders the emoji + count and
 *  highlights the chip if includesViewer is true. */
data class NoteReactionGroupResponse(
    val emoji: String,
    val count: Int,
    val userIds: List<UUID>,
    val includesViewer: Boolean,
)

// Note Share Response
data class NoteShareResponse(
    val id: UUID,
    val noteId: UUID,
    val userId: UUID,
    val permission: String,
    val createdAt: String,
    val updatedAt: String
)
