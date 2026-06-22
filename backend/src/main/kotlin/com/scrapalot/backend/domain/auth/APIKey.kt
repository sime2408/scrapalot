package com.scrapalot.backend.domain.auth

import jakarta.persistence.*
import org.hibernate.annotations.JdbcTypeCode
import org.hibernate.annotations.UuidGenerator
import org.hibernate.type.SqlTypes
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "api_keys", schema = "scrapalot")
data class APIKey(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    @Column(name = "key_hash", nullable = false, unique = true, length = 255)
    var keyHash: String,
    @Column(name = "key_prefix", nullable = false, length = 10)
    var keyPrefix: String,
    @Column(nullable = false, length = 100)
    var name: String,
    @Column(name = "is_active", nullable = false)
    var isActive: Boolean = true,
    @Column(name = "last_used_at", nullable = true)
    var lastUsedAt: Instant? = null,
    @Column(name = "expires_at", nullable = true)
    var expiresAt: Instant? = null,
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    var scopes: Map<String, Any>? = null,
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
        if (other !is APIKey) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "APIKey(id=$id, userId=$userId, keyPrefix='$keyPrefix', name='$name', isActive=$isActive)"
}
