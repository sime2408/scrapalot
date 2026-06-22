package com.scrapalot.backend.config

import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.CorsConfigurationSource
import org.springframework.web.cors.UrlBasedCorsConfigurationSource

@Configuration
@Profile("!dev")
class CorsConfig(
    @param:Value("\${cors.allowed-origins}")
    private val allowedOrigins: String,
    @param:Value("\${cors.allowed-methods}")
    private val allowedMethods: String,
    @param:Value("\${cors.allowed-headers}")
    private val allowedHeaders: String,
    @param:Value("\${cors.allow-credentials}")
    private val allowCredentials: Boolean,
    @param:Value("\${cors.max-age}")
    private val maxAge: Long
) {
    @Bean
    fun corsConfigurationSource(): CorsConfigurationSource {
        val configuration = CorsConfiguration()

        configuration.allowedOrigins = allowedOrigins.split(",").map { it.trim() }
        configuration.allowedMethods = allowedMethods.split(",").map { it.trim() }
        configuration.allowedHeaders =
            if (allowedHeaders == "*") {
                listOf("*")
            } else {
                allowedHeaders.split(",").map { it.trim() }
            }
        configuration.allowCredentials = allowCredentials
        configuration.maxAge = maxAge

        val source = UrlBasedCorsConfigurationSource()
        source.registerCorsConfiguration("/**", configuration)

        return source
    }
}
