package com.scrapalot.backend.controller.system

import com.scrapalot.backend.config.OpenApiPathsCustomizer
import io.swagger.v3.oas.models.OpenAPI
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

/**
 * Manual OpenAPI endpoint since Springdoc autoconfiguration doesn't work
 * with our WebMVC + WebFlux hybrid setup
 */
@RestController
class OpenApiController(
    private val openAPI: OpenAPI,
    private val pathsCustomizer: OpenApiPathsCustomizer
) {
    @GetMapping("/v3/api-docs", produces = ["application/json"])
    fun getOpenApiDocs(): OpenAPI = openAPI.also { pathsCustomizer.customise(it) }
}
