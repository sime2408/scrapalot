package com.scrapalot.backend.service

import com.scrapalot.backend.domain.auth.APIKey
import com.scrapalot.backend.repository.APIKeyRepository
import com.scrapalot.backend.utils.orThrow
import mu.KotlinLogging
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.security.SecureRandom
import java.time.Instant
import java.util.NoSuchElementException
import java.util.UUID

private val logger = KotlinLogging.logger {}

@Service
@Transactional
class APIKeyService(
    private val apiKeyRepository: APIKeyRepository,
    private val passwordEncoder: PasswordEncoder
) {
    private val secureRandom = SecureRandom()

    data class GeneratedKey(
        val apiKey: APIKey,
        val plainTextKey: String // Only returned once, never stored
    )

    @Transactional(readOnly = true)
    fun getUserAPIKeys(userId: UUID): List<APIKey> = apiKeyRepository.findByUserId(userId)

    @Suppress("unused") // future API — returns only non-expired active keys for a user
    @Transactional(readOnly = true)
    fun getActiveAPIKeys(userId: UUID): List<APIKey> = apiKeyRepository.findActiveAndNotExpiredByUserId(userId, Instant.now())

    fun createAPIKey(
        userId: UUID,
        name: String,
        expiresAt: Instant? = null,
        scopes: Map<String, Any>? = null
    ): GeneratedKey {
        // Generate random API key
        val plainTextKey = generateRandomKey()

        // Hash the key (never store plaintext)
        val keyHash = passwordEncoder.encode(plainTextKey)

        // Extract prefix for display (e.g., "scp-1a2b")
        val keyPrefix = plainTextKey.substring(0, 8) // "scp-1a2b"

        val apiKey =
            APIKey(
                userId = userId,
                keyHash = keyHash,
                keyPrefix = keyPrefix,
                name = name,
                isActive = true,
                expiresAt = expiresAt,
                scopes = scopes,
                createdAt = Instant.now(),
                updatedAt = Instant.now()
            )

        val saved = apiKeyRepository.save(apiKey)

        logger.info { "Created API key for user: $userId, name: $name, prefix: $keyPrefix" }

        return GeneratedKey(
            apiKey = saved,
            plainTextKey = plainTextKey
        )
    }

    fun validateAPIKey(plainTextKey: String): APIKey? {
        // Extract prefix to narrow down search
        val prefix = plainTextKey.substring(0, 8)

        val candidates = apiKeyRepository.findByKeyPrefix(prefix)

        for (candidate in candidates) {
            if (passwordEncoder.matches(plainTextKey, candidate.keyHash)) {
                // Check if key is active and not expired
                if (candidate.isActive &&
                    (candidate.expiresAt?.isAfter(Instant.now()) ?: true)
                ) {
                    // Update last used timestamp
                    apiKeyRepository.updateLastUsedAt(candidate.id.orThrow("APIKey"), Instant.now())
                    return candidate
                }
            }
        }

        return null
    }

    fun toggleAPIKey(
        keyId: UUID,
        userId: UUID
    ): APIKey {
        val apiKey =
            apiKeyRepository.findById(keyId).orElseThrow {
                NoSuchElementException("API key not found: $keyId")
            }

        if (apiKey.userId != userId) {
            throw IllegalArgumentException("API key does not belong to user")
        }

        val updated =
            apiKey.copy(
                isActive = !apiKey.isActive,
                updatedAt = Instant.now()
            )

        logger.info { "Toggled API key: $keyId to active: ${updated.isActive}" }
        return apiKeyRepository.save(updated)
    }

    fun deleteAPIKey(
        keyId: UUID,
        userId: UUID
    ) {
        val apiKey =
            apiKeyRepository.findById(keyId).orElseThrow {
                NoSuchElementException("API key not found: $keyId")
            }

        if (apiKey.userId != userId) {
            throw IllegalArgumentException("API key does not belong to user")
        }

        apiKeyRepository.deleteById(keyId)
        logger.info { "Deleted API key: $keyId" }
    }

    private fun generateRandomKey(): String {
        // Generate format: scp-{8 hex chars}-{16 hex chars}
        // Example: scp-1a2b3c4d-0123456789abcdef
        val part1 = generateHexString(4) // 8 hex chars
        val part2 = generateHexString(8) // 16 hex chars

        return "scp-$part1-$part2"
    }

    private fun generateHexString(byteCount: Int): String {
        val bytes = ByteArray(byteCount)
        secureRandom.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
