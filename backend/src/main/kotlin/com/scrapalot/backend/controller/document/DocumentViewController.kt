package com.scrapalot.backend.controller.document

import com.scrapalot.backend.dto.RecentDocumentResponse
import com.scrapalot.backend.dto.RecentDocumentsResponse
import com.scrapalot.backend.dto.RecordDocumentViewRequest
import com.scrapalot.backend.service.DocumentViewService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.authenticatedUserId
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toNoContentResponse
import com.scrapalot.backend.utils.toResponseEntity
import jakarta.validation.Valid
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

/**
 * Recent Documents REST.
 *
 *   POST /api/v1/document-views          record a view
 *   GET  /api/v1/document-views/recent   most-recent unique docs (default 15)
 *
 * The Command Palette's Recent group + a future sidebar Recent strip
 * both consume /recent.
 */
@RestController
@RequestMapping("/api/v1/document-views")
class DocumentViewController(
    private val service: DocumentViewService,
    private val userService: UserService,
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    @PostMapping
    fun recordView(
        @Valid @RequestBody request: RecordDocumentViewRequest,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Void> =
        resultOf {
            // toNoContentResponse() requires Result<Unit>; recordView
            // returns nullable DocumentView (null when throttled). Wrap
            // explicitly so the chain types check.
            service.recordView(
                userId = userDetails.userId(),
                documentId = request.documentId,
                collectionId = request.collectionId,
                source = request.source,
            )
            Unit
        }.toNoContentResponse()

    @DeleteMapping("/{documentId}")
    fun dismissView(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Void> =
        resultOf {
            service.dismissForUser(userDetails.userId(), documentId)
            Unit
        }.toNoContentResponse()

    @GetMapping("/recent")
    fun recentViews(
        @RequestParam(required = false, defaultValue = "15") limit: Int,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<RecentDocumentsResponse> =
        resultOf {
            val rows = service.findRecent(userDetails.userId(), limit)
            RecentDocumentsResponse(
                recents =
                    rows.map {
                        RecentDocumentResponse(
                            documentId = it.getDocumentId(),
                            collectionId = it.getCollectionId(),
                            lastViewedAt = it.getLastViewedAt().toString(),
                            source = it.getSource(),
                        )
                    },
            )
        }.toResponseEntity()
}
