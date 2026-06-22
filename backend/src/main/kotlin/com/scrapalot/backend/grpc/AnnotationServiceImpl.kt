package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.annotation.*
import com.scrapalot.backend.repository.AnnotationRepository
import com.scrapalot.backend.utils.grpcCall
import mu.KotlinLogging
import net.devh.boot.grpc.server.service.GrpcService
import org.springframework.data.domain.PageRequest
import java.util.UUID

private val logger = KotlinLogging.logger {}

@GrpcService
class AnnotationServiceImpl(
    private val annotationRepository: AnnotationRepository,
) : AnnotationServiceGrpcKt.AnnotationServiceCoroutineImplBase() {
    override suspend fun getDocumentAnnotations(request: GetDocumentAnnotationsRequest,): AnnotationListResponse =
        grpcCall {
            val documentId = UUID.fromString(request.documentId)
            val userId = UUID.fromString(request.userId)
            val annotations = annotationRepository.findByDocumentIdAndUserIdOrderBySortIndex(documentId, userId)

            val maxResults = if (request.maxResults > 0) request.maxResults else annotations.size
            val limited = annotations.take(maxResults)

            logger.debug { "GetDocumentAnnotations: doc=$documentId user=$userId found=${annotations.size} returned=${limited.size}" }

            annotationListResponse {
                this.annotations.addAll(limited.map { it.toProto() })
                this.totalCount = annotations.size
            }
        }

    override suspend fun getCollectionAnnotations(request: GetCollectionAnnotationsRequest,): AnnotationListResponse =
        grpcCall {
            val collectionId = UUID.fromString(request.collectionId)
            val userId = UUID.fromString(request.userId)
            val maxResults = if (request.maxResults > 0) request.maxResults else 500

            val page =
                annotationRepository.findByCollectionIdAndUserIdOrderByCreatedAtDesc(
                    collectionId,
                    userId,
                    PageRequest.of(0, maxResults)
                )

            logger.debug { "GetCollectionAnnotations: coll=$collectionId user=$userId found=${page.totalElements} returned=${page.content.size}" }

            annotationListResponse {
                this.annotations.addAll(page.content.map { it.toProto() })
                this.totalCount = page.totalElements.toInt()
            }
        }

    private fun com.scrapalot.backend.domain.collection.Annotation.toProto(): AnnotationMessage =
        annotationMessage {
            this.id = this@toProto.id?.toString() ?: ""
            this.documentId = this@toProto.documentId.toString()
            this.userId = this@toProto.userId.toString()
            this.collectionId = this@toProto.collectionId.toString()
            this.annotationType = this@toProto.annotationType.toInt()
            this.selectedText = this@toProto.selectedText ?: ""
            this.comment = this@toProto.comment ?: ""
            this.color = this@toProto.color
            this.pageLabel = this@toProto.pageLabel ?: ""
            this.positionJson = this@toProto.positionJson
            this.viewerType = this@toProto.viewerType
            this.isPinned = this@toProto.isPinned
            this.createdAt = this@toProto.createdAt.toString()
            this.updatedAt = this@toProto.updatedAt.toString()
            this.sessionId = this@toProto.sessionId?.toString() ?: ""
            this.sortIndex = this@toProto.sortIndex ?: ""
        }
}
