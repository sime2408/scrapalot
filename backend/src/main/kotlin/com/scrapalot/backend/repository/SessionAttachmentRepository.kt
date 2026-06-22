package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.chat.SessionAttachment
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.UUID

@Suppress("unused")
@Repository
interface SessionAttachmentRepository : JpaRepository<SessionAttachment, UUID> {
    fun findBySessionIdOrderByCreatedAtAsc(sessionId: UUID): List<SessionAttachment>

    fun deleteBySessionId(sessionId: UUID)

    /**
     * Distinct document-type chat attachments a user owns, counted once per
     * filename across all their sessions (re-attaching the same book in another
     * session does not inflate the count). Feeds the document quota — image /
     * youtube attachments are excluded.
     */
    @Query(
        """
        SELECT COUNT(DISTINCT a.filename)
        FROM SessionAttachment a
        WHERE a.session.userId = :userId AND a.type = 'document'
        """
    )
    fun countDistinctDocumentFilenamesByUserId(@Param("userId") userId: UUID): Long
}
