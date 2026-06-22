package com.scrapalot.backend.domain.chat

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "direct_conversations", schema = "scrapalot")
data class DirectConversation(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "participant_one_id", nullable = false, columnDefinition = "uuid")
    var participantOneId: UUID,
    @Column(name = "participant_two_id", nullable = false, columnDefinition = "uuid")
    var participantTwoId: UUID,
    // NULL for admin conversations (admin_dm / admin_broadcast) — they are not workspace-scoped.
    @Column(name = "workspace_id", nullable = true, columnDefinition = "uuid")
    var workspaceId: UUID? = null,
    // peer | admin_dm | admin_broadcast — admin_* conversations bypass the workspace/subscription
    // gating and surface in the notification bell + prominent toast instead of the peer DM tab.
    @Column(name = "kind", nullable = false)
    var kind: String = "peer",
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant = Instant.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: Instant = Instant.now(),
    // Per-participant dismiss for admin notification threads. A thread is hidden from a
    // participant's bell while their dismissed_at >= updated_at; a newer message bumps
    // updated_at and re-surfaces it. Two columns (not one shared) because admin_dm threads
    // are visible to both participants and each clears their own view independently.
    @Column(name = "participant_one_dismissed_at", nullable = true)
    var participantOneDismissedAt: Instant? = null,
    @Column(name = "participant_two_dismissed_at", nullable = true)
    var participantTwoDismissedAt: Instant? = null
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is DirectConversation) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "DirectConversation(id=$id, participantOneId=$participantOneId, participantTwoId=$participantTwoId)"
}
