package com.scrapalot.backend.service

import mu.KotlinLogging
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Service
import java.security.MessageDigest
import java.time.Duration
import java.util.UUID

private val logger = KotlinLogging.logger {}

/**
 * Redis-backed refresh token family management.
 *
 * Each login creates a "token family" identified by a UUID (familyId).
 * The family stores the SHA-256 hash of the current refresh token.
 * On rotation, the hash is updated. On reuse of an old token (hash mismatch),
 * the entire family is revoked (theft detection).
 *
 * Redis schema (DB used by Kotlin — configured via redis.database):
 *   scrapalot:auth:refresh:{userId}:{familyId} → Hash { token_hash, created_at, last_used_at, user_agent }
 *   scrapalot:auth:families:{userId} → Set of familyIds
 */
@Service
class RefreshTokenService(
    private val stringRedisTemplate: StringRedisTemplate
) {
    companion object {
        private const val REFRESH_KEY_PREFIX = "scrapalot:auth:refresh"
        private const val FAMILIES_KEY_PREFIX = "scrapalot:auth:families"
        private val FAMILY_TTL = Duration.ofDays(7)

        // Grace window after a rotation during which the PREVIOUS
        // refresh-token hash is still accepted. Covers the legitimate
        // race where the browser sends two near-simultaneous refresh
        // requests before the first response has written localStorage
        // — or two tabs sharing the same credentials fire their own
        // requests with the same (still-valid) token. Without this,
        // the second request sees a stale hash and the theft-detection
        // branch revokes the entire family, killing the user's session.
        private val GRACE_WINDOW_MS: Long = 60_000
    }

    /**
     * Create a new token family on login.
     * Returns the familyId to embed in the refresh token JWT.
     */
    fun createTokenFamily(
        userId: UUID,
        familyId: String,
        refreshToken: String,
        userAgent: String?
    ): String {
        val familyKey = "$REFRESH_KEY_PREFIX:$userId:$familyId"
        val familiesKey = "$FAMILIES_KEY_PREFIX:$userId"

        val hash = sha256(refreshToken)
        val now = System.currentTimeMillis().toString()

        stringRedisTemplate.opsForHash<String, String>().putAll(
            familyKey,
            mapOf(
                "token_hash" to hash,
                "created_at" to now,
                "last_used_at" to now,
                "user_agent" to (userAgent ?: "unknown")
            )
        )
        stringRedisTemplate.expire(familyKey, FAMILY_TTL)

        stringRedisTemplate.opsForSet().add(familiesKey, familyId)
        stringRedisTemplate.expire(familiesKey, FAMILY_TTL)

        logger.info { "Created refresh token family $familyId for user $userId" }
        return familyId
    }

    /**
     * Validate the refresh token against the stored hash, then rotate.
     *
     * Returns the refresh token the caller should hand back to the
     * client, or null when the request must be rejected.
     *
     *  * Current hash matches → rotate to newRefreshTokenCandidate,
     *    store the cache fields, return the candidate.
     *  * Current hash is STALE but previous_token_hash matches AND the
     *    last rotation was within GRACE_WINDOW_MS → return the refresh
     *    token the first caller already minted. The candidate token
     *    from this caller is discarded — giving the caller a fresh
     *    minted token that the server never registered would leave the
     *    client with a dead-walking refresh token that fails its NEXT
     *    rotation and logs the user out a few seconds later.
     *  * Otherwise → revoke family, return null.
     */
    fun rotate(
        userId: UUID,
        familyId: String,
        oldRefreshToken: String,
        newRefreshTokenCandidate: String,
    ): String? {
        val familyKey = "$REFRESH_KEY_PREFIX:$userId:$familyId"

        val hashOps = stringRedisTemplate.opsForHash<String, String>()
        val storedHash = hashOps.get(familyKey, "token_hash")
        if (storedHash == null) {
            logger.warn { "Token family $familyId not found for user $userId (expired or revoked)" }
            return null
        }

        val providedHash = sha256(oldRefreshToken)

        if (storedHash == providedHash) {
            val newHash = sha256(newRefreshTokenCandidate)
            val now = System.currentTimeMillis().toString()
            hashOps.putAll(
                familyKey,
                mapOf(
                    "token_hash" to newHash,
                    "previous_token_hash" to storedHash,
                    "rotated_at" to now,
                    "last_used_at" to now,
                    "last_minted_refresh_token" to newRefreshTokenCandidate,
                )
            )
            stringRedisTemplate.expire(familyKey, FAMILY_TTL)
            logger.debug { "Rotated refresh token for family $familyId, user $userId" }
            return newRefreshTokenCandidate
        }

        val previousHash = hashOps.get(familyKey, "previous_token_hash")
        val rotatedAt = hashOps.get(familyKey, "rotated_at")?.toLongOrNull()
        if (
            previousHash != null &&
            previousHash == providedHash &&
            rotatedAt != null &&
            System.currentTimeMillis() - rotatedAt < GRACE_WINDOW_MS
        ) {
            val cachedRefresh = hashOps.get(familyKey, "last_minted_refresh_token")
            if (cachedRefresh.isNullOrEmpty()) {
                logger.warn {
                    "Grace window matched for family $familyId but cached token missing — rejecting, client should retry"
                }
                return null
            }
            hashOps.put(familyKey, "last_used_at", System.currentTimeMillis().toString())
            stringRedisTemplate.expire(familyKey, FAMILY_TTL)
            logger.info {
                "Replaying cached refresh token within grace window for family $familyId, user $userId"
            }
            return cachedRefresh
        }

        logger.warn {
            "Token hash mismatch for family $familyId, user $userId — possible token reuse attack, revoking family"
        }
        revokeFamily(userId, familyId)
        return null
    }

    /**
     * Legacy wrapper that preserves the boolean-returning shape for
     * call sites that don't need the (possibly-cached) rotated token.
     * Prefer `rotate(...)` directly — its string return lets callers
     * honour the grace-window cache. This method is kept only to keep
     * the surface narrow for tests and tooling that still construct
     * the new refresh token themselves.
     */
    fun validateAndRotate(
        userId: UUID,
        familyId: String,
        oldRefreshToken: String,
        newRefreshToken: String
    ): Boolean = rotate(userId, familyId, oldRefreshToken, newRefreshToken) != null

    /**
     * Revoke a single token family (logout from one device).
     */
    fun revokeFamily(
        userId: UUID,
        familyId: String
    ) {
        val familyKey = "$REFRESH_KEY_PREFIX:$userId:$familyId"
        val familiesKey = "$FAMILIES_KEY_PREFIX:$userId"

        stringRedisTemplate.delete(familyKey)
        stringRedisTemplate.opsForSet().remove(familiesKey, familyId)

        logger.info { "Revoked token family $familyId for user $userId" }
    }

    /**
     * Revoke all token families for a user (logout from all devices).
     */
    fun revokeAllForUser(userId: UUID) {
        val familiesKey = "$FAMILIES_KEY_PREFIX:$userId"
        val familyIds = stringRedisTemplate.opsForSet().members(familiesKey) ?: emptySet()

        familyIds.forEach { familyId ->
            stringRedisTemplate.delete("$REFRESH_KEY_PREFIX:$userId:$familyId")
        }
        stringRedisTemplate.delete(familiesKey)

        logger.info { "Revoked all ${familyIds.size} token families for user $userId" }
    }

    private fun sha256(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val hashBytes = digest.digest(input.toByteArray(Charsets.UTF_8))
        return hashBytes.joinToString("") { "%02x".format(it) }
    }
}
