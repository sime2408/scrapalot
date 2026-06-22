package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.document.UserDocumentRating
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.stereotype.Repository
import java.util.UUID

@Repository
interface UserDocumentRatingRepository : JpaRepository<UserDocumentRating, UUID> {
    /** Primary lookup for the rating widget. */
    fun findByUserIdAndDocumentId(
        userId: UUID,
        documentId: UUID
    ): UserDocumentRating?

    /** Used by the library view to bulk-load ratings for the user's
     *  current page of documents in one query. */
    fun findAllByUserIdAndDocumentIdIn(
        userId: UUID,
        documentIds: List<UUID>
    ): List<UserDocumentRating>

    /** When the user explicitly clears their rating via the UI's
     *  toggle-off (clicking the same star twice) we delete the row
     *  rather than store a sentinel value. */
    fun deleteByUserIdAndDocumentId(
        userId: UUID,
        documentId: UUID
    )
}
