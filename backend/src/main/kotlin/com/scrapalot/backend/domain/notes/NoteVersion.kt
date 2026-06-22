package com.scrapalot.backend.domain.notes

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "note_versions", schema = "scrapalot")
data class NoteVersion(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "note_id", nullable = false, columnDefinition = "uuid")
    var noteId: UUID,
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    @Column(name = "version_number", nullable = false)
    var versionNumber: Int,
    @Column(nullable = false, columnDefinition = "TEXT")
    var content: String,
    @Column(name = "change_summary", columnDefinition = "TEXT")
    var changeSummary: String? = null,
    /** 7.9 — `auto` (every successful update), `named` (explicit user
     *  save with a label / message), `restore` (auto-snapshot taken
     *  right before applying RestoreVersion). Default is `auto` so
     *  existing rows keep their semantics. */
    @Column(name = "kind", nullable = false, length = 16)
    var kind: String = "auto",
    /** 7.9 — short user-supplied tag visible in the version list,
     *  e.g. "Pre-revision draft". Null for kind='auto'. */
    @Column(name = "label", length = 120)
    var label: String? = null,
    /** 7.9 — optional commit-message-style description. */
    @Column(name = "message", columnDefinition = "TEXT")
    var message: String? = null,
    /** 7.9 — when kind='restore', this points to the version we
     *  restored TO. Lets the UI render a "Restored from version X"
     *  pill on the resulting auto-snapshot. */
    @Column(name = "parent_version_id", columnDefinition = "uuid")
    var parentVersionId: UUID? = null,
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant = Instant.now()
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is NoteVersion) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "NoteVersion(id=$id, noteId=$noteId, versionNumber=$versionNumber, userId=$userId)"
}
