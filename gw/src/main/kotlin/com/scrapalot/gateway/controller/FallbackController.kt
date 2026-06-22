package com.scrapalot.gateway.controller

import org.slf4j.LoggerFactory
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestMethod
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ServerWebExchange

/**
 * Fallback controller for circuit breaker responses
 *
 * Provides graceful degradation when backend services are unavailable.
 * Called when circuit breaker trips for scrapalot-backend or scrapalot-chat.
 */
@RestController
@RequestMapping("/fallback")
class FallbackController {

    private val logger = LoggerFactory.getLogger(FallbackController::class.java)

    /**
     * Fallback for scrapalot-backend (CRUD operations)
     *
     * Called when:
     * - Backend service is down
     * - Backend service is slow (timeout)
     * - Circuit breaker is open
     */
    @RequestMapping("/backend", method = [RequestMethod.GET, RequestMethod.POST, RequestMethod.PUT, RequestMethod.DELETE, RequestMethod.PATCH], produces = [MediaType.APPLICATION_JSON_VALUE])
    fun backendFallback(exchange: ServerWebExchange): ResponseEntity<FallbackResponse> {
        val path = exchange.request.uri.path
        logger.warn("Backend service unavailable, fallback triggered for: $path")

        return ResponseEntity
            .status(HttpStatus.SERVICE_UNAVAILABLE)
            .body(
                FallbackResponse(
                    error = "Service Unavailable",
                    message = "The backend service is temporarily unavailable. Please try again later.",
                    service = "scrapalot-backend",
                    retryAfter = 30
                )
            )
    }

    /**
     * Fallback for scrapalot-chat (AI/RAG operations)
     *
     * Called when:
     * - Chat service is down
     * - Chat service is slow (timeout on AI operations)
     * - Circuit breaker is open
     */
    @RequestMapping("/chat", method = [RequestMethod.GET, RequestMethod.POST, RequestMethod.PUT, RequestMethod.DELETE, RequestMethod.PATCH], produces = [MediaType.APPLICATION_JSON_VALUE])
    fun chatFallback(exchange: ServerWebExchange): ResponseEntity<FallbackResponse> {
        val path = exchange.request.uri.path
        logger.warn("Chat service unavailable, fallback triggered for: $path")

        return ResponseEntity
            .status(HttpStatus.SERVICE_UNAVAILABLE)
            .body(
                FallbackResponse(
                    error = "Service Unavailable",
                    message = "The AI service is temporarily unavailable. Please try again later.",
                    service = "scrapalot-chat",
                    retryAfter = 60
                )
            )
    }

    /**
     * Generic fallback for any service
     */
    @RequestMapping("/generic", method = [RequestMethod.GET, RequestMethod.POST, RequestMethod.PUT, RequestMethod.DELETE, RequestMethod.PATCH], produces = [MediaType.APPLICATION_JSON_VALUE])
    fun genericFallback(exchange: ServerWebExchange): ResponseEntity<FallbackResponse> {
        val path = exchange.request.uri.path
        logger.warn("Service unavailable, generic fallback triggered for: $path")

        return ResponseEntity
            .status(HttpStatus.SERVICE_UNAVAILABLE)
            .body(
                FallbackResponse(
                    error = "Service Unavailable",
                    message = "The requested service is temporarily unavailable. Please try again later.",
                    service = "unknown",
                    retryAfter = 30
                )
            )
    }
}

/**
 * Fallback response structure
 */
data class FallbackResponse(
    val error: String,
    val message: String,
    val service: String,
    val retryAfter: Int
)
