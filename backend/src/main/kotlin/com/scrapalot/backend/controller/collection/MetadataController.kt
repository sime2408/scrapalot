package com.scrapalot.backend.controller.collection

import com.scrapalot.backend.service.MetadataResolverService
import com.scrapalot.backend.service.ResolvedMetadata
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.authenticatedUserId
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toResponseEntity
import mu.KotlinLogging
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

private val logger = KotlinLogging.logger {}

data class ResolveIdentifierRequest(
    val identifier: String, // raw input — DOI, ISBN, arXiv ID, PMID
)

data class ResolveIdentifierResponse(
    val success: Boolean,
    val identifierType: String? = null,
    val identifierValue: String? = null,
    val metadata: ResolvedMetadata? = null,
    val message: String? = null,
)

@RestController
@RequestMapping("/api/v1/metadata")
class MetadataController(
    private val metadataResolverService: MetadataResolverService,
    private val userService: UserService,
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    /**
     * Resolve an identifier to full academic metadata.
     * Auto-detects type (DOI, ISBN, arXiv, PMID) from input.
     */
    @PostMapping("/resolve")
    fun resolveIdentifier(
        @RequestBody request: ResolveIdentifierRequest,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<ResolveIdentifierResponse> =
        resultOf {
            val userId = userDetails.userId()
            logger.info { "Metadata resolve request from user $userId: ${request.identifier}" }

            val detection =
                metadataResolverService.detectIdentifier(request.identifier) ?: return@resultOf ResolveIdentifierResponse(
                    success = false,
                    message = "Could not detect identifier type. Supported: DOI, ISBN, arXiv ID, PMID",
                )

            val metadata =
                metadataResolverService.resolve(detection.type, detection.value) ?: return@resultOf ResolveIdentifierResponse(
                    success = false,
                    identifierType = detection.type,
                    identifierValue = detection.value,
                    message = "Identifier detected as ${detection.type} but metadata resolution failed",
                )

            ResolveIdentifierResponse(
                success = true,
                identifierType = detection.type,
                identifierValue = detection.value,
                metadata = metadata,
            )
        }.toResponseEntity()

    /**
     * Detect an identifier type without resolving (fast, no API calls).
     */
    @PostMapping("/detect")
    fun detectIdentifier(
        @RequestBody request: ResolveIdentifierRequest
    ): ResponseEntity<Map<String, String?>> =
        resultOf {
            val detection = metadataResolverService.detectIdentifier(request.identifier)
            mapOf(
                "type" to detection?.type,
                "value" to detection?.value,
                "detected" to (detection != null).toString(),
            )
        }.toResponseEntity()
}
