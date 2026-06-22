package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.chat.SessionFolder
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.stereotype.Repository
import java.util.Optional
import java.util.UUID

@Repository
interface SessionFolderRepository : JpaRepository<SessionFolder, UUID> {
    fun findByUserIdOrderByPositionAsc(userId: UUID): List<SessionFolder>

    fun findByIdAndUserId(
        id: UUID,
        userId: UUID
    ): Optional<SessionFolder>

    fun findByUserIdAndName(
        userId: UUID,
        name: String
    ): SessionFolder?

    fun countByUserId(userId: UUID): Long

    fun existsByIdAndUserId(
        id: UUID,
        userId: UUID
    ): Boolean
}
