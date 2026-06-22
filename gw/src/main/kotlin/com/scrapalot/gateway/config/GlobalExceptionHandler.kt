package com.scrapalot.gateway.config

import org.slf4j.LoggerFactory
import org.springframework.boot.web.reactive.error.ErrorWebExceptionHandler
import org.springframework.context.annotation.Configuration
import org.springframework.core.annotation.Order
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Mono
import reactor.netty.channel.AbortedException

/**
 * Global exception handler for the API Gateway
 *
 * Provides consistent error responses for:
 * - Gateway routing errors
 * - Upstream service errors
 * - Authentication/authorization errors
 * - Client disconnection (AbortedException)
 */
@Configuration
@Order(-2) // Run before Spring's default error handler
class GlobalExceptionHandler : ErrorWebExceptionHandler {

    private val logger = LoggerFactory.getLogger(GlobalExceptionHandler::class.java)

    override fun handle(exchange: ServerWebExchange, ex: Throwable): Mono<Void> {
        val response = exchange.response
        val path = exchange.request.uri.path

        // If the response is already committed (headers sent), we cannot write an error body.
        // This happens when the upstream started streaming a response and the client disconnected.
        if (response.isCommitted) {
            logger.debug("Response already committed for path: $path, ignoring error: ${ex.javaClass.simpleName}")
            return Mono.empty()
        }

        // Client disconnected before we could send the response - nothing to do
        if (ex is AbortedException || ex.cause is AbortedException) {
            logger.debug("Client disconnected before response for path: $path")
            return Mono.empty()
        }

        // Determine the status code and message based on an exception type
        val (status, message) = when (ex) {
            is java.net.ConnectException -> {
                logger.error("Connection refused to upstream service for path: $path", ex)
                HttpStatus.BAD_GATEWAY to "Unable to connect to upstream service"
            }
            is java.util.concurrent.TimeoutException -> {
                logger.error("Timeout waiting for upstream service for path: $path", ex)
                HttpStatus.GATEWAY_TIMEOUT to "Upstream service timed out"
            }
            is org.springframework.web.server.ResponseStatusException -> {
                logger.warn("Response status exception for path: $path - ${ex.message}")
                ex.statusCode as HttpStatus to (ex.reason ?: "Request failed")
            }
            is java.io.IOException -> {
                logger.debug("I/O error (likely client disconnect) for path: $path - ${ex.message}")
                return Mono.empty()
            }
            else -> {
                logger.error("Unexpected error for path: $path", ex)
                HttpStatus.INTERNAL_SERVER_ERROR to "An unexpected error occurred"
            }
        }

        response.statusCode = status
        response.headers.contentType = MediaType.APPLICATION_JSON

        val errorJson = """
            {
                "error": "${status.reasonPhrase}",
                "message": "$message",
                "status": ${status.value()},
                "path": "$path"
            }
        """.trimIndent()

        val buffer = response.bufferFactory().wrap(errorJson.toByteArray())
        return response.writeWith(Mono.just(buffer))
    }
}
