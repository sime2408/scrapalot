package com.scrapalot.backend.controller.document

import com.scrapalot.backend.domain.document.UserDocumentRating
import com.scrapalot.backend.dto.ListRatingsRequest
import com.scrapalot.backend.dto.RateDocumentRequest
import com.scrapalot.backend.dto.UserDocumentRatingResponse
import com.scrapalot.backend.dto.UserDocumentRatingsBatchResponse
import com.scrapalot.backend.service.UserDocumentRatingService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.service.WorkspaceService
import com.scrapalot.backend.utils.authenticatedUserId
import com.scrapalot.backend.utils.requireAccess
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toResponseEntity
import jakarta.validation.Valid
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

/**
 * Document quality rating REST endpoints.
 *
 *   POST /api/v1/document-ratings        upsert / clear rating
 *   GET  /api/v1/document-ratings        batch fetch by document_ids
 *
 * The library view passes the visible documents' ids to the GET to
 * hydrate star widgets in one round trip.
 */
@RestController
@RequestMapping("/api/v1/document-ratings")
class UserDocumentRatingController(
    private val service: UserDocumentRatingService,
    private val userService: UserService,
    private val workspaceService: WorkspaceService,
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    @PostMapping
    fun rateDocument(
        @Valid @RequestBody request: RateDocumentRequest,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<UserDocumentRatingResponse> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireAccess(request.workspaceId, userId)

            val updated =
                service.upsertRating(
                    userId = userId,
                    documentId = request.documentId,
                    workspaceId = request.workspaceId,
                    rating = request.rating,
                    notes = request.notes,
                )
            updated?.toResponse() ?: UserDocumentRatingResponse(
                documentId = request.documentId,
                workspaceId = request.workspaceId,
                rating = null,
                notes = null,
                ratedAt = null,
                updatedAt = null,
            )
        }.toResponseEntity()

    @GetMapping
    fun listRatings(
        @RequestParam(name = "document_ids", required = false) documentIds: List<UUID>?,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<UserDocumentRatingsBatchResponse> =
        resultOf {
            val userId = userDetails.userId()
            val ids = documentIds.orEmpty()
            val rows = service.findAllForUser(userId, ids)
            UserDocumentRatingsBatchResponse(
                ratings = rows.map { it.toResponse() },
            )
        }.toResponseEntity()

    /**
     * Library prefetch sends ~800 ids; that overflows Spring Cloud
     * Gateway's request-line buffer when squeezed into a GET querystring,
     * surfacing as ERR_NETWORK in the browser. Same payload, JSON body.
     */
    @PostMapping("/batch")
    fun listRatingsBatch(
        @Valid @RequestBody request: ListRatingsRequest,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<UserDocumentRatingsBatchResponse> =
        resultOf {
            val userId = userDetails.userId()
            val rows = service.findAllForUser(userId, request.documentIds)
            UserDocumentRatingsBatchResponse(
                ratings = rows.map { it.toResponse() },
            )
        }.toResponseEntity()
}

private fun UserDocumentRating.toResponse() =
    UserDocumentRatingResponse(
        documentId = documentId,
        workspaceId = workspaceId,
        rating = rating,
        notes = notes,
        ratedAt = ratedAt.toString(),
        updatedAt = updatedAt.toString(),
    )
