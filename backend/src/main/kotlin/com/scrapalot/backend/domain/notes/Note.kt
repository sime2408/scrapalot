package com.scrapalot.backend.domain.notes

import jakarta.persistence.*
import org.hibernate.annotations.JdbcTypeCode
import org.hibernate.annotations.UuidGenerator
import org.hibernate.type.SqlTypes
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "notes", schema = "scrapalot")
data class Note(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(nullable = false, length = 255)
    var title: String,
    @Column(columnDefinition = "TEXT")
    var content: String? = null,
    @Column(name = "note_type", nullable = false, length = 50)
    var noteType: String = "markdown",
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    var tags: List<String>? = null,
    @Column(name = "workspace_id", nullable = false, columnDefinition = "uuid")
    var workspaceId: UUID,
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    @Column(name = "session_id", nullable = true, columnDefinition = "uuid")
    var sessionId: UUID? = null,
    @Column(name = "document_id", nullable = true, length = 36)
    var documentId: String? = null,
    @Column(name = "category", nullable = true, length = 32)
    var category: String? = null,
    // Migration 116 — Confluence-style page-head metadata. Surfaced by the
    // toolbar that appears above the H1 on hover (md/lg screens) and by the
    // metadata row rendered just below the title.
    @Column(name = "emoji", nullable = true, length = 16)
    var emoji: String? = null,
    /** One of: draft, in_progress, in_review, done, blocked, on_hold. */
    @Column(name = "status", nullable = true, length = 32)
    var status: String? = null,
    @Column(name = "header_image_url", nullable = true, columnDefinition = "TEXT")
    var headerImageUrl: String? = null,
    /** One of: small, default, large, xlarge. Controls the editor root font scale. */
    @Column(name = "font_scale", nullable = true, length = 16)
    var fontScale: String? = null,
    // Server-side persistence for the Research
    // Context pill. Shape is intentionally loose JSONB (fronted by a
    // Map<String, Any?>) so the NoteResearchContext TypeScript type
    // can evolve without a schema bump.
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "research_context", columnDefinition = "jsonb")
    var researchContext: Map<String, Any?>? = null,
    @Column(name = "is_public", nullable = false)
    @get:JvmName("getIsPublicNote")
    var isPublic: Boolean = false,
    @Column(name = "is_pinned", nullable = false)
    @get:JvmName("getIsPinnedNote")
    var isPinned: Boolean = false,
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant = Instant.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: Instant = Instant.now()
) {
    @PreUpdate
    fun onUpdate() {
        updatedAt = Instant.now()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Note) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "Note(id=$id, title='$title', noteType='$noteType', workspaceId=$workspaceId, userId=$userId)"
}
