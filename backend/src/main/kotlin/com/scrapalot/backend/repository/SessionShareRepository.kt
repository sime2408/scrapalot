package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.chat.SessionShare
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.stereotype.Repository
import java.util.UUID

@Suppress("unused")
@Repository
interface SessionShareRepository : JpaRepository<SessionShare, UUID> {
    fun findByShareTokenAndRevokedAtIsNull(shareToken: String): SessionShare?

    fun findBySessionIdAndUserIdAndRevokedAtIsNull(
        sessionId: UUID,
        userId: UUID
    ): SessionShare?

    fun findAllBySessionIdAndRevokedAtIsNull(sessionId: UUID): List<SessionShare>
}
