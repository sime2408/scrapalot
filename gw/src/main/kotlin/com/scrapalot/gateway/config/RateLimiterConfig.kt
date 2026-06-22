package com.scrapalot.gateway.config

import org.slf4j.LoggerFactory
import org.springframework.cloud.gateway.filter.ratelimit.KeyResolver
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Primary
import reactor.core.publisher.Mono

/**
 * Rate limiter configuration for API Gateway
 *
 * Provides key resolvers for Redis-backed rate limiting:
 * - User-based: Rate limit per authenticated user (X-User-ID header)
 * - IP-based: Fallback for unauthenticated requests
 * - Subscription tier-based: Different limits per tier
 */
@Configuration
class RateLimiterConfig {

    private val logger = LoggerFactory.getLogger(RateLimiterConfig::class.java)

    companion object {
        private const val USER_ID_HEADER = "X-User-ID"
        private const val SUBSCRIPTION_TIER_HEADER = "X-Subscription-Tier"
        private const val ANONYMOUS_KEY = "anonymous"
    }

    /**
     * Primary key resolver - uses user ID from JWT-extracted header
     *
     * Rate limiting key format: {userId}
     * Falls back to IP address for unauthenticated requests
     */
    @Bean
    @Primary
    fun userKeyResolver(): KeyResolver {
        return KeyResolver { exchange ->
            val userId = exchange.request.headers.getFirst(USER_ID_HEADER)

            if (userId != null) {
                logger.debug("Rate limiting key: user:$userId")
                Mono.just("user:$userId")
            } else {
                // Fallback to IP address for unauthenticated requests
                val clientIp = exchange.request.remoteAddress?.address?.hostAddress ?: ANONYMOUS_KEY
                logger.debug("Rate limiting key: ip:$clientIp")
                Mono.just("ip:$clientIp")
            }
        }
    }

    /**
     * Subscription tier-aware key resolver
     *
     * Rate limiting key format: {tier}:{userId}
     * Allows different rate limits per subscription tier
     */
    @Bean
    fun tierKeyResolver(): KeyResolver {
        return KeyResolver { exchange ->
            val userId = exchange.request.headers.getFirst(USER_ID_HEADER)
            val tier = exchange.request.headers.getFirst(SUBSCRIPTION_TIER_HEADER) ?: "researcher"

            if (userId != null) {
                Mono.just("$tier:$userId")
            } else {
                val clientIp = exchange.request.remoteAddress?.address?.hostAddress ?: ANONYMOUS_KEY
                Mono.just("$tier:$clientIp")
            }
        }
    }

    /**
     * IP-based key resolver for public endpoints
     *
     * Rate limiting key format: {ipAddress}
     */
    @Bean
    fun ipKeyResolver(): KeyResolver {
        return KeyResolver { exchange ->
            val clientIp = exchange.request.remoteAddress?.address?.hostAddress ?: ANONYMOUS_KEY
            Mono.just(clientIp)
        }
    }
}
