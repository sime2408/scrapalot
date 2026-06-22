package com.scrapalot.backend.config

import com.scrapalot.backend.security.ApiKeyAuthenticationFilter
import com.scrapalot.backend.security.JwtAuthenticationFilter
import com.scrapalot.backend.security.JwtTokenProvider
import com.scrapalot.backend.security.UserDetailsServiceImpl
import com.scrapalot.backend.service.APIKeyService
import jakarta.servlet.DispatcherType
import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Lazy
import org.springframework.security.authentication.AuthenticationManager
import org.springframework.security.authentication.dao.DaoAuthenticationProvider
import org.springframework.security.config.annotation.authentication.configuration.AuthenticationConfiguration
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.core.userdetails.UserDetailsService
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.security.web.SecurityFilterChain
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter
import org.springframework.web.cors.CorsConfigurationSource

private val logger = KotlinLogging.logger {}

@Suppress("SpringAutowiredFieldsWarningInspection") // corsConfigurationSource requires optional field injection (circular dependency)
@Configuration
@EnableWebSecurity
@EnableMethodSecurity
class SecurityConfig(
    private val userDetailsService: UserDetailsService,
    private val jwtTokenProvider: JwtTokenProvider,
    @param:Lazy private val apiKeyService: APIKeyService,
    @param:Lazy private val userDetailsServiceImpl: UserDetailsServiceImpl
) {
    @Autowired(required = false)
    private val corsConfigurationSource: CorsConfigurationSource? = null

    @Bean
    fun passwordEncoder(): PasswordEncoder = BCryptPasswordEncoder()

    @Bean
    fun authenticationProvider(): DaoAuthenticationProvider {
        val authProvider = DaoAuthenticationProvider()
        authProvider.setUserDetailsService(userDetailsService)
        authProvider.setPasswordEncoder(passwordEncoder())
        return authProvider
    }

    @Bean
    fun authenticationManager(authConfig: AuthenticationConfiguration): AuthenticationManager = authConfig.authenticationManager

    @Bean
    fun filterChain(http: HttpSecurity): SecurityFilterChain {
        val activeProfile = System.getenv("SPRING_PROFILES_ACTIVE") ?: "prod"
        val isDevMode = activeProfile == "dev"

        http
            .csrf { it.disable() }
            .cors { cors ->
                // Check environment variable directly instead of relying on bean availability
                // This ensures CORS is ONLY enabled in dev profile, not in production
                if (isDevMode && corsConfigurationSource != null) {
                    logger.info("🔧 DEV MODE: CORS enabled for localhost (Spring profile: $activeProfile)")
                    cors.configurationSource(corsConfigurationSource)
                } else {
                    logger.info("🌐 PRODUCTION MODE: CORS disabled - handled by API Gateway (Spring profile: $activeProfile)")
                    cors.disable()
                }
            }.sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
            .authorizeHttpRequests { auth ->
                auth
                    // Allow async dispatch completion without re-authentication
                    .dispatcherTypeMatchers(DispatcherType.ASYNC)
                    .permitAll()
                    // Public endpoints (controllers have /api/v1 prefix, no context-path)
                    .requestMatchers("/api/v1/auth/login", "/api/v1/auth/register", "/api/v1/auth/google/**", "/api/v1/auth/invitation/**")
                    .permitAll()
                    .requestMatchers("/api/v1/users/register", "/api/v1/users/token", "/api/v1/users/refresh", "/api/v1/users/token/refresh", "/api/v1/users/token/session")
                    .permitAll()
                    .requestMatchers("/api/v1/users/desktop-auto-login")
                    .permitAll()
                    .requestMatchers("/api/v1/users/profile-pictures/**")
                    .permitAll() // Public profile pictures
                    .requestMatchers("/api/v1/notes/images/**")
                    .permitAll() // Public note images
                    .requestMatchers("/upload/**")
                    .permitAll() // Static file uploads (profile pictures, etc.)
                    .requestMatchers("/api/v1/desktop/**")
                    .permitAll()
                    // Stripe webhook (authenticated via Stripe signature, not JWT)
                    .requestMatchers("/api/v1/contact")
                    .permitAll() // Public contact form
                    .requestMatchers("/api/v1/subscriptions/webhook")
                    .permitAll()
                    .requestMatchers("/api/v1/shared/**")
                    .permitAll() // Public shared conversations
                    .requestMatchers("/actuator/**", "/api/v1/actuator/**")
                    .permitAll()
                    // WebSocket endpoints (authentication handled by JwtWebSocketHandshakeInterceptor)
                    .requestMatchers("/stomp-direct/**", "/stomp-backend/**", "/stomp/ws", "/ws/**")
                    .permitAll()
                    // Swagger/OpenAPI (if we add it later)
                    .requestMatchers("/swagger-ui/**", "/v3/api-docs/**")
                    .permitAll()
                    // All other endpoints require authentication
                    .anyRequest()
                    .authenticated()
            }.authenticationProvider(authenticationProvider())
            .addFilterBefore(JwtAuthenticationFilter(jwtTokenProvider, userDetailsService), UsernamePasswordAuthenticationFilter::class.java)
            .addFilterBefore(ApiKeyAuthenticationFilter(apiKeyService, userDetailsServiceImpl), JwtAuthenticationFilter::class.java)

        return http.build()
    }
}
