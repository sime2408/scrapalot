package com.scrapalot.gateway.filter

import org.slf4j.LoggerFactory
import org.springframework.cloud.gateway.filter.GatewayFilterChain
import org.springframework.cloud.gateway.filter.GlobalFilter
import org.springframework.core.Ordered
import org.springframework.stereotype.Component
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Mono
import java.time.Duration
import java.time.Instant

/**
 * Global logging filter for request/response monitoring
 *
 * Logs:
 * - Incoming request details (method, path, headers)
 * - Response status and duration
 * - User context from JWT (if authenticated)
 */
@Component
class LoggingFilter : GlobalFilter, Ordered {

    private val logger = LoggerFactory.getLogger(LoggingFilter::class.java)

    companion object {
        private const val START_TIME_ATTR = "startTime"
        private const val USER_ID_HEADER = "X-User-ID"
    }

    override fun getOrder(): Int = Ordered.HIGHEST_PRECEDENCE

    override fun filter(exchange: ServerWebExchange, chain: GatewayFilterChain): Mono<Void> {
        val request = exchange.request
        val startTime = Instant.now()

        // Store start time for duration calculation
        exchange.attributes[START_TIME_ATTR] = startTime

        // Log incoming request
        val method = request.method.name()
        val path = request.uri.path
        val userId = request.headers.getFirst(USER_ID_HEADER) ?: "anonymous"

        logger.debug(">>> {} {} [user: {}]", method, path, userId)

        return chain.filter(exchange).then(
            Mono.fromRunnable {
                val duration = Duration.between(startTime, Instant.now())
                val status = exchange.response.statusCode?.value() ?: 0

                if (status >= 500) {
                    logger.error("<<< {} {} [user: {}] - {} ({}ms)", method, path, userId, status, duration.toMillis())
                } else if (status >= 400) {
                    logger.warn("<<< {} {} [user: {}] - {} ({}ms)", method, path, userId, status, duration.toMillis())
                } else {
                    logger.debug("<<< {} {} [user: {}] - {} ({}ms)", method, path, userId, status, duration.toMillis())
                }
            }
        )
    }
}
