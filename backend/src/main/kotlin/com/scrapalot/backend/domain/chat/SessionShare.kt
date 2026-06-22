package com.scrapalot.backend.domain.chat

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "session_shares", schema = "scrapalot")
data class SessionShare(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "session_id", nullable = false, columnDefinition = "uuid")
    var sessionId: UUID,
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    @Column(name = "share_token", nullable = false, length = 36, unique = true)
    var shareToken: String = UUID.randomUUID().toString(),
    @Column(name = "message_snapshot_count", nullable = false)
    var messageSnapshotCount: Int,
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant = Instant.now(),
    @Column(name = "expires_at")
    var expiresAt: Instant? = null,
    @Column(name = "revoked_at")
    var revokedAt: Instant? = null
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is SessionShare) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "SessionShare(id=$id, sessionId=$sessionId, token=${shareToken.take(8)}...)"
}
