package com.scrapalot.gateway.controller

import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import java.time.Instant

/**
 * Health check controller for the API Gateway
 *
 * Provides simple health check endpoints for:
 * - Load balancers (Nginx, ALB, etc.)
 * - Docker health checks
 * - Kubernetes liveness/readiness probes
 */
@RestController
class HealthController {

    private val startTime = Instant.now()

    /**
     * Simple health check endpoint
     *
     * Returns 200 OK if the gateway is running
     */
    // produces = ALL_VALUE so the endpoint serves any Accept header (browser
    // probes send text/html; load balancers sometimes send text/plain). The
    // body is still JSON via the explicit Content-Type below.
    @GetMapping("/health", produces = [MediaType.ALL_VALUE])
    fun health(): ResponseEntity<HealthResponse> {
        return ResponseEntity.ok()
            .contentType(MediaType.APPLICATION_JSON)
            .body(
                HealthResponse(
                    status = "UP",
                    service = "scrapalot-gw",
                    version = "1.0.0",
                    uptime = java.time.Duration.between(startTime, Instant.now()).seconds
                )
            )
    }
}

/**
 * Health response structure
 */
data class HealthResponse(
    val status: String,
    val service: String,
    val version: String,
    val uptime: Long
)
