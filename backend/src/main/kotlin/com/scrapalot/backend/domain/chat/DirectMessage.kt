package com.scrapalot.backend.domain.chat

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "direct_messages", schema = "scrapalot")
data class DirectMessage(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "conversation_id", nullable = false, columnDefinition = "uuid")
    var conversationId: UUID,
    @Column(name = "sender_id", nullable = false, columnDefinition = "uuid")
    var senderId: UUID,
    @Column(nullable = false, columnDefinition = "TEXT")
    var content: String,
    @Column(name = "read_at")
    var readAt: Instant? = null,
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant = Instant.now()
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is DirectMessage) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "DirectMessage(id=$id, conversationId=$conversationId, senderId=$senderId)"
}
