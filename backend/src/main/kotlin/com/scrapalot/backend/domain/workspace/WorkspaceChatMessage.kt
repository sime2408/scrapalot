package com.scrapalot.backend.domain.workspace

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "workspace_chat_messages", schema = "scrapalot")
data class WorkspaceChatMessage(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "workspace_id", nullable = false, columnDefinition = "uuid")
    var workspaceId: UUID,
    @Column(name = "sender_id", nullable = false, columnDefinition = "uuid")
    var senderId: UUID,
    @Column(nullable = false, columnDefinition = "TEXT")
    var content: String,
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant = Instant.now()
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is WorkspaceChatMessage) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "WorkspaceChatMessage(id=$id, workspaceId=$workspaceId, senderId=$senderId)"
}
