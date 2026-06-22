package com.scrapalot.backend.domain.document

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

/**
 * Per-user document rating (1..5).
 *
 * One row per (user, document). The (user_id, document_id) pair has a
 * unique constraint at the DB level so the API path is "upsert by
 * unique key" — see UserDocumentRatingService.upsertRating.
 *
 * Documents themselves live in the Python service (Postgres + pgvector,
 * `documents` table). This row references a document_id without an FK
 * because the cross-DB ownership pattern doesn't model FKs across
 * services — instead, ratings whose document was deleted Python-side
 * are pruned by a periodic cleanup job (TBD; out of scope for v1).
 */
@Entity
@Table(name = "user_document_ratings", schema = "scrapalot")
data class UserDocumentRating(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    @Column(name = "document_id", nullable = false, columnDefinition = "uuid")
    var documentId: UUID,
    @Column(name = "workspace_id", nullable = false, columnDefinition = "uuid")
    var workspaceId: UUID,
    /** 1..5; constrained at the DB level (CHECK rating BETWEEN 1 AND 5). */
    @Column(nullable = false)
    var rating: Short,
    @Column(length = 500)
    var notes: String? = null,
    @Column(name = "rated_at", nullable = false, updatable = false)
    var ratedAt: Instant = Instant.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: Instant = Instant.now(),
) {
    @PreUpdate
    fun onUpdate() {
        updatedAt = Instant.now()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is UserDocumentRating) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "UserDocumentRating(userId=$userId, documentId=$documentId, rating=$rating)"
}
