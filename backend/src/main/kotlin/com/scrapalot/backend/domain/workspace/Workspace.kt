package com.scrapalot.backend.domain.workspace

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "workspaces", schema = "scrapalot")
data class Workspace(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(nullable = false, length = 100)
    var name: String,
    // Stable URL/CLI-friendly identifier for the OpenAI-compatible API
    // surface (model="scrapalot:my-workspace:..."). Set on create via
    // SlugUtils, immutable across name renames so SDK consumers don't
    // break. Unique per user_id (ux_workspaces_user_id_slug).
    @Column(nullable = false, length = 120)
    var slug: String,
    @Column(columnDefinition = "TEXT")
    var description: String? = null,
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    @Column(name = "is_public", nullable = false)
    var isPublic: Boolean = false,
    @Column(name = "is_shared", nullable = false)
    var isShared: Boolean = false,
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
        if (other !is Workspace) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "Workspace(id=$id, name='$name', userId=$userId, isPublic=$isPublic, isShared=$isShared)"
}
