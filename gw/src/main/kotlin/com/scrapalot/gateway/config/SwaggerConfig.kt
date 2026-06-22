package com.scrapalot.gateway.config

import io.swagger.v3.oas.models.Components
import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.info.Contact
import io.swagger.v3.oas.models.info.Info
import io.swagger.v3.oas.models.info.License
import io.swagger.v3.oas.models.security.SecurityRequirement
import io.swagger.v3.oas.models.security.SecurityScheme
import io.swagger.v3.oas.models.servers.Server
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/**
 * Swagger/OpenAPI configuration for Scrapalot API Gateway
 *
 * Features:
 * - Aggregated API docs from Backend (Kotlin) and Chat (Python) services
 * - JWT Bearer authentication configuration
 * - Interactive API testing with Swagger UI
 * - Available at: https://api.scrapalot.app/swagger-ui.html
 */
@Configuration
class SwaggerConfig {

    @Bean
    fun customOpenAPI(): OpenAPI {
        return OpenAPI()
            .info(
                Info()
                    .title("Scrapalot API Gateway")
                    .version("1.0.0")
                    .description(
                        """
                        **Scrapalot API Gateway** - Unified API for Research Platform
                        
                        This gateway aggregates APIs from:
                        - **Backend Service** (Kotlin): Authentication, Users, Workspaces, Collections, Notes
                        - **Chat Service** (Python): AI Chat, RAG Queries, Document Processing, Deep Research
                        
                        ## Authentication
                        1. Login via `/api/v1/auth/login` with username/password
                        2. Copy the JWT token from response
                        3. Click "Authorize" button above and paste token
                        4. All requests will include: `Authorization: Bearer <token>`
                        
                        ## Available Services
                        - **Backend API**: User management, workspaces, collections, notes
                        - **Chat API**: AI-powered chat, RAG queries, document processing
                        """.trimIndent()
                    )
                    .contact(
                        Contact()
                            .name("Scrapalot Team")
                            .url("https://scrapalot.app")
                            .email("support@mail.scrapalot.app")
                    )
                    .license(
                        License()
                            .name("Proprietary")
                            .url("https://scrapalot.app/license")
                    )
            )
            .servers(
                listOf(
                    Server().url("https://api.scrapalot.app").description("Production Gateway"),
                    Server().url("http://localhost:8080").description("Local Gateway")
                )
            )
            .components(
                Components()
                    .addSecuritySchemes(
                        "Bearer Authentication",
                        SecurityScheme()
                            .type(SecurityScheme.Type.HTTP)
                            .scheme("bearer")
                            .bearerFormat("JWT")
                            .description("JWT token obtained from /api/v1/auth/login endpoint")
                    )
            )
            .addSecurityItem(
                SecurityRequirement().addList("Bearer Authentication")
            )
    }
}
