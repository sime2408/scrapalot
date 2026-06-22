package com.scrapalot.backend.domain.notes

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "note_comments", schema = "scrapalot")
data class NoteComment(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "note_id", nullable = false, columnDefinition = "uuid")
    var noteId: UUID,
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    @Column(name = "parent_comment_id", nullable = true, columnDefinition = "uuid")
    var parentCommentId: UUID? = null,
    @Column(nullable = false, columnDefinition = "TEXT")
    var content: String,
    @Column(name = "is_resolved", nullable = false)
    var isResolved: Boolean = false,
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
        if (other !is NoteComment) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "NoteComment(id=$id, noteId=$noteId, userId=$userId, isResolved=$isResolved)"
}
