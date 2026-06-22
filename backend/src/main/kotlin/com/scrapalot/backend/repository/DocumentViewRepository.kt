package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.document.DocumentView
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.time.Instant
import java.util.UUID

interface RecentDocumentRow {
    fun getDocumentId(): UUID

    fun getCollectionId(): UUID?

    fun getLastViewedAt(): Instant

    fun getSource(): String
}

@Repository
interface DocumentViewRepository : JpaRepository<DocumentView, UUID> {
    /** Most recent unique documents per user.
     *  Native SQL because Spring Data JPQL can't easily express the
     *  per-document MAX(viewed_at) deduplication with arbitrary
     *  passthrough columns. */
    @Query(
        nativeQuery = true,
        value = """
            SELECT
              v.document_id   AS documentId,
              v.collection_id AS collectionId,
              v.viewed_at     AS lastViewedAt,
              v.source        AS source
            FROM scrapalot.document_views v
            INNER JOIN (
              SELECT document_id, MAX(viewed_at) AS max_viewed_at
              FROM scrapalot.document_views
              WHERE user_id = :userId
              GROUP BY document_id
            ) latest
              ON v.document_id = latest.document_id
              AND v.viewed_at  = latest.max_viewed_at
            WHERE v.user_id = :userId
            ORDER BY v.viewed_at DESC
            LIMIT :limit
        """,
    )
    fun findRecentForUser(
        @Param("userId") userId: UUID,
        @Param("limit") limit: Int,
    ): List<RecentDocumentRow>

    /** Coalescing helper: return the most-recent view of (user, document, source)
     *  to support the 5-minute throttle in the service layer. */
    @Query(
        """
            SELECT v FROM DocumentView v
            WHERE v.userId = :userId
              AND v.documentId = :documentId
              AND v.source = :source
            ORDER BY v.viewedAt DESC
        """,
    )
    fun findLatestForKey(
        @Param("userId") userId: UUID,
        @Param("documentId") documentId: UUID,
        @Param("source") source: String,
    ): List<DocumentView>

    /** Purge all view rows for a deleted document.
     *  document_views has no FK to scrapalot.documents (the docs live in
     *  Python's DB), so deletion must be invoked explicitly from the
     *  document delete flow — otherwise stale entries linger in every
     *  user's "Recent" list. */
    @Modifying
    @Query("DELETE FROM DocumentView v WHERE v.documentId = :documentId")
    fun deleteByDocumentId(
        @Param("documentId") documentId: UUID
    ): Int

    /** Remove a single user's "Recent" entries for one document. Used by
     *  the sidebar's per-row dismiss action. The user only ever sees
     *  one row per (document_id, source) so dropping every variant for
     *  that document is the right behaviour — the next view re-adds it. */
    @Modifying
    @Query("DELETE FROM DocumentView v WHERE v.userId = :userId AND v.documentId = :documentId")
    fun deleteByUserIdAndDocumentId(
        @Param("userId") userId: UUID,
        @Param("documentId") documentId: UUID,
    ): Int
}
