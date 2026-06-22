package com.scrapalot.backend.domain.document

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

/**
 * Append-only log of document views per user.
 *
 * Each row is one touch event from one of:
 *   pdf_open / epub_open / docx_open / cited / rag_retrieved / note_linked
 *
 * Distinct rows per touch make 'most-viewed' analytics trivial; the
 * Recent endpoint deduplicates by document_id at query time using
 * MAX(viewed_at).
 */
@Entity
@Table(name = "document_views", schema = "scrapalot")
data class DocumentView(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    @Column(name = "document_id", nullable = false, columnDefinition = "uuid")
    var documentId: UUID,
    @Column(name = "collection_id", columnDefinition = "uuid")
    var collectionId: UUID? = null,
    @Column(nullable = false, length = 16)
    var source: String,
    @Column(name = "viewed_at", nullable = false, updatable = false)
    var viewedAt: Instant = Instant.now(),
) {
    companion object {
        val VALID_SOURCES = setOf("pdf_open", "epub_open", "docx_open", "cited", "rag_retrieved", "note_linked")
    }
}
