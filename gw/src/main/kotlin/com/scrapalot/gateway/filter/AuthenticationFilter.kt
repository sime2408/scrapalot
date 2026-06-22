package com.scrapalot.gateway.filter

import com.scrapalot.gateway.grpc.AuthGrpcClient
import com.scrapalot.gateway.security.JwtTokenProvider
import org.slf4j.LoggerFactory
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.core.context.ReactiveSecurityContextHolder
import org.springframework.stereotype.Component
import org.springframework.web.server.ServerWebExchange
import org.springframework.web.server.WebFilter
import org.springframework.web.server.WebFilterChain
import reactor.core.publisher.Mono

/**
 * Authentication filter for validating JWT tokens and API keys
 *
 * Features:
 * - JWT token validation (Authorization: Bearer <token>)
 * - API key validation (X-API-Key: scp-xxxx) - Phase 2
 * - User context extraction and propagation via headers
 * - Graceful handling of missing/invalid tokens
 */
@Component
class AuthenticationFilter(
    private val jwtTokenProvider: JwtTokenProvider,
    private val authGrpcClient: AuthGrpcClient
) : WebFilter {

    private val logger = LoggerFactory.getLogger(AuthenticationFilter::class.java)

    companion object {
        private const val BEARER_PREFIX = "Bearer "
        private const val API_KEY_PREFIX = "scp-"
        private const val API_KEY_HEADER = "X-API-Key"
        private const val USER_ID_HEADER = "X-User-ID"
        private const val USER_EMAIL_HEADER = "X-User-Email"
        private const val USER_ROLE_HEADER = "X-User-Role"
        private const val SUBSCRIPTION_TIER_HEADER = "X-Subscription-Tier"
        private const val API_KEY_ID_HEADER = "X-API-Key-ID"
    }

    override fun filter(exchange: ServerWebExchange, chain: WebFilterChain): Mono<Void> {
        val request = exchange.request
        val path = request.uri.path

        // Skip authentication for public endpoints (handled by SecurityConfig)
        if (isPublicEndpoint(path)) {
            return chain.filter(exchange)
        }

        // Extract token from Authorization header. Two flavours share this header:
        //  - JWTs (`Bearer eyJ...`) — issued by /api/v1/auth/login
        //  - Scrapalot API keys (`Bearer scp-...`) — used by the OpenAI-compatible
        //    /v1/chat/completions surface (CATEGORY_05 §5.4) so any OpenAI SDK
        //    client works without a custom header. Disambiguate by prefix; route
        //    API keys through the existing gRPC validation path so we share the
        //    DB lookup + last_used_at update.
        val authHeader = request.headers.getFirst(HttpHeaders.AUTHORIZATION)
        if (authHeader != null && authHeader.startsWith(BEARER_PREFIX)) {
            val token = authHeader.substring(BEARER_PREFIX.length)
            return if (token.startsWith(API_KEY_PREFIX)) {
                handleApiKeyAuthentication(exchange, chain, token)
            } else {
                handleJwtAuthentication(exchange, chain, token)
            }
        }

        // Extract API key from X-API-Key header (legacy CLI / curl convention)
        val apiKey = request.headers.getFirst(API_KEY_HEADER)
        if (apiKey != null && apiKey.startsWith(API_KEY_PREFIX)) {
            return handleApiKeyAuthentication(exchange, chain, apiKey)
        }

        // No authentication provided - let SecurityConfig handle it (will return 401)
        logger.debug("No authentication credentials found for path: $path")
        return chain.filter(exchange)
    }

    /**
     * Handle JWT token authentication
     */
    private fun handleJwtAuthentication(
        exchange: ServerWebExchange,
        chain: WebFilterChain,
        token: String
    ): Mono<Void> {
        return try {
            // Validate JWT token
            val userContext = jwtTokenProvider.extractUserContext(token)

            if (userContext == null) {
                logger.warn("Invalid JWT token")
                return unauthorizedResponse(exchange, "Invalid or expired token")
            }

            // Add user context headers for downstream services
            val mutatedRequest = exchange.request.mutate()
                .header(USER_ID_HEADER, userContext.userId)
                .header(USER_EMAIL_HEADER, userContext.email ?: "")
                .header(USER_ROLE_HEADER, userContext.role)
                .header(SUBSCRIPTION_TIER_HEADER, userContext.subscriptionTier)
                .build()

            val mutatedExchange = exchange.mutate().request(mutatedRequest).build()

            // Create Spring Security authentication
            val authorities = listOf(SimpleGrantedAuthority("ROLE_${userContext.role}"))
            val authentication = UsernamePasswordAuthenticationToken(
                userContext.userId,
                null,
                authorities
            )

            // Set authentication in a reactive security context
            return chain.filter(mutatedExchange)
                .contextWrite(ReactiveSecurityContextHolder.withAuthentication(authentication))

        } catch (e: Exception) {
            logger.error("JWT authentication failed: ${e.message}", e)
            unauthorizedResponse(exchange, "Authentication failed")
        }
    }

    /**
     * Handle API key authentication via gRPC
     *
     * Calls scrapalot-backend AuthService.ValidateAPIKey to validate the API key
     */
    private fun handleApiKeyAuthentication(
        exchange: ServerWebExchange,
        chain: WebFilterChain,
        apiKey: String
    ): Mono<Void> {
        return try {
            logger.debug("Validating API key via gRPC: ${apiKey.take(10)}...")

            // Call gRPC AuthService.ValidateAPIKey
            val validationResponse = authGrpcClient.validateAPIKey(apiKey)

            if (validationResponse == null || !validationResponse.valid) {
                logger.warn("Invalid API key")
                return unauthorizedResponse(exchange, "Invalid or expired API key")
            }

            // Extract user ID and key ID from a validation response
            val userId = validationResponse.userId.value
            val keyId = validationResponse.keyId.value

            logger.info("API key validated successfully: userId=$userId, keyId=$keyId")

            // Add user context headers for downstream services
            val mutatedRequest = exchange.request.mutate()
                .header(USER_ID_HEADER, userId)
                .header(USER_ROLE_HEADER, "USER") // API keys default to USER role
                .header(SUBSCRIPTION_TIER_HEADER, "researcher") // Default tier for API keys
                .header(API_KEY_ID_HEADER, keyId)
                .build()

            val mutatedExchange = exchange.mutate().request(mutatedRequest).build()

            // Create Spring Security authentication
            val authorities = listOf(SimpleGrantedAuthority("ROLE_USER"))
            val authentication = UsernamePasswordAuthenticationToken(
                userId,
                null,
                authorities
            )

            // Set authentication in reactive security context
            chain.filter(mutatedExchange)
                .contextWrite(ReactiveSecurityContextHolder.withAuthentication(authentication))

        } catch (e: Exception) {
            logger.error("API key authentication failed: ${e.message}", e)
            unauthorizedResponse(exchange, "Authentication failed")
        }
    }

    /**
     * Check if the endpoint is public (no authentication required)
     */
    private fun isPublicEndpoint(path: String): Boolean {
        return path.startsWith("/actuator/health") ||
                path == "/health" ||
                path.startsWith("/api/v1/desktop/") ||
                path.startsWith("/fallback/") ||
                path == "/api/v1/users/token" ||
                path.startsWith("/api/v1/users/token/") ||
                path == "/api/v1/users/login" ||
                path == "/api/v1/users/register" ||
                path == "/api/v1/auth/login" ||
                path == "/api/v1/auth/register" ||
                path.startsWith("/api/v1/auth/invitation/") ||
                path.startsWith("/api/v1/auth/callback/") ||
                path == "/api/v1/auth/google/callback" ||  // Google OAuth callback
                path == "/api/v1/auth/google/config" ||    // Google OAuth config
                path == "/api/v1/subscriptions/webhook" ||  // Stripe webhook (authenticated via signature)
                path.startsWith("/upload/profile_pictures/") ||  // Profile pictures (backward compatible)
                path.startsWith("/api/v1/users/profile-pictures/") ||  // Profile pictures (new endpoint)
                path.startsWith("/api/v1/shared/") ||  // Public shared conversations
                // WebSocket endpoints (authentication handled by backend interceptors)
                path.startsWith("/stomp-backend/ws") ||
                path.startsWith("/stomp-direct/ws") ||
                path.startsWith("/stomp/") ||
                path.startsWith("/ws/") ||
                path.startsWith("/api/ws/notes/")
    }

    /**
     * Return 401 Unauthorized response
     */
    private fun unauthorizedResponse(exchange: ServerWebExchange, message: String): Mono<Void> {
        exchange.response.statusCode = HttpStatus.UNAUTHORIZED
        exchange.response.headers.add(HttpHeaders.CONTENT_TYPE, "application/json")

        val errorResponse = """{"error": "Unauthorized", "message": "$message"}"""
        val buffer = exchange.response.bufferFactory().wrap(errorResponse.toByteArray())

        return exchange.response.writeWith(Mono.just(buffer))
    }
}
