package com.scrapalot.backend.config

import mu.KotlinLogging
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.CorsConfigurationSource
import org.springframework.web.cors.UrlBasedCorsConfigurationSource

private val logger = KotlinLogging.logger {}

/**
 * CORS configuration for local development only.
 *
 * In production, CORS is handled by the API Gateway (scrapalot-gw).
 * This configuration is only active when the 'dev' profile is enabled.
 *
 * Usage:
 * - Local development: ./gradlew bootRun --args='--spring.profiles.active=dev'
 * - Production: CORS disabled, handled by gateway
 */
@Configuration
@Profile("dev")
class CorsDevConfig {
    init {
        logger.warn("⚠️  CorsDevConfig LOADED - This should ONLY happen in dev profile!")
    }

    @Bean
    fun corsConfigurationSource(): CorsConfigurationSource {
        logger.info("🔧 DEV MODE: Enabling CORS for local development")

        val configuration =
            CorsConfiguration().apply {
                // Allow frontend origins for local development
                allowedOrigins =
                    listOf(
                        "http://localhost:3000", // React dev server
                        "http://127.0.0.1:3000", // Alternative localhost
                        "http://localhost:5173", // Vite dev server
                        "http://127.0.0.1:5173" // Alternative Vite
                    )

                // Allow all common HTTP methods
                allowedMethods = listOf("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD")

                // Allow all headers (including Authorization for JWT)
                allowedHeaders = listOf("*")

                // Expose all headers to the frontend
                exposedHeaders = listOf("*")

                // Allow credentials (cookies, JWT tokens)
                allowCredentials = true

                // Cache preflight responses for 1 hour
                maxAge = 3600L
            }

        val source = UrlBasedCorsConfigurationSource()
        source.registerCorsConfiguration("/**", configuration)

        logger.info("CORS configured for local development: ${configuration.allowedOrigins}")

        return source
    }
}
