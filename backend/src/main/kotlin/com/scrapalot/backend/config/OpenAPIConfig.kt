package com.scrapalot.backend.config

import io.swagger.v3.oas.models.Components
import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.info.Contact
import io.swagger.v3.oas.models.info.Info
import io.swagger.v3.oas.models.info.License
import io.swagger.v3.oas.models.security.SecurityRequirement
import io.swagger.v3.oas.models.security.SecurityScheme
import io.swagger.v3.oas.models.servers.Server
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration
class OpenAPIConfig {
    @field:Value("\${server.port:8091}")
    private val serverPort: String = "8091"

    @field:Value("\${server.servlet.context-path:/api/v1}")
    private val contextPath: String = "/api/v1"

    @field:Value("\${spring.profiles.active:dev}")
    private val activeProfile: String = "dev"

    @Bean
    fun openAPI(): OpenAPI {
        val serverUrl =
            if (activeProfile == "prod") {
                "https://api.scrapalot.app$contextPath"
            } else {
                "http://localhost:$serverPort$contextPath"
            }

        return OpenAPI()
            .info(
                Info()
                    .title("Scrapalot Backend API")
                    .description(
                        """
                        Spring Boot + Kotlin backend for Scrapalot RAG application.

                        This API handles:
                        - User authentication and authorization (JWT)
                        - Workspace and collection management
                        - Document metadata (processing handled by Python service)
                        - Collaborative notes with versioning
                        - User and server settings management
                        - API key management
                        - Subscription management

                        **Note**: Document processing, RAG strategies, and LLM interactions
                        are handled by the Python FastAPI service (port 8090).
                        """.trimIndent()
                    ).version("1.0.0")
                    .contact(
                        Contact()
                            .name("Scrapalot Team")
                            .url("https://scrapalot.app")
                            .email("support@mail.scrapalot.app")
                    ).license(
                        License()
                            .name("Proprietary")
                            .url("https://scrapalot.app")
                    )
            ).servers(
                listOf(
                    Server()
                        .url(serverUrl)
                        .description("${activeProfile.uppercase()} Server")
                )
            ).components(
                Components()
                    .addSecuritySchemes(
                        "bearerAuth",
                        SecurityScheme()
                            .type(SecurityScheme.Type.HTTP)
                            .scheme("bearer")
                            .bearerFormat("JWT")
                            .description("JWT authentication token. Obtain via /auth/login or /auth/register")
                    )
            ).addSecurityItem(
                SecurityRequirement().addList("bearerAuth")
            )
    }
}
