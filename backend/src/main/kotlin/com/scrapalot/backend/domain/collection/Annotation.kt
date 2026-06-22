package com.scrapalot.backend.domain.collection

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

/**
 * Document annotation entity — highlights, notes, and underlines on PDF/EPUB documents.
 *
 * Annotation types:
 *   1 = highlight (text selection with color)
 *   2 = note (comment anchored to a page position)
 *   3 = underline (text selection rendered as underline)
 *   4 = area capture (rectangular region screenshot)
 *   5 = strikethrough (text selection rendered with horizontal strike line)
 *
 * Viewer types:
 *   "pdf"  — position_json contains percentage-based rects
 *   "epub" — position_json contains CFI (Canonical Fragment Identifier)
 *
 * Colors (8-color palette):
 *   #ffd400 (yellow), #ff6666 (red), #5fb236 (green), #2ea8e5 (blue),
 *   #a28ae5 (purple), #e56eee (magenta), #f19837 (orange), #aaaaaa (gray)
 */
@Entity
@Table(name = "annotations", schema = "scrapalot")
data class Annotation(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    @Column(name = "document_id", nullable = false, columnDefinition = "uuid")
    var documentId: UUID,
    @Column(name = "collection_id", nullable = false, columnDefinition = "uuid")
    var collectionId: UUID,
    @Column(name = "session_id", columnDefinition = "uuid")
    var sessionId: UUID? = null,
    @Column(name = "annotation_type", nullable = false)
    var annotationType: Short = 1,
    @Column(name = "selected_text", columnDefinition = "TEXT")
    var selectedText: String? = null,
    @Column(columnDefinition = "TEXT")
    var comment: String? = null,
    @Column(nullable = false, length = 7)
    var color: String = "#ffd400",
    @Column(name = "page_label", length = 50)
    var pageLabel: String? = null,
    @Column(name = "sort_index", length = 50)
    var sortIndex: String? = null,
    @Column(name = "position_json", nullable = false, columnDefinition = "TEXT")
    var positionJson: String,
    @Column(name = "viewer_type", nullable = false, length = 10)
    var viewerType: String = "pdf",
    @Column(name = "tag_ids", columnDefinition = "TEXT")
    var tagIds: String? = null,
    @Column(name = "is_external", nullable = false)
    @get:JvmName("getIsExternalAnnotation")
    var isExternal: Boolean = false,
    @Column(name = "is_pinned", nullable = false)
    @get:JvmName("getIsPinnedAnnotation")
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
        if (other !is Annotation) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "Annotation(id=$id, type=$annotationType, color='$color', viewerType='$viewerType', documentId=$documentId)"
}
