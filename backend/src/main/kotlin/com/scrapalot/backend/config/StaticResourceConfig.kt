package com.scrapalot.backend.config

import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Configuration
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer

/**
 * Configure static resource serving for uploaded files (profile pictures, documents, etc.)
 */
@Configuration
class StaticResourceConfig(
    @param:Value("\${application.upload.path:/app/data/upload}")
    private val uploadPath: String
) : WebMvcConfigurer {
    override fun addResourceHandlers(registry: ResourceHandlerRegistry) {
        // Serve uploaded files from /upload/** URL pattern
        registry
            .addResourceHandler("/upload/**")
            .addResourceLocations("file:$uploadPath/")
            .setCachePeriod(3600) // Cache for 1 hour
    }
}
