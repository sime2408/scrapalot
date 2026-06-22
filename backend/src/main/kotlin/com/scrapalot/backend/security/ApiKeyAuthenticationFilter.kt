package com.scrapalot.backend.security

import com.scrapalot.backend.service.APIKeyService
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.HttpHeaders
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource
import org.springframework.web.filter.OncePerRequestFilter

/**
 * Accepts Scrapalot API keys (prefix `scp-`) via two header conventions:
 *  1. `X-API-Key: scp-...` — original Scrapalot convention, used by CLI / curl.
 *  2. `Authorization: Bearer scp-...` — OpenAI-compatible API surface.
 *     The OpenAI Python/JS SDKs always send the `Authorization: Bearer <key>`
 *     header, so the OpenAI-compat shim at /v1/chat/completions can only
 *     authenticate users this way.
 *
 * Bearer tokens whose value does NOT start with `scp-` are passed through
 * untouched — JwtAuthenticationFilter (registered after this one) handles
 * JWTs (`eyJ...`) on the same header.
 */
class ApiKeyAuthenticationFilter(
    private val apiKeyService: APIKeyService,
    private val userDetailsService: UserDetailsServiceImpl
) : OncePerRequestFilter() {
    companion object {
        private const val API_KEY_PREFIX = "scp-"
        private const val BEARER_PREFIX = "Bearer "
    }

    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain
    ) {
        runCatching {
            extractApiKey(request)
                ?.takeIf { SecurityContextHolder.getContext().authentication == null }
                ?.let { plaintext -> authenticate(plaintext, request) }
        }.onFailure { ex -> logger.error { "Could not authenticate via API key: ${ex.message}" } }

        filterChain.doFilter(request, response)
    }

    /**
     * Pull a Scrapalot API key out of either the `X-API-Key` header or an
     * `Authorization: Bearer scp-...` header. Returns null if neither header
     * carries something that looks like a Scrapalot API key.
     */
    private fun extractApiKey(request: HttpServletRequest): String? {
        request
            .getHeader("X-API-Key")
            ?.takeIf { it.startsWith(API_KEY_PREFIX) }
            ?.let { return it }

        return request
            .getHeader(HttpHeaders.AUTHORIZATION)
            ?.takeIf { it.startsWith(BEARER_PREFIX) }
            ?.removePrefix(BEARER_PREFIX)
            ?.takeIf { it.startsWith(API_KEY_PREFIX) }
    }

    private fun authenticate(
        plaintext: String,
        request: HttpServletRequest
    ) {
        val apiKey = apiKeyService.validateAPIKey(plaintext)
        if (apiKey == null) {
            logger.debug { "Invalid or expired API key with header prefix: ${plaintext.take(8)}" }
            return
        }
        val userDetails = userDetailsService.loadUserById(apiKey.userId)
        val auth =
            UsernamePasswordAuthenticationToken(userDetails, null, userDetails.authorities).apply {
                details = WebAuthenticationDetailsSource().buildDetails(request)
            }
        SecurityContextHolder.getContext().authentication = auth
        logger.debug { "Set authentication from API key for user: ${apiKey.userId}, key prefix: ${apiKey.keyPrefix}" }
    }
}
