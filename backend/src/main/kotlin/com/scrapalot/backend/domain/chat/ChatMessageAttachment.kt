package com.scrapalot.backend.domain.chat

import jakarta.persistence.*
import java.time.LocalDateTime
import java.util.UUID

/**
 * Generated artifact attached to a chat message — image, audio clip, video,
 * or arbitrary document. Lives in a sibling table so binary blobs stay on
 * disk under ``scrapalot_data/`` (referenced via [storagePath]) instead of
 * inline in [Message.content].
 *
 * The [kind] discriminates which optional columns are populated:
 *  - ``image``    → [width], [height], [prompt], [revisedPrompt]
 *  - ``audio``    → [durationMs]
 *  - ``video``    → [width], [height], [durationMs]
 *  - ``document`` → [storagePath] + [mimeType] only
 */
@Entity
@Table(
    name = "chat_message_attachments",
    schema = "scrapalot",
    indexes = [
        Index(name = "idx_chat_message_attachments_message_id", columnList = "message_id"),
        Index(name = "idx_chat_message_attachments_kind_created", columnList = "kind,created_at")
    ]
)
data class ChatMessageAttachment(
    @Id
    @Column(name = "id", nullable = false)
    var id: UUID = UUID.randomUUID(),
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: LocalDateTime = LocalDateTime.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: LocalDateTime = LocalDateTime.now(),
    @Column(name = "message_id", nullable = false)
    var messageId: UUID,
    /** ``image`` | ``audio`` | ``video`` | ``document``. */
    @Column(name = "kind", length = 16, nullable = false)
    var kind: String,
    /** On-disk path under ``scrapalot_data/`` — never a public URL. */
    @Column(name = "storage_path", length = 500, nullable = true)
    var storagePath: String? = null,
    @Column(name = "mime_type", length = 64, nullable = true)
    var mimeType: String? = null,
    @Column(name = "width", nullable = true)
    var width: Int? = null,
    @Column(name = "height", nullable = true)
    var height: Int? = null,
    @Column(name = "duration_ms", nullable = true)
    var durationMs: Int? = null,
    /** Original user prompt for image / audio generation. */
    @Column(name = "prompt", columnDefinition = "TEXT", nullable = true)
    var prompt: String? = null,
    /**
     * Provider-rewritten prompt (DALL-E silently rewrites; capture so the user
     * can see what the model actually generated for and offer a re-generate
     * with the original wording).
     */
    @Column(name = "revised_prompt", columnDefinition = "TEXT", nullable = true)
    var revisedPrompt: String? = null,
    /** Model that produced the artifact (``dall-e-3``, ``gpt-image-1``, ``tts-1`` ...). */
    @Column(name = "model_name", length = 100, nullable = true)
    var modelName: String? = null,
    /** Cost recorded by the metrics layer in cents (NULL until tallied). */
    @Column(name = "cost_cents", nullable = true)
    var costCents: Int? = null,
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "message_id", insertable = false, updatable = false)
    var message: Message? = null
) {
    @PreUpdate
    fun preUpdate() {
        updatedAt = LocalDateTime.now()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ChatMessageAttachment) return false
        return id == other.id
    }

    override fun hashCode(): Int = id.hashCode()

    override fun toString(): String = "ChatMessageAttachment(id=$id, messageId=$messageId, kind=$kind, modelName=$modelName)"
}
