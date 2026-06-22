package com.scrapalot.gateway

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

/**
 * Scrapalot API Gateway Application
 *
 * Single entry point for all frontend requests. Routes traffic to:
 * - scrapalot-backend (Spring Boot) - Business logic, CRUD operations
 * - scrapalot-chat (Python FastAPI) - AI/RAG, LLM inference, deep research
 *
 * Features:
 * - JWT/API key authentication (centralized)
 * - API versioning support (/api/v1, /api/v2)
 * - Rate limiting (Redis-backed)
 * - Circuit breakers (Resilience4j)
 * - Distributed tracing (Micrometer + Zipkin)
 *
 * Note: gRPC support is disabled for Phase 1 (transparent proxy to scrapalot-chat).
 * Phase 2 TODO: Re-enable gRPC for API key validation via gRPC.
 */
@SpringBootApplication
class GatewayApplication

fun main(args: Array<String>) {
    runApplication<GatewayApplication>(*args)
}
