package com.scrapalot.backend.domain.workspace

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "workspace_chat_presence", schema = "scrapalot")
data class WorkspaceChatPresence(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    @Column(name = "workspace_id", nullable = false, columnDefinition = "uuid")
    var workspaceId: UUID,
    @Column(name = "is_online", nullable = false)
    var isOnline: Boolean = false,
    @Column(name = "last_seen_at", nullable = false)
    var lastSeenAt: Instant = Instant.now()
) {
    @PreUpdate
    fun onUpdate() {
        lastSeenAt = Instant.now()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is WorkspaceChatPresence) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "WorkspaceChatPresence(id=$id, userId=$userId, workspaceId=$workspaceId, isOnline=$isOnline)"
}
