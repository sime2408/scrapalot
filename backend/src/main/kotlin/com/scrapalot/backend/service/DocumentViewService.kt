package com.scrapalot.backend.service

import com.scrapalot.backend.domain.document.DocumentView
import com.scrapalot.backend.repository.DocumentViewRepository
import com.scrapalot.backend.repository.RecentDocumentRow
import mu.KotlinLogging
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Duration
import java.time.Instant
import java.util.UUID

private val logger = KotlinLogging.logger {}

/**
 * Recent Documents service.
 *
 * Throttles repeat views of the same (user, document, source) tuple
 * to one row per 5 minutes so a user pacing through a PDF doesn't
 * generate dozens of rows per session. The throttle window is on the
 * write side; reads always show the latest viewed_at via MAX().
 */
@Service
@Transactional
class DocumentViewService(
    private val repo: DocumentViewRepository,
) {
    private val throttleWindow = Duration.ofMinutes(5)

    fun recordView(
        userId: UUID,
        documentId: UUID,
        collectionId: UUID?,
        source: String,
    ): DocumentView? {
        require(source in DocumentView.VALID_SOURCES) { "Invalid source: $source" }

        // 5-minute coalescing — if we already have a row for this
        // (user, document, source) within the window, skip the insert.
        val recent = repo.findLatestForKey(userId, documentId, source).firstOrNull()
        if (recent != null && Duration.between(recent.viewedAt, Instant.now()) < throttleWindow) {
            return null
        }

        val view =
            DocumentView(
                userId = userId,
                documentId = documentId,
                collectionId = collectionId,
                source = source,
                viewedAt = Instant.now(),
            )
        val saved = repo.save(view)
        logger.debug { "Recorded view: user=$userId doc=$documentId source=$source" }
        return saved
    }

    @Transactional(readOnly = true)
    fun findRecent(
        userId: UUID,
        limit: Int = 15
    ): List<RecentDocumentRow> = repo.findRecentForUser(userId, limit.coerceIn(1, 50))

    /** Remove every "Recent" entry for a document after it's deleted.
     *  Called by [com.scrapalot.backend.controller.collection.DocumentController.deleteDocument]
     *  once the Python-side delete succeeds. */
    fun deleteAllForDocument(documentId: UUID): Int {
        val removed = repo.deleteByDocumentId(documentId)
        if (removed > 0) {
            logger.debug { "Purged $removed document_views rows for doc=$documentId" }
        }
        return removed
    }

    /** Per-user dismiss from the sidebar Recent strip. Only touches the
     *  caller's own rows so dismiss-A-for-Alice doesn't hide A for Bob.
     *  Returns the number of rows removed (0 when the doc isn't in the
     *  user's recents — treated as a successful idempotent dismiss). */
    fun dismissForUser(
        userId: UUID,
        documentId: UUID
    ): Int {
        val removed = repo.deleteByUserIdAndDocumentId(userId, documentId)
        if (removed > 0) {
            logger.debug { "Dismissed $removed document_views rows: user=$userId doc=$documentId" }
        }
        return removed
    }
}
