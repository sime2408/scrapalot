package com.scrapalot.backend.controller.auth

import com.scrapalot.backend.dto.RefreshTokenRequest
import com.scrapalot.backend.dto.TokenResponse
import com.scrapalot.backend.security.JwtTokenProvider
import com.scrapalot.backend.service.AuthService
import com.scrapalot.backend.utils.onFailureLog
import com.scrapalot.backend.utils.onSuccessLog
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toResponseEntity
import jakarta.servlet.http.Cookie
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import mu.KotlinLogging
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import java.util.UUID

private val logger = KotlinLogging.logger {}

@RestController
@RequestMapping("/api/v1/users")
class TokenController(
    private val authService: AuthService,
    private val jwtTokenProvider: JwtTokenProvider
) {
    @PostMapping(
        path = ["/token"],
        consumes = [MediaType.APPLICATION_FORM_URLENCODED_VALUE]
    )
    fun login(
        @RequestParam username: String,
        @RequestParam password: String,
        request: HttpServletRequest,
        response: HttpServletResponse
    ): ResponseEntity<TokenResponse> =
        resultOf {
            logger.debug("Login attempt for user: {}", username)
            val userAgent = request.getHeader("User-Agent")
            val tokens = authService.login(username, password, userAgent)

            setAuthCookies(response, tokens)

            logger.info("Login successful for user: {}, cookies set", username)

            tokens
        }.toResponseEntity()

    @PostMapping("/token/refresh")
    fun refreshToken(
        @CookieValue("refresh_token", required = false) refreshTokenCookie: String?,
        @RequestBody(required = false) request: RefreshTokenRequest?,
        response: HttpServletResponse
    ): ResponseEntity<TokenResponse> =
        resultOf {
            // Body wins over cookie. Admin impersonation issues per-target
            // refresh tokens that are sent in the body, while the admin's
            // long-lived HTTP-only cookie is also implicitly attached by
            // the browser. Preferring the cookie quietly restored admin
            // identity on every refresh, defeating the impersonation.
            val refreshToken =
                request?.refreshToken ?: refreshTokenCookie
                    ?: throw IllegalArgumentException("refresh_token missing from both cookie and request body")

            val source = if (request?.refreshToken != null) "request body" else "cookie"
            logger.debug("Token refresh attempt with refresh_token from: {}", source)

            val tokens = authService.refreshToken(refreshToken)

            // Update cookies with new tokens for later cookie-based refreshes
            setAuthCookies(response, tokens)

            tokens
        }.onSuccessLog { "Token refresh successful" }
            .onFailureLog { "Token refresh failed: ${it.message}" }
            .toResponseEntity()

    @PostMapping(
        path = ["/token/session"],
        consumes = [MediaType.APPLICATION_FORM_URLENCODED_VALUE]
    )
    fun sessionLogin(
        @RequestParam username: String,
        @RequestParam password: String
    ): ResponseEntity<TokenResponse> =
        resultOf {
            logger.debug("Session login for user: {}", username)
            authService.login(username, password)
        }.onSuccessLog { "Session login successful" }
            .onFailureLog { "Session login failed: ${it.message}" }
            .toResponseEntity()

    @PostMapping("/token/logout")
    fun logout(
        @CookieValue("refresh_token", required = false) refreshTokenCookie: String?,
        @RequestBody(required = false) request: RefreshTokenRequest?,
        response: HttpServletResponse
    ): ResponseEntity<Map<String, String>> =
        resultOf {
            val refreshToken = refreshTokenCookie ?: request?.refreshToken

            if (refreshToken != null && jwtTokenProvider.validateRefreshToken(refreshToken)) {
                val userIdString = jwtTokenProvider.getUsernameFromToken(refreshToken)
                val familyId = jwtTokenProvider.getFamilyIdFromToken(refreshToken)

                if (userIdString != null && familyId != null) {
                    val userId = UUID.fromString(userIdString)
                    authService.revokeRefreshToken(userId, familyId)
                    logger.info("Logout: revoked family {} for user {}", familyId, userId)
                }
            }

            // Clear cookies
            clearAuthCookies(response)

            mapOf("status" to "logged_out")
        }.toResponseEntity()

    @PostMapping("/token/logout-all")
    fun logoutAll(
        @CookieValue("refresh_token", required = false) refreshTokenCookie: String?,
        @RequestBody(required = false) request: RefreshTokenRequest?,
        response: HttpServletResponse
    ): ResponseEntity<Map<String, String>> =
        resultOf {
            val refreshToken = refreshTokenCookie ?: request?.refreshToken

            if (refreshToken != null && jwtTokenProvider.validateRefreshToken(refreshToken)) {
                val userIdString = jwtTokenProvider.getUsernameFromToken(refreshToken)

                if (userIdString != null) {
                    val userId = UUID.fromString(userIdString)
                    authService.revokeAllRefreshTokens(userId)
                    logger.info("Logout-all: revoked all families for user {}", userId)
                }
            }

            // Clear cookies
            clearAuthCookies(response)

            mapOf("status" to "all_sessions_logged_out")
        }.toResponseEntity()

    private fun clearAuthCookies(response: HttpServletResponse) {
        val expiredRefresh =
            Cookie("refresh_token", "").apply {
                isHttpOnly = true
                secure = true
                path = "/"
                maxAge = 0
                setAttribute("SameSite", "None")
            }
        response.addCookie(expiredRefresh)

        val expiredSession =
            Cookie("session_token", "").apply {
                isHttpOnly = true
                secure = true
                path = "/"
                maxAge = 0
                setAttribute("SameSite", "None")
            }
        response.addCookie(expiredSession)
    }

    private fun setAuthCookies(
        response: HttpServletResponse,
        tokens: TokenResponse
    ) {
        val refreshCookie =
            Cookie("refresh_token", tokens.refreshToken).apply {
                isHttpOnly = true
                secure = true
                path = "/"
                maxAge = 30 * 24 * 60 * 60
                setAttribute("SameSite", "None")
            }
        response.addCookie(refreshCookie)

        val sessionCookie =
            Cookie("session_token", tokens.accessToken).apply {
                isHttpOnly = true
                secure = true
                path = "/"
                maxAge = 8 * 60 * 60
                setAttribute("SameSite", "None")
            }
        response.addCookie(sessionCookie)
    }
}
