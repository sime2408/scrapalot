package com.scrapalot.backend.domain.chat

import jakarta.persistence.*
import java.time.LocalDateTime
import java.util.UUID

/**
 * A user-uploaded attachment that stays bound to a chat [Session] for the whole
 * conversation. Unlike [ChatMessageAttachment] (assistant-GENERATED artifacts
 * keyed to a single message), this holds the already-extracted text of a
 * document the user attached in the chat popover, so follow-up questions can
 * still reference it.
 *
 * The extracted text is forwarded to Python on every message of the session
 * (capped server-side), making the attachment behave like a sticky part of the
 * conversation rather than a one-shot inline blob.
 *
 * [type] mirrors the frontend ChatAttachment discriminator:
 *  - ``document`` → [content] is extracted text
 *  - ``image``    → [content] is base64 data
 *  - ``youtube``  → [content] is the transcript / URL
 */
@Entity
@Table(
    name = "session_attachments",
    schema = "scrapalot",
    indexes = [
        Index(name = "idx_session_attachments_session_id", columnList = "session_id")
    ]
)
data class SessionAttachment(
    @Id
    @Column(name = "id", nullable = false)
    var id: UUID = UUID.randomUUID(),
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: LocalDateTime = LocalDateTime.now(),
    @Column(name = "session_id", nullable = false)
    var sessionId: UUID,
    /** ``document`` | ``image`` | ``youtube``. */
    @Column(name = "type", length = 16, nullable = false)
    var type: String,
    @Column(name = "filename", length = 500, nullable = false)
    var filename: String,
    @Column(name = "mime_type", length = 128, nullable = true)
    var mimeType: String? = null,
    /** Extracted text / base64 / URL — capped server-side before persisting. */
    @Column(name = "content", columnDefinition = "TEXT", nullable = false)
    var content: String,
    /** Character count of [content] after capping (for the UI chip label). */
    @Column(name = "char_count", nullable = true)
    var charCount: Int? = null,
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "session_id", insertable = false, updatable = false)
    var session: Session? = null
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is SessionAttachment) return false
        return id == other.id
    }

    override fun hashCode(): Int = id.hashCode()

    override fun toString(): String = "SessionAttachment(id=$id, sessionId=$sessionId, type=$type, filename=$filename, charCount=$charCount)"
}
