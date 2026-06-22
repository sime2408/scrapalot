package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.chat.DirectConversation
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.stereotype.Repository
import java.util.UUID

@Repository
interface DirectConversationRepository : JpaRepository<DirectConversation, UUID> {
    @Query(
        """
        SELECT c FROM DirectConversation c
        WHERE c.kind = 'peer'
          AND c.workspaceId = :workspaceId
          AND ((c.participantOneId = :userA AND c.participantTwoId = :userB)
            OR (c.participantOneId = :userB AND c.participantTwoId = :userA))
        """
    )
    fun findByParticipantsAndWorkspace(
        userA: UUID,
        userB: UUID,
        workspaceId: UUID
    ): DirectConversation?

    @Query(
        """
        SELECT c FROM DirectConversation c
        WHERE c.kind = 'peer'
          AND (c.participantOneId = :userId OR c.participantTwoId = :userId)
        ORDER BY c.updatedAt DESC
        """
    )
    fun findAllByParticipant(userId: UUID): List<DirectConversation>

    @Query(
        """
        SELECT c FROM DirectConversation c
        WHERE c.kind = 'peer'
          AND c.workspaceId = :workspaceId
          AND (c.participantOneId = :userId OR c.participantTwoId = :userId)
        ORDER BY c.updatedAt DESC
        """
    )
    fun findAllByParticipantAndWorkspace(
        userId: UUID,
        workspaceId: UUID
    ): List<DirectConversation>

    // ---- Admin overlay (kind = admin_dm | admin_broadcast; workspace_id IS NULL) ----
    // Convention: admin = participantOneId (sender), target user = participantTwoId.

    @Query(
        """
        SELECT c FROM DirectConversation c
        WHERE c.kind = :kind
          AND c.workspaceId IS NULL
          AND c.participantOneId = :adminId
          AND c.participantTwoId = :userId
        """
    )
    fun findAdminConversation(
        adminId: UUID,
        userId: UUID,
        kind: String
    ): DirectConversation?

    // Admin threads visible to a user in the notification bell:
    //  - any admin_dm / admin_broadcast they RECEIVED (participantTwo), and
    //  - admin_dm they SENT (participantOne) so the admin sees the user's replies.
    // (Broadcast sender is intentionally excluded — an admin shouldn't see N
    //  broadcast threads, one per recipient, in their own bell.)
    // A thread the user dismissed is hidden while their dismissed_at >= updated_at; a
    // newer message bumps updated_at so the thread re-surfaces.
    @Query(
        """
        SELECT c FROM DirectConversation c
        WHERE c.workspaceId IS NULL
          AND (
                (c.participantTwoId = :userId AND c.kind IN ('admin_dm', 'admin_broadcast')
                  AND (c.participantTwoDismissedAt IS NULL OR c.participantTwoDismissedAt < c.updatedAt))
             OR (c.participantOneId = :userId AND c.kind = 'admin_dm'
                  AND (c.participantOneDismissedAt IS NULL OR c.participantOneDismissedAt < c.updatedAt))
          )
        ORDER BY c.updatedAt DESC
        """
    )
    fun findAdminThreadsForParticipant(userId: UUID): List<DirectConversation>
}
