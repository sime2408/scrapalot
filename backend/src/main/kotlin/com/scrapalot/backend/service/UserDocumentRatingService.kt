package com.scrapalot.backend.service

import com.scrapalot.backend.domain.document.UserDocumentRating
import com.scrapalot.backend.repository.UserDocumentRatingRepository
import mu.KotlinLogging
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.UUID

private val logger = KotlinLogging.logger {}

/**
 * Document quality rating service.
 *
 * Upsert-by-(user_id, document_id). The DB has a UNIQUE constraint on
 * that pair so a clean upsert is `find + (update | insert)`. We don't
 * need a SELECT FOR UPDATE because the unique constraint protects
 * against concurrent inserts inserting two rows.
 */
@Service
@Transactional
class UserDocumentRatingService(
    private val repo: UserDocumentRatingRepository,
) {
    @Transactional(readOnly = true)
    fun findByUserAndDocument(
        userId: UUID,
        documentId: UUID
    ): UserDocumentRating? = repo.findByUserIdAndDocumentId(userId, documentId)

    @Transactional(readOnly = true)
    fun findAllForUser(
        userId: UUID,
        documentIds: List<UUID>
    ): List<UserDocumentRating> {
        if (documentIds.isEmpty()) return emptyList()
        return repo.findAllByUserIdAndDocumentIdIn(userId, documentIds)
    }

    /** Upsert a rating. When `rating` is null the existing row is deleted
     *  (interpreted as "clear my rating") and `null` is returned. */
    fun upsertRating(
        userId: UUID,
        documentId: UUID,
        workspaceId: UUID,
        rating: Short?,
        notes: String?,
    ): UserDocumentRating? {
        if (rating == null) {
            repo.deleteByUserIdAndDocumentId(userId, documentId)
            logger.info { "Cleared rating for user=$userId document=$documentId" }
            return null
        }

        val existing = repo.findByUserIdAndDocumentId(userId, documentId)
        val updated =
            if (existing != null) {
                existing.copy(
                    workspaceId = workspaceId,
                    rating = rating,
                    notes = notes ?: existing.notes,
                    updatedAt = Instant.now(),
                )
            } else {
                UserDocumentRating(
                    userId = userId,
                    documentId = documentId,
                    workspaceId = workspaceId,
                    rating = rating,
                    notes = notes,
                    ratedAt = Instant.now(),
                    updatedAt = Instant.now(),
                )
            }
        val saved = repo.save(updated)
        logger.info { "Upserted rating $rating for user=$userId document=$documentId" }
        return saved
    }
}
