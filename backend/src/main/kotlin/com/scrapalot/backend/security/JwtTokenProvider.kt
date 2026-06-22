package com.scrapalot.backend.security

import io.jsonwebtoken.*
import io.jsonwebtoken.security.Keys
import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Value
import org.springframework.security.core.Authentication
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.stereotype.Component
import java.util.Date
import javax.crypto.SecretKey

private val logger = KotlinLogging.logger {}

@Component
class JwtTokenProvider(
    @param:Value("\${jwt.secret}")
    private val jwtSecret: String,
    @param:Value("\${jwt.expiration-ms}")
    private val jwtExpirationMs: Long,
    @param:Value("\${jwt.refresh-expiration-ms}")
    private val refreshExpirationMs: Long
) {
    private val key: SecretKey by lazy {
        Keys.hmacShaKeyFor(jwtSecret.toByteArray())
    }

    @Suppress("unused") // public API function — kept for callers that authenticate via Spring Security's Authentication object
    fun generateAccessToken(authentication: Authentication): String {
        val userPrincipal = authentication.principal as UserDetails
        return generateTokenFromUsername(userPrincipal.username, "user", jwtExpirationMs, "scrapalot-users")
    }

    fun generateAccessToken(
        username: String,
        role: String
    ): String = generateTokenFromUsername(username, role, jwtExpirationMs, "scrapalot-users")

    /** Access-token TTL in seconds — the value the frontend uses to schedule
     *  proactive refresh. Must come from the same env var that signs the
     *  token; hardcoding a different value here lets the FE believe it has
     *  hours when the JWT is actually about to expire. */
    fun getAccessTokenTtlSeconds(): Long = jwtExpirationMs / 1000

    fun generateRefreshToken(
        username: String,
        familyId: String? = null
    ): String = generateRefreshTokenInternal(username, refreshExpirationMs, "scrapalot-refresh", familyId)

    @Suppress("SameParameterValue")
    private fun generateTokenFromUsername(
        username: String,
        role: String,
        expirationMs: Long,
        audience: String
    ): String {
        val now = Date()
        val expiryDate = Date(now.time + expirationMs)

        return Jwts
            .builder()
            .subject(username)
            .claim("role", role)
            .audience()
            .add(audience)
            .and()
            .issuedAt(now)
            .expiration(expiryDate)
            .signWith(key)
            .compact()
    }

    @Suppress("SameParameterValue")
    private fun generateRefreshTokenInternal(
        username: String,
        expirationMs: Long,
        audience: String,
        familyId: String? = null
    ): String {
        val now = Date()
        val expiryDate = Date(now.time + expirationMs)

        val builder =
            Jwts
                .builder()
                .subject(username)
                .audience()
                .add(audience)
                .and()
                .issuedAt(now)
                .expiration(expiryDate)

        if (familyId != null) {
            builder.claim("fid", familyId)
        }

        return builder
            .signWith(key)
            .compact()
    }

    fun getUsernameFromToken(token: String): String? =
        try {
            val claims =
                Jwts
                    .parser()
                    .verifyWith(key)
                    .build()
                    .parseSignedClaims(token)
                    .payload

            claims.subject
        } catch (e: Exception) {
            logger.error(e) { "Error extracting username from JWT token" }
            null
        }

    fun getUserIdFromToken(token: String): String? =
        try {
            val claims =
                Jwts
                    .parser()
                    .verifyWith(key)
                    .build()
                    .parseSignedClaims(token)
                    .payload

            // For now, return username as userId (subject claim)
            // In the future, we can add dedicated userId claim
            claims.subject
        } catch (e: Exception) {
            logger.error(e) { "Error extracting userId from JWT token" }
            null
        }

    fun getRoleFromToken(token: String): String? =
        try {
            val claims =
                Jwts
                    .parser()
                    .verifyWith(key)
                    .build()
                    .parseSignedClaims(token)
                    .payload

            claims["role"] as? String ?: "user"
        } catch (e: Exception) {
            logger.error(e) { "Error extracting role from JWT token" }
            "user"
        }

    fun validateToken(authToken: String): Boolean =
        try {
            Jwts
                .parser()
                .verifyWith(key)
                .build()
                .parseSignedClaims(authToken)
            true
        } catch (_: SecurityException) {
            logger.error { "Invalid JWT signature" }
            false
        } catch (_: MalformedJwtException) {
            logger.error { "Invalid JWT token" }
            false
        } catch (_: ExpiredJwtException) {
            logger.error { "Expired JWT token" }
            false
        } catch (_: UnsupportedJwtException) {
            logger.error { "Unsupported JWT token" }
            false
        } catch (_: IllegalArgumentException) {
            logger.error { "JWT claims string is empty" }
            false
        }

    fun getFamilyIdFromToken(token: String): String? =
        try {
            val claims =
                Jwts
                    .parser()
                    .verifyWith(key)
                    .build()
                    .parseSignedClaims(token)
                    .payload

            claims["fid"] as? String
        } catch (e: Exception) {
            logger.error(e) { "Error extracting familyId from JWT token" }
            null
        }

    fun validateRefreshToken(refreshToken: String): Boolean =
        try {
            val claims =
                Jwts
                    .parser()
                    .verifyWith(key)
                    .build()
                    .parseSignedClaims(refreshToken)
                    .payload

            val audience = claims.audience
            audience.contains("scrapalot-refresh")
        } catch (ex: Exception) {
            logger.error(ex) { "Invalid refresh token" }
            false
        }
}
