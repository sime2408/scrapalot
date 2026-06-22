package com.scrapalot.gateway.controller

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.io.ClassPathResource
import org.springframework.http.MediaType
import org.springframework.web.reactive.function.server.RouterFunction
import org.springframework.web.reactive.function.server.ServerResponse
import org.springframework.web.reactive.function.server.router

/**
 * Router for serving custom Swagger UI index page
 *
 * Overrides default Springdoc redirect to serve our custom-branded Swagger UI.
 * The custom HTML loads Scrapalot branding (colors, logo, styling).
 */
@Configuration
class SwaggerUiRouter {

    /**
     * Serve a custom Swagger UI index page at a root path
     */
    @Bean
    fun swaggerUiRoute(): RouterFunction<ServerResponse> = router {
        GET("/") {
            ServerResponse.ok()
                .contentType(MediaType.TEXT_HTML)
                .bodyValue(ClassPathResource("static/index.html").inputStream.readBytes())
        }

        // Redirect default webjars Swagger UI to a custom version
        GET("/webjars/swagger-ui/index.html") {
            ServerResponse.permanentRedirect(java.net.URI.create("/")).build()
        }
    }
}
