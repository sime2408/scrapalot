package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.auth.APIKey
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.time.Instant
import java.util.UUID

@Suppress("unused")
@Repository
interface APIKeyRepository : JpaRepository<APIKey, UUID> {
    fun findByUserId(userId: UUID): List<APIKey>

    fun findByUserIdAndIsActiveTrue(userId: UUID): List<APIKey>

    fun findByKeyHash(keyHash: String): APIKey?

    fun findByKeyPrefix(keyPrefix: String): List<APIKey>

    fun existsByKeyHash(keyHash: String): Boolean

    @Modifying
    @Query("UPDATE APIKey k SET k.lastUsedAt = :timestamp WHERE k.id = :id")
    fun updateLastUsedAt(
        @Param("id") id: UUID,
        @Param("timestamp") timestamp: Instant
    ): Int

    @Query("SELECT k FROM APIKey k WHERE k.isActive = true AND (k.expiresAt IS NULL OR k.expiresAt > :now)")
    fun findActiveAndNotExpired(
        @Param("now") now: Instant
    ): List<APIKey>

    @Query("SELECT k FROM APIKey k WHERE k.userId = :userId AND k.isActive = true AND (k.expiresAt IS NULL OR k.expiresAt > :now)")
    fun findActiveAndNotExpiredByUserId(
        @Param("userId") userId: UUID,
        @Param("now") now: Instant
    ): List<APIKey>
}
