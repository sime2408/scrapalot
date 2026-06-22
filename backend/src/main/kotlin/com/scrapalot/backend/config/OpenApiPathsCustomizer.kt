package com.scrapalot.backend.config

import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.Operation
import io.swagger.v3.oas.models.PathItem
import io.swagger.v3.oas.models.responses.ApiResponse
import io.swagger.v3.oas.models.responses.ApiResponses
import org.springdoc.core.customizers.OpenApiCustomizer
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Component
import org.springframework.web.method.HandlerMethod
import org.springframework.web.servlet.mvc.method.RequestMappingInfo
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping

/**
 * Scans all Spring MVC controllers and generates OpenAPI paths
 * since Springdoc autoconfiguration doesn't work with our setup
 */
@Component
class OpenApiPathsCustomizer(
    @param:Qualifier("requestMappingHandlerMapping")
    private val handlerMapping: RequestMappingHandlerMapping
) : OpenApiCustomizer {
    override fun customise(openApi: OpenAPI) {
        val handlerMethods = handlerMapping.handlerMethods

        handlerMethods.forEach { (mappingInfo, handlerMethod) ->
            addPathsFromMapping(openApi, mappingInfo, handlerMethod)
        }
    }

    private fun addPathsFromMapping(
        openApi: OpenAPI,
        mappingInfo: RequestMappingInfo,
        handlerMethod: HandlerMethod
    ) {
        val patterns = mappingInfo.pathPatternsCondition?.patterns ?: return
        val methods = mappingInfo.methodsCondition.methods

        patterns.forEach { pattern ->
            val pathItem = openApi.paths?.get(pattern.patternString) ?: PathItem()

            methods.forEach { httpMethod ->
                val operation = createOperation(handlerMethod)

                when (httpMethod.name) {
                    "GET" -> pathItem.get = operation
                    "POST" -> pathItem.post = operation
                    "PUT" -> pathItem.put = operation
                    "DELETE" -> pathItem.delete = operation
                    "PATCH" -> pathItem.patch = operation
                }
            }

            if (openApi.paths == null) {
                openApi.paths =
                    io.swagger.v3.oas.models
                        .Paths()
            }
            openApi.paths.addPathItem(pattern.patternString, pathItem)
        }
    }

    private fun createOperation(handlerMethod: HandlerMethod): Operation {
        val method = handlerMethod.method
        val operation = Operation()

        // Set operation ID
        operation.operationId = "${method.declaringClass.simpleName}_${method.name}"

        // Set summary from method name
        operation.summary = method.name.replace(Regex("([A-Z])"), " $1").trim()

        // Set tags from controller class
        val controllerName = method.declaringClass.simpleName.replace("Controller", "")
        operation.tags = listOf(controllerName)

        // Add default responses
        operation.responses =
            ApiResponses().apply {
                addApiResponse("200", ApiResponse().description("Successful operation"))
                addApiResponse("401", ApiResponse().description("Unauthorized"))
                addApiResponse("500", ApiResponse().description("Internal server error"))
            }

        return operation
    }
}
