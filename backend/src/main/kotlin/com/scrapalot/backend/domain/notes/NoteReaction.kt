package com.scrapalot.backend.domain.notes

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

/**
 * Migration 117 — per-note emoji reactions.
 *
 * One row per (note, user, emoji). A user may attach multiple distinct
 * emoji to the same note, but the same emoji is idempotent — the
 * UNIQUE constraint enforces toggle-semantics (insert; if duplicate,
 * existing row is the toggle target).
 */
@Entity
@Table(
    name = "note_reactions",
    schema = "scrapalot",
    uniqueConstraints = [
        UniqueConstraint(
            name = "uq_note_reactions_note_user_emoji",
            columnNames = ["note_id", "user_id", "emoji"],
        ),
    ],
)
data class NoteReaction(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "note_id", nullable = false, columnDefinition = "uuid")
    var noteId: UUID,
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    @Column(nullable = false, length = 32)
    var emoji: String,
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant = Instant.now(),
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is NoteReaction) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "NoteReaction(id=$id, noteId=$noteId, userId=$userId, emoji='$emoji')"
}
