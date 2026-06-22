package com.scrapalot.backend.security

import mu.KotlinLogging
import org.springframework.http.HttpStatus
import org.springframework.http.server.ServerHttpRequest
import org.springframework.http.server.ServerHttpResponse
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.stereotype.Component
import org.springframework.web.socket.WebSocketHandler
import org.springframework.web.socket.server.HandshakeInterceptor
import org.springframework.web.util.UriComponentsBuilder

private val logger = KotlinLogging.logger {}

/**
 * JWT authentication interceptor for WebSocket handshake.
 *
 * Validates JWT token from:
 * 1. Query parameter:token=xxx
 * 2. Authorization header: Bearer xxx
 *
 * Sets authentication context for WebSocket session.
 */
@Component
class JwtWebSocketHandshakeInterceptor(
    private val jwtTokenProvider: JwtTokenProvider
) : HandshakeInterceptor {
    override fun beforeHandshake(
        request: ServerHttpRequest,
        response: ServerHttpResponse,
        wsHandler: WebSocketHandler,
        attributes: MutableMap<String, Any>
    ): Boolean {
        try {
            // Extract token from query params or Authorization header
            val token = extractToken(request)

            if (token == null) {
                logger.warn { "WebSocket connection rejected: No token provided" }
                response.setStatusCode(HttpStatus.UNAUTHORIZED)
                return false
            }

            // Validate token
            if (!jwtTokenProvider.validateToken(token)) {
                logger.warn { "WebSocket connection rejected: Invalid token" }
                response.setStatusCode(HttpStatus.UNAUTHORIZED)
                return false
            }

            // Extract user details from token
            val userId =
                jwtTokenProvider.getUserIdFromToken(token) ?: run {
                    logger.warn { "WebSocket connection rejected: Cannot extract userId from token" }
                    response.setStatusCode(HttpStatus.UNAUTHORIZED)
                    return false
                }
            val role = jwtTokenProvider.getRoleFromToken(token) ?: "user"

            // Store user info in WebSocket session attributes
            attributes["userId"] = userId
            attributes["role"] = role
            attributes["token"] = token

            // Set Spring Security context
            val authorities = listOf(SimpleGrantedAuthority("ROLE_$role"))
            val authentication = UsernamePasswordAuthenticationToken(userId, null, authorities)
            SecurityContextHolder.getContext().authentication = authentication

            logger.info { "WebSocket connection authenticated: user=$userId, role=$role" }
            return true
        } catch (e: Exception) {
            logger.error(e) { "WebSocket authentication error: ${e.message}" }
            response.setStatusCode(HttpStatus.UNAUTHORIZED)
            return false
        }
    }

    override fun afterHandshake(
        request: ServerHttpRequest,
        response: ServerHttpResponse,
        wsHandler: WebSocketHandler,
        exception: Exception?
    ) {
        if (exception != null) {
            logger.error(exception) { "WebSocket handshake failed: ${exception.message}" }
        }
    }

    /**
     * Extract a JWT token from a query parameter or Authorization header.
     */
    private fun extractToken(request: ServerHttpRequest): String? {
        // Try query parameter first (e.g., /stomp-direct/ws?token=xxx)
        val uri = UriComponentsBuilder.fromUri(request.uri).build()
        val queryToken = uri.queryParams["token"]?.firstOrNull()
        if (queryToken != null) {
            return queryToken
        }

        // Try Authorization header (e.g., Bearer xxx)
        val authHeader = request.headers["Authorization"]?.firstOrNull()
        if (authHeader != null && authHeader.startsWith("Bearer ")) {
            return authHeader.substring(7)
        }

        return null
    }
}
