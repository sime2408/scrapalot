package com.scrapalot.backend.controller.notes

import com.scrapalot.backend.dto.AnnotationCountResponse
import com.scrapalot.backend.dto.AnnotationResponse
import com.scrapalot.backend.dto.AnnotationShareResponse
import com.scrapalot.backend.dto.BulkCreateAnnotationsRequest
import com.scrapalot.backend.dto.CreateAnnotationRequest
import com.scrapalot.backend.dto.CreateAnnotationShareRequest
import com.scrapalot.backend.dto.UpdateAnnotationRequest
import com.scrapalot.backend.mapper.AnnotationMapper
import com.scrapalot.backend.service.AnnotationService
import com.scrapalot.backend.service.AnnotationShareService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.*
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1")
class AnnotationController(
    private val annotationService: AnnotationService,
    private val annotationShareService: AnnotationShareService,
    private val userService: UserService,
    private val annotationMapper: AnnotationMapper
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    // ─── Search endpoints ───────────────────────────────────────────────

    @GetMapping("/annotations/search")
    fun searchAnnotations(
        @RequestParam text: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, List<String>>> =
        resultOf {
            val userId = userDetails.userId()
            val docIds = annotationService.searchByText(userId, text)
            mapOf("document_ids" to docIds.map { it.toString() })
        }.toResponseEntity()

    @GetMapping("/annotations/search/comments")
    fun searchAnnotationComments(
        @RequestParam("q") query: String,
        @RequestParam(required = false, defaultValue = "50") maxResults: Int,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<AnnotationResponse>> =
        resultOf {
            val userId = userDetails.userId()
            val matches = annotationService.searchByComment(userId, query, maxResults)
            annotationMapper.toAnnotationResponseList(matches)
        }.toResponseEntity()

    // ─── Document-scoped endpoints ─────────────────────────────────────

    @GetMapping("/documents/{documentId}/annotations")
    fun getDocumentAnnotations(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<AnnotationResponse>> =
        resultOf {
            val userId = userDetails.userId()
            annotationMapper.toAnnotationResponseList(annotationService.findByDocument(documentId, userId))
        }.toResponseEntity()

    @PostMapping("/documents/{documentId}/annotations")
    fun createAnnotation(
        @PathVariable documentId: UUID,
        @Valid @RequestBody request: CreateAnnotationRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<AnnotationResponse> =
        resultOf {
            val userId = userDetails.userId()

            require(request.documentId == documentId) { "Document ID mismatch" }

            val annotation =
                annotationService.createAnnotation(
                    userId = userId,
                    documentId = request.documentId,
                    collectionId = request.collectionId,
                    positionJson = request.positionJson,
                    viewerType = request.viewerType,
                    annotationType = request.annotationType,
                    selectedText = request.selectedText,
                    comment = request.comment,
                    color = request.color,
                    pageLabel = request.pageLabel,
                    sortIndex = request.sortIndex,
                    sessionId = request.sessionId,
                    tagIds = request.tagIds
                )
            annotationMapper.toAnnotationResponse(annotation)
        }.toResponseEntity(HttpStatus.CREATED)

    @GetMapping("/documents/{documentId}/annotations/count")
    fun getAnnotationCount(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<AnnotationCountResponse> =
        resultOf {
            val userId = userDetails.userId()
            AnnotationCountResponse(
                documentId = documentId,
                count = annotationService.countByDocument(documentId, userId)
            )
        }.toResponseEntity()

    // ─── Collection-scoped endpoints ───────────────────────────────────

    @GetMapping("/collections/{collectionId}/annotations")
    fun getCollectionAnnotations(
        @PathVariable collectionId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<AnnotationResponse>> =
        resultOf {
            val userId = userDetails.userId()
            annotationMapper.toAnnotationResponseList(annotationService.findByCollection(collectionId, userId))
        }.toResponseEntity()

    @GetMapping("/collections/{collectionId}/annotated-documents")
    fun getAnnotatedDocumentIds(
        @PathVariable collectionId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<UUID>> =
        resultOf {
            val userId = userDetails.userId()
            annotationService.findAnnotatedDocumentIds(collectionId, userId)
        }.toResponseEntity()

    // ─── Single annotation endpoints ───────────────────────────────────

    @GetMapping("/annotations/{annotationId}")
    fun getAnnotation(
        @PathVariable annotationId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<AnnotationResponse> =
        resultOf {
            val userId = userDetails.userId()
            val annotation =
                annotationService
                    .findById(annotationId)
                    .orNotFound("Annotation not found: $annotationId")
            require(annotation.userId == userId) { "Access denied" }
            annotationMapper.toAnnotationResponse(annotation)
        }.toResponseEntity()

    @PutMapping("/annotations/{annotationId}")
    fun updateAnnotation(
        @PathVariable annotationId: UUID,
        @Valid @RequestBody request: UpdateAnnotationRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<AnnotationResponse> =
        resultOf {
            val userId = userDetails.userId()
            val annotation =
                annotationService.updateAnnotation(
                    annotationId = annotationId,
                    userId = userId,
                    comment = request.comment,
                    color = request.color,
                    isPinned = request.isPinned,
                    tagIds = request.tagIds
                )
            annotationMapper.toAnnotationResponse(annotation)
        }.toResponseEntity()

    @DeleteMapping("/annotations/{annotationId}")
    fun deleteAnnotation(
        @PathVariable annotationId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            annotationService.deleteAnnotation(annotationId, userId)
        }.toNoContentResponse()

    // ─── Bulk operations ───────────────────────────────────────────────

    @PostMapping("/documents/{documentId}/annotations/bulk")
    fun bulkCreateAnnotations(
        @PathVariable documentId: UUID,
        @Valid @RequestBody request: BulkCreateAnnotationsRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<AnnotationResponse>> =
        resultOf {
            val userId = userDetails.userId()
            val entities = request.annotations.map { annotationMapper.toAnnotation(it, userId) }
            annotationMapper.toAnnotationResponseList(annotationService.bulkCreate(entities))
        }.toResponseEntity(HttpStatus.CREATED)

    @DeleteMapping("/documents/{documentId}/annotations")
    fun deleteAllDocumentAnnotations(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            annotationService.deleteAllByDocument(documentId, userId)
        }.toNoContentResponse()

    // ─── Sharing endpoints (multi-user collaboration) ───────────────────

    @GetMapping("/annotations/shared-with-me")
    fun listSharedWithMe(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<AnnotationResponse>> =
        resultOf {
            val userId = userDetails.userId()
            annotationMapper.toAnnotationResponseList(annotationShareService.listSharedWith(userId))
        }.toResponseEntity()

    @GetMapping("/annotations/{annotationId}/shares")
    fun listShares(
        @PathVariable annotationId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<AnnotationShareResponse>> =
        resultOf {
            val userId = userDetails.userId()
            annotationShareService.listShares(annotationId, userId).map { share ->
                AnnotationShareResponse(
                    annotationId = share.annotationId,
                    sharedWithUserId = share.userId,
                    permission = share.permission,
                    createdAt = share.createdAt.toString(),
                )
            }
        }.toResponseEntity()

    @GetMapping("/annotations/{annotationId}/share-candidates")
    fun listShareCandidates(
        @PathVariable annotationId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<Map<String, Any?>>> =
        resultOf {
            val userId = userDetails.userId()
            annotationShareService.listShareCandidates(annotationId, userId).map { c ->
                mapOf(
                    "user_id" to c.userId.toString(),
                    "email" to c.email,
                    "username" to c.username,
                    "workspace_role" to c.role,
                )
            }
        }.toResponseEntity()

    @PostMapping("/annotations/{annotationId}/shares")
    fun createShare(
        @PathVariable annotationId: UUID,
        @Valid @RequestBody request: CreateAnnotationShareRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<AnnotationShareResponse> =
        resultOf {
            val userId = userDetails.userId()
            val share =
                annotationShareService.share(
                    annotationId = annotationId,
                    recipientUserId = request.sharedWithUserId,
                    permission = request.permission,
                    currentUserId = userId,
                )
            AnnotationShareResponse(
                annotationId = share.annotationId,
                sharedWithUserId = share.userId,
                permission = share.permission,
                createdAt = share.createdAt.toString(),
            )
        }.toResponseEntity(HttpStatus.CREATED)

    @DeleteMapping("/annotations/{annotationId}/shares/{recipientUserId}")
    fun revokeShare(
        @PathVariable annotationId: UUID,
        @PathVariable recipientUserId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            annotationShareService.revoke(annotationId, recipientUserId, userId)
            Unit
        }.toNoContentResponse()
}
