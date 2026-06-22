package com.scrapalot.backend.domain.notes

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.GeneratedValue
import jakarta.persistence.Id
import jakarta.persistence.PreUpdate
import jakarta.persistence.Table
import org.hibernate.annotations.JdbcTypeCode
import org.hibernate.annotations.UuidGenerator
import org.hibernate.type.SqlTypes
import java.time.Instant
import java.util.UUID

/**
 * User-created note template. Persists what the Notes editor's
 * "Save as new template" menu item saves. System templates (IMRaD,
 * Peer review, etc.) live in the frontend catalog (see
 * `scrapalot-ui/src/lib/note-templates-catalog.ts`) — migrating them
 * into this table is a follow-up.
 */
@Entity
@Table(name = "note_templates", schema = "scrapalot")
data class NoteTemplate(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    // null = visible across all of the user's workspaces
    @Column(name = "workspace_id", nullable = true, columnDefinition = "uuid")
    var workspaceId: UUID? = null,
    @Column(nullable = false, length = 255)
    var name: String,
    @Column(columnDefinition = "TEXT")
    var description: String? = null,
    @Column(length = 32)
    var category: String? = null,
    @Column(name = "expected_word_count", length = 32)
    var expectedWordCount: String? = null,
    @Column(length = 64)
    var icon: String? = null,
    @Column(nullable = false, columnDefinition = "TEXT")
    var skeleton: String,
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "default_research_context", columnDefinition = "jsonb")
    var defaultResearchContext: Map<String, Any?>? = null,
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant = Instant.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: Instant = Instant.now(),
) {
    @PreUpdate
    fun onUpdate() {
        updatedAt = Instant.now()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is NoteTemplate) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0
}
