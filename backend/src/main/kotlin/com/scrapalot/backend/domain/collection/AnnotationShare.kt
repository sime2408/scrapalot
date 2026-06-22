package com.scrapalot.backend.domain.collection

import jakarta.persistence.*
import java.io.Serializable
import java.time.Instant
import java.util.UUID

/**
 * Multi-user annotation sharing — grants another user access to an
 * annotation on a PDF/EPUB document. The owner of the annotation is
 * identified through the `annotations.user_id` column; this entity
 * stores the recipient (`userId`) and the permission level.
 *
 * Primary key is composite (annotation_id, user_id) — same shape as
 * `note_shares` (migration 021).
 *
 * Permissions:
 *   read   recipient sees the annotation in shared-with-me feeds
 *   write  recipient may patch comment / color (selected_text and
 *          position remain owner-only)
 */
@Entity
@Table(name = "annotation_shares", schema = "scrapalot")
@IdClass(AnnotationShareId::class)
data class AnnotationShare(
    @Id
    @Column(name = "annotation_id", nullable = false, columnDefinition = "uuid")
    var annotationId: UUID,
    @Id
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    @Column(nullable = false, length = 20)
    var permission: String = "read",
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant = Instant.now()
) {
    override fun toString(): String = "AnnotationShare(annotationId=$annotationId, userId=$userId, permission='$permission')"
}

data class AnnotationShareId(
    var annotationId: UUID = UUID.randomUUID(),
    var userId: UUID = UUID.randomUUID()
) : Serializable
