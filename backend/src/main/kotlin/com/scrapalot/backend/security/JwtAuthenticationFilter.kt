package com.scrapalot.backend.security

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.core.userdetails.UserDetailsService
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource
import org.springframework.util.StringUtils
import org.springframework.web.filter.OncePerRequestFilter
import java.util.*

class JwtAuthenticationFilter(
    private val jwtTokenProvider: JwtTokenProvider,
    private val userDetailsService: UserDetailsService
) : OncePerRequestFilter() {
    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain
    ) {
        try {
            // Skip if already authenticated (e.g., by ApiKeyAuthenticationFilter)
            if (SecurityContextHolder.getContext().authentication != null) {
                filterChain.doFilter(request, response)
                return
            }

            // Priority 1: Check for API Gateway headers (pre-authenticated by gateway)
            val gatewayUserEmail = request.getHeader("X-User-Email")
            if (gatewayUserEmail != null && gatewayUserEmail.isNotEmpty()) {
                logger.debug { "Using API Gateway pre-authenticated user: $gatewayUserEmail" }

                // Gateway has already validated the JWT - trust the user email
                val userDetails = userDetailsService.loadUserByUsername(gatewayUserEmail)

                val authentication =
                    UsernamePasswordAuthenticationToken(
                        userDetails,
                        null,
                        userDetails.authorities
                    )
                authentication.details = WebAuthenticationDetailsSource().buildDetails(request)

                SecurityContextHolder.getContext().authentication = authentication
                logger.debug { "Set authentication from gateway headers for user: $gatewayUserEmail" }

                filterChain.doFilter(request, response)
                return
            }

            // Priority 2: Check for direct JWT token (for direct backend access)
            val jwt = getJwtFromRequest(request)

            if (jwt != null && jwtTokenProvider.validateToken(jwt)) {
                val userIdString = jwtTokenProvider.getUsernameFromToken(jwt) // Returns UUID string

                if (userIdString != null) {
                    try {
                        // Parse UUID from token (JWT subclaim contains user ID, not username)
                        val userId = UUID.fromString(userIdString)
                        val userDetails = (userDetailsService as UserDetailsServiceImpl).loadUserById(userId)

                        val authentication =
                            UsernamePasswordAuthenticationToken(
                                userDetails,
                                null,
                                userDetails.authorities
                            )
                        authentication.details = WebAuthenticationDetailsSource().buildDetails(request)

                        SecurityContextHolder.getContext().authentication = authentication
                        logger.debug { "Set authentication from JWT for user ID: $userId" }
                    } catch (_: IllegalArgumentException) {
                        logger.error { "Invalid UUID format in JWT token: $userIdString" }
                    }
                }
            }
        } catch (ex: Exception) {
            logger.error { "Could not set user authentication in security context: ${ex.message}" }
        }

        filterChain.doFilter(request, response)
    }

    private fun getJwtFromRequest(request: HttpServletRequest): String? {
        val bearerToken = request.getHeader("Authorization")

        return if (StringUtils.hasText(bearerToken) && bearerToken.startsWith("Bearer ")) {
            bearerToken.substring(7)
        } else {
            null
        }
    }
}
