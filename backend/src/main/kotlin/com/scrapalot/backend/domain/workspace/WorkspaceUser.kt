package com.scrapalot.backend.domain.workspace

import jakarta.persistence.*
import java.io.Serializable
import java.time.Instant
import java.util.Objects
import java.util.UUID

@Entity
@Table(name = "workspace_users", schema = "scrapalot")
@IdClass(WorkspaceUserId::class)
data class WorkspaceUser(
    @Id
    @Column(name = "workspace_id", nullable = false, columnDefinition = "uuid")
    var workspaceId: UUID,
    @Id
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    @Column(nullable = false, length = 20)
    var permission: String = "read",
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant = Instant.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: Instant = Instant.now()
) {
    @PreUpdate
    fun onUpdate() {
        updatedAt = Instant.now()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is WorkspaceUser) return false
        return workspaceId == other.workspaceId && userId == other.userId
    }

    override fun hashCode(): Int = Objects.hash(workspaceId, userId)

    override fun toString(): String = "WorkspaceUser(workspaceId=$workspaceId, userId=$userId, permission='$permission')"
}

// Composite primary key class
data class WorkspaceUserId(
    var workspaceId: UUID? = null,
    var userId: UUID? = null
) : Serializable {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is WorkspaceUserId) return false
        return workspaceId == other.workspaceId && userId == other.userId
    }

    override fun hashCode(): Int = Objects.hash(workspaceId, userId)
}
