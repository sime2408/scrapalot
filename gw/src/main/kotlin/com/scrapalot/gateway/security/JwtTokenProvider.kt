package com.scrapalot.gateway.security

import io.jsonwebtoken.Claims
import io.jsonwebtoken.Jwts
import io.jsonwebtoken.security.Keys
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component
import java.nio.charset.StandardCharsets
import java.util.*
import javax.crypto.SecretKey

/**
 * JWT token provider for parsing and validating JWT tokens
 *
 * Features:
 * - Parse JWT tokens from Authorization header
 * - Extract user context (userId, email, role, subscription tier)
 * - Validate token signature and expiration
 * - Support for refresh tokens (optional)
 */
@Component
class JwtTokenProvider(
    @Value("\${jwt.secret:your-256-bit-secret-key-change-this-in-production-minimum-32-characters}")
    private val jwtSecret: String,

    @Value("\${jwt.expiration-ms:86400000}") // 24-hour default
    private val jwtExpirationMs: Long
) {

    private val logger = LoggerFactory.getLogger(JwtTokenProvider::class.java)
    private val secretKey: SecretKey = Keys.hmacShaKeyFor(jwtSecret.toByteArray(StandardCharsets.UTF_8))

    /**
     * Parse JWT token and extract claims
     *
     * @param token JWT token string (without "Bearer " prefix)
     * @return Claims if valid, null if invalid
     */
    fun parseToken(token: String): Claims? {
        return try {
            Jwts.parser()
                .verifyWith(secretKey)
                .build()
                .parseSignedClaims(token)
                .payload
        } catch (e: Exception) {
            logger.warn("JWT parsing failed: ${e.message}")
            null
        }
    }

    /**
     * Validate JWT token
     *
     * @param token JWT token string (without "Bearer " prefix)
     * @return true if valid, false if invalid or expired
     */
    fun validateToken(token: String): Boolean {
        return try {
            val claims = parseToken(token) ?: return false

            // Check expiration
            val expiration = claims.expiration
            if (expiration.before(Date())) {
                logger.warn("JWT token expired: $expiration")
                return false
            }

            true
        } catch (e: Exception) {
            logger.warn("JWT validation failed: ${e.message}")
            false
        }
    }

    /**
     * Extract user ID from a JWT token
     *
     * @param token JWT token string (without "Bearer " prefix)
     * @return User ID (UUID string) or null if not found
     */
    fun getUserId(token: String): String? {
        return try {
            val claims = parseToken(token) ?: return null
            // The subject typically contains the user ID
            claims.subject ?: claims["userId"] as? String
        } catch (e: Exception) {
            logger.warn("Failed to extract userId from JWT: ${e.message}")
            null
        }
    }

    /**
     * Extract user email from a JWT token
     *
     * @param token JWT token string (without "Bearer " prefix)
     * @return User email or null if not found
     */
    fun getUserEmail(token: String): String? {
        return try {
            val claims = parseToken(token) ?: return null
            claims["email"] as? String
        } catch (e: Exception) {
            logger.warn("Failed to extract email from JWT: ${e.message}")
            null
        }
    }

    /**
     * Extract a user role from a JWT token
     *
     * @param token JWT token string (without "Bearer " prefix)
     * @return User role (USER, ADMIN, etc.) or "USER" as default
     */
    fun getUserRole(token: String): String {
        return try {
            val claims = parseToken(token) ?: return "USER"
            claims["role"] as? String ?: "USER"
        } catch (e: Exception) {
            logger.warn("Failed to extract role from JWT: ${e.message}")
            "USER"
        }
    }

    /**
     * Extract subscription tier from JWT token
     *
     * @param token JWT token string (without "Bearer " prefix)
     * @return Subscription tier (researcher, professional, enterprise) or "researcher" as default
     */
    fun getSubscriptionTier(token: String): String {
        return try {
            val claims = parseToken(token) ?: return "researcher"
            claims["subscription_tier"] as? String ?: "researcher"
        } catch (e: Exception) {
            logger.warn("Failed to extract subscription_tier from JWT: ${e.message}")
            "researcher"
        }
    }

    /**
     * Extract all user context from JWT token
     *
     * @param token JWT token string (without "Bearer " prefix)
     * @return UserContext object or null if invalid
     */
    fun extractUserContext(token: String): UserContext? {
        return try {
            if (!validateToken(token)) {
                return null
            }

            val userId = getUserId(token) ?: return null
            val email = getUserEmail(token)
            val role = getUserRole(token)
            val tier = getSubscriptionTier(token)

            UserContext(
                userId = userId,
                email = email,
                role = role,
                subscriptionTier = tier
            )
        } catch (e: Exception) {
            logger.error("Failed to extract user context from JWT: ${e.message}")
            null
        }
    }
}

/**
 * User context extracted from a JWT token
 */
data class UserContext(
    val userId: String,
    val email: String?,
    val role: String,
    val subscriptionTier: String
)
