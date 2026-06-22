package com.scrapalot.gateway.config

import org.springframework.context.annotation.Configuration
import org.springframework.http.CacheControl
import org.springframework.web.reactive.config.ResourceHandlerRegistry
import org.springframework.web.reactive.config.WebFluxConfigurer
import java.util.concurrent.TimeUnit

/**
 * Configuration for serving static resources in Spring Cloud Gateway
 *
 * Spring Cloud Gateway (WebFlux) doesn't automatically serve static resources
 * from src/main/resources/static/ like traditional Spring Boot apps do.
 * This configuration enables serving of custom Swagger UI assets.
 */
@Configuration
class StaticResourceConfig : WebFluxConfigurer {

    override fun addResourceHandlers(registry: ResourceHandlerRegistry) {
        // Serve static resources from classpath:/static/
        registry
            .addResourceHandler("/**")
            .addResourceLocations("classpath:/static/")
            .setCacheControl(CacheControl.maxAge(1, TimeUnit.HOURS))
    }
}
