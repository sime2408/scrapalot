package com.scrapalot.backend.domain.chat

import io.hypersistence.utils.hibernate.type.json.JsonBinaryType
import jakarta.persistence.*
import org.hibernate.annotations.Type
import java.time.LocalDateTime
import java.util.UUID

/**
 * Chat message entity
 * Represents a single message in a chat session
 */
@Entity
@Table(name = "messages", schema = "scrapalot")
data class Message(
    @Id
    @Column(name = "id", nullable = false)
    var id: UUID = UUID.randomUUID(),
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: LocalDateTime = LocalDateTime.now(),
    @Column(name = "session_id", nullable = false)
    var sessionId: UUID,
    @Column(name = "sender", length = 50, nullable = false)
    var sender: String,
    @Column(name = "role", length = 10, nullable = false)
    var role: String,
    @Column(name = "content", columnDefinition = "TEXT", nullable = false)
    var content: String,
    @Type(JsonBinaryType::class)
    @Column(name = "metadata", columnDefinition = "jsonb", nullable = true)
    var metadata: Map<String, Any>? = null,
    @Column(name = "feedback", nullable = true)
    var feedback: Short? = null,
    @Column(name = "feedback_detail", nullable = true)
    var feedbackDetail: Short? = null,
    @Type(JsonBinaryType::class)
    @Column(name = "used_graph_element_ids", columnDefinition = "jsonb", nullable = true)
    var usedGraphElementIds: Map<String, Any>? = null,
    // Relationships
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "session_id", insertable = false, updatable = false)
    var session: Session? = null
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Message) return false
        return id == other.id
    }

    override fun hashCode(): Int = id.hashCode()

    override fun toString(): String = "Message(id=$id, sessionId=$sessionId, role=$role, sender=$sender, createdAt=$createdAt)"
}
