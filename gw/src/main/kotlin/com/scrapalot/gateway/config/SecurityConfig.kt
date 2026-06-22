package com.scrapalot.gateway.config

import com.scrapalot.gateway.filter.AuthenticationFilter
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.io.buffer.DataBuffer
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity
import org.springframework.security.config.web.server.SecurityWebFiltersOrder
import org.springframework.security.config.web.server.ServerHttpSecurity
import org.springframework.security.web.server.SecurityWebFilterChain
import org.springframework.security.web.server.context.NoOpServerSecurityContextRepository
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.reactive.CorsConfigurationSource
import org.springframework.web.cors.reactive.UrlBasedCorsConfigurationSource
import reactor.core.publisher.Mono

/**
 * Security configuration for Scrapalot API Gateway
 *
 * Features:
 * - JWT token validation (centralized)
 * - API key authentication (for desktop app)
 * - Public health endpoints
 * - CORS configuration
 * - Stateless session management (no session cookies)
 */
@Configuration
@EnableWebFluxSecurity
class SecurityConfig(
    private val authenticationFilter: AuthenticationFilter
) {

    @Bean
    fun securityWebFilterChain(http: ServerHttpSecurity): SecurityWebFilterChain {
        return http
            // Disable CSRF (stateless API, using JWT)
            .csrf { it.disable() }

            // Disable default form login and HTTP basic
            .formLogin { it.disable() }
            .httpBasic { it.disable() }

            // Stateless session management (no session cookies)
            .securityContextRepository(NoOpServerSecurityContextRepository.getInstance())

            // CORS configuration - handled by globalcors in application.yml
            // NOTE: Do NOT disable CORS here - globalcors configuration will be used

            // Authorization rules
            .authorizeExchange { exchanges ->
                exchanges
                    // Public endpoints (no authentication)
                    .pathMatchers("/actuator/health", "/health").permitAll()
                    .pathMatchers(HttpMethod.OPTIONS, "/**").permitAll() // CORS preflight

                    // Swagger/OpenAPI UI (public access)
                    .pathMatchers("/swagger-ui/**", "/swagger-ui.html").permitAll()
                    .pathMatchers("/v3/api-docs/**").permitAll()
                    .pathMatchers("/api-docs/**").permitAll() // Proxy routes for Backend/Chat OpenAPI docs
                    .pathMatchers("/webjars/**").permitAll()
                    .pathMatchers("/").permitAll() // Root path for Swagger UI
                    .pathMatchers("/swagger-ui-custom.css", "/swagger-initializer.js").permitAll() // Custom Swagger assets

                    // Fallback endpoints (circuit breaker responses)
                    .pathMatchers("/fallback/**").permitAll()

                    // Desktop API (no auth required in Phase 1)
                    .pathMatchers("/api/v1/desktop/**").permitAll()

                    // Login and registration endpoints (public)
                    .pathMatchers("/api/v1/users/token", "/api/v1/users/token/**").permitAll()
                    .pathMatchers("/api/v1/users/login", "/api/v1/users/register").permitAll()
                    .pathMatchers("/api/v1/auth/login", "/api/v1/auth/register").permitAll()
                    .pathMatchers("/api/v1/auth/invitation/**").permitAll()
                    .pathMatchers("/api/v1/auth/callback/**").permitAll()

                    // Google OAuth endpoints (public)
                    .pathMatchers(HttpMethod.GET, "/api/v1/auth/google/callback").permitAll()
                    .pathMatchers(HttpMethod.GET, "/api/v1/auth/google/config").permitAll()
                    // Native mobile Google Sign-In (id_token exchange, pre-auth)
                    .pathMatchers(HttpMethod.POST, "/api/v1/auth/google/mobile").permitAll()

                    // Public contact form (no auth required)
                    .pathMatchers(HttpMethod.POST, "/api/v1/contact").permitAll()

                    // Stripe webhook endpoint (public - authenticated via signature)
                    .pathMatchers(HttpMethod.POST, "/api/v1/subscriptions/webhook").permitAll()

                    // Shared conversations (public, no auth)
                    .pathMatchers(HttpMethod.GET, "/api/v1/shared/**").permitAll()

                    // Profile pictures and uploads (public static files)
                    .pathMatchers("/upload/**").permitAll()
                    .pathMatchers("/api/v1/users/profile-pictures/**").permitAll()

                    // WebSocket endpoints (authentication handled by backend interceptors)
                    .pathMatchers("/stomp-direct/ws", "/stomp-direct/ws/**").permitAll()
                    .pathMatchers("/stomp-backend/ws", "/stomp-backend/ws/**").permitAll()
                    .pathMatchers("/stomp/**", "/ws/**").permitAll()
                    .pathMatchers("/api/ws/notes/**").permitAll() // Y.js notes collaboration (token via query param)

                    // All other endpoints require authentication
                    .anyExchange().authenticated()
            }

            // Add a custom JWT/API key authentication filter
            .addFilterAt(authenticationFilter, SecurityWebFiltersOrder.AUTHENTICATION)

            // Custom exception handling (no Basic auth challenge)
            .exceptionHandling { exceptionHandling ->
                exceptionHandling.authenticationEntryPoint { exchange, _ ->
                    exchange.response.statusCode = HttpStatus.UNAUTHORIZED
                    exchange.response.headers.contentType = MediaType.APPLICATION_JSON

                    val errorJson = """{"error":"Unauthorized","message":"Authentication required. Please provide a valid JWT token in the Authorization header."}"""
                    val buffer: DataBuffer = exchange.response.bufferFactory().wrap(errorJson.toByteArray())

                    exchange.response.writeWith(Mono.just(buffer))
                }
            }

            .build()
    }

    /**
     * CORS configuration for cross-origin requests from frontend
     */
    @Bean
    fun corsConfigurationSource(): CorsConfigurationSource {
        val configuration = CorsConfiguration()

        // Allowed origins (updated from application.yml)
        configuration.allowedOrigins = listOf(
            "http://localhost:3000",
            "https://scrapalot.app",
            "https://www.scrapalot.app"
        )

        // Allowed methods
        configuration.allowedMethods = listOf(
            "GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"
        )

        // Allowed headers
        configuration.allowedHeaders = listOf("*")

        // Exposed headers (needed for custom headers)
        configuration.exposedHeaders = listOf(
            "Authorization",
            "X-Total-Count",
            "X-User-ID",
            "X-User-Role",
            "X-Subscription-Tier"
        )

        // Allow credentials (cookies, authorization headers)
        configuration.allowCredentials = true

        // Max age for preflight cache (1 hour)
        configuration.maxAge = 3600L

        val source = UrlBasedCorsConfigurationSource()
        source.registerCorsConfiguration("/**", configuration)

        return source
    }
}
