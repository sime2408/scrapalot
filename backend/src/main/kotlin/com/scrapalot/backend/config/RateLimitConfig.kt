package com.scrapalot.backend.config

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.web.servlet.FilterRegistrationBean
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.Ordered
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.web.filter.OncePerRequestFilter
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * Rate limiting configuration properties
 */
@ConfigurationProperties(prefix = "rate-limit")
data class RateLimitProperties(
    val enabled: Boolean = true,
    val login: LoginRateLimit = LoginRateLimit(),
    val register: RegisterRateLimit = RegisterRateLimit(),
    val global: GlobalRateLimit = GlobalRateLimit()
) {
    data class LoginRateLimit(
        val maxAttempts: Int = 5,
        val windowSeconds: Long = 60,
        val blockSeconds: Long = 300
    )

    data class RegisterRateLimit(
        val maxAttempts: Int = 3,
        val windowSeconds: Long = 3600
    )

    data class GlobalRateLimit(
        val maxRequests: Int = 100,
        val windowSeconds: Long = 60
    )
}

@Configuration(proxyBeanMethods = false)
class RateLimitConfig {
    @Bean
    fun rateLimitProperties(): RateLimitProperties = RateLimitProperties()

    @Bean
    fun rateLimitFilterRegistration(rateLimitProperties: RateLimitProperties): FilterRegistrationBean<RateLimitFilter> {
        val registration = FilterRegistrationBean(RateLimitFilter(rateLimitProperties))
        registration.order = Ordered.HIGHEST_PRECEDENCE + 10
        return registration
    }
}

/**
 * Rate limiting filter for authentication endpoints
 *
 * Protects /auth/login and /auth/register from brute force attacks.
 */
class RateLimitFilter(
    private val rateLimitProperties: RateLimitProperties
) : OncePerRequestFilter() {
    private val loginAttempts = ConcurrentHashMap<String, RateLimitBucket>()
    private val registerAttempts = ConcurrentHashMap<String, RateLimitBucket>()
    private val blockedIps = ConcurrentHashMap<String, Instant>()

    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain
    ) {
        if (!rateLimitProperties.enabled) {
            filterChain.doFilter(request, response)
            return
        }

        val path = request.requestURI
        val method = request.method
        val clientIp = getClientIp(request)

        // Check if IP is blocked
        val blockedUntil = blockedIps[clientIp]
        if (blockedUntil != null && Instant.now().isBefore(blockedUntil)) {
            val remainingSeconds = blockedUntil.epochSecond - Instant.now().epochSecond
            logger.warn { "Blocked IP attempted access: $clientIp, remaining: ${remainingSeconds}s" }
            sendRateLimitResponse(response, remainingSeconds)
            return
        } else if (blockedUntil != null) {
            blockedIps.remove(clientIp)
        }

        // Apply rate limiting for login endpoint
        if (path == "/auth/login" && method == "POST") {
            val bucket =
                loginAttempts.computeIfAbsent(clientIp) {
                    RateLimitBucket(
                        maxAttempts = rateLimitProperties.login.maxAttempts,
                        windowSeconds = rateLimitProperties.login.windowSeconds
                    )
                }

            if (!bucket.tryConsume()) {
                // Block the IP for extended period after too many attempts
                blockedIps[clientIp] = Instant.now().plusSeconds(rateLimitProperties.login.blockSeconds)
                logger.warn { "Rate limit exceeded for login: $clientIp, blocking for ${rateLimitProperties.login.blockSeconds}s" }
                sendRateLimitResponse(response, rateLimitProperties.login.blockSeconds)
                return
            }
        }

        // Apply rate limiting for register endpoint
        if (path == "/auth/register" && method == "POST") {
            val bucket =
                registerAttempts.computeIfAbsent(clientIp) {
                    RateLimitBucket(
                        maxAttempts = rateLimitProperties.register.maxAttempts,
                        windowSeconds = rateLimitProperties.register.windowSeconds
                    )
                }

            if (!bucket.tryConsume()) {
                logger.warn { "Rate limit exceeded for registration: $clientIp" }
                sendRateLimitResponse(response, rateLimitProperties.register.windowSeconds)
                return
            }
        }

        filterChain.doFilter(request, response)
    }

    private fun getClientIp(request: HttpServletRequest): String {
        val xForwardedFor = request.getHeader("X-Forwarded-For")
        return if (!xForwardedFor.isNullOrBlank()) {
            xForwardedFor.split(",").first().trim()
        } else {
            request.remoteAddr
        }
    }

    private fun sendRateLimitResponse(
        response: HttpServletResponse,
        retryAfterSeconds: Long
    ) {
        response.status = HttpStatus.TOO_MANY_REQUESTS.value()
        response.contentType = MediaType.APPLICATION_JSON_VALUE
        response.setHeader("Retry-After", retryAfterSeconds.toString())
        response.writer.write(
            """
            {
                "status": 429,
                "error": "Too Many Requests",
                "message": "Rate limit exceeded. Please try again later.",
                "retryAfter": $retryAfterSeconds
            }
            """.trimIndent()
        )
    }
}

/**
 * Simple sliding window rate limit bucket
 */
class RateLimitBucket(
    private val maxAttempts: Int,
    private val windowSeconds: Long
) {
    private val attempts = mutableListOf<Instant>()

    @Synchronized
    fun tryConsume(): Boolean {
        val now = Instant.now()
        val windowStart = now.minusSeconds(windowSeconds)

        // Remove expired attempts
        attempts.removeAll { it.isBefore(windowStart) }

        // Check if we can make another attempt
        if (attempts.size >= maxAttempts) {
            return false
        }

        attempts.add(now)
        return true
    }
}
