package com.scrapalot.backend.config

import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Configuration
import org.springframework.web.servlet.config.annotation.AsyncSupportConfigurer
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer

// Web MVC Configuration - Configures static resource handlers for serving uploaded files
@Configuration
class WebConfig(
    @param:Value("\${application.upload.path:/app/data/upload}") private val uploadPath: String
) : WebMvcConfigurer {
    // Configure resource handlers to serve uploaded files
    // Maps /upload/** URLs to the upload directory on disk
    // Example: /upload/profile_pictures/uuid.jpg -> /app/data/upload/profile_pictures/uuid.jpg
    override fun addResourceHandlers(registry: ResourceHandlerRegistry) {
        registry
            .addResourceHandler("/upload/**")
            .addResourceLocations("file:$uploadPath/")
            .setCachePeriod(3600) // Cache for 1 hour
    }

    // The OpenAI-compatible /v1/chat/completions endpoint streams via
    // StreamingResponseBody, which runs as a Spring MVC async request. The default
    // async request timeout cut long deep-research runs at ~10 min: the servlet
    // dispatched a timeout, the StreamingResponseBody was cancelled, and that
    // cancellation propagated down the gRPC stream to Python mid-synthesis (observed
    // as an external CancelledError at ~600s). Raise it to 30 min to match the nginx
    // and gateway (Resilience4j) streaming timeouts so a full iterative run completes.
    override fun configureAsyncSupport(configurer: AsyncSupportConfigurer) {
        configurer.setDefaultTimeout(1_800_000) // 30 minutes (ms)
    }
}
