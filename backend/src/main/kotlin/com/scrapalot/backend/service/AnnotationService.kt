package com.scrapalot.backend.service

import com.scrapalot.backend.domain.collection.Annotation
import com.scrapalot.backend.repository.AnnotationRepository
import com.scrapalot.backend.repository.AnnotationShareRepository
import com.scrapalot.backend.utils.runAfterCommit
import mu.KotlinLogging
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.*

private val logger = KotlinLogging.logger {}

@Service
@Transactional
class AnnotationService(
    private val annotationRepository: AnnotationRepository,
    private val annotationShareRepository: AnnotationShareRepository,
    private val redisEventPublisher: RedisEventPublisher
) {
    /**
     * True when the user owns the annotation OR holds a write-permission
     * share on it (multi-user collaboration, migration 111).
     */
    private fun canWriteAnnotation(
        annotation: Annotation,
        userId: UUID
    ): Boolean {
        if (annotation.userId == userId) return true
        val annotationId = annotation.id ?: return false
        val share = annotationShareRepository.findByAnnotationIdAndUserId(annotationId, userId)
        return share?.permission == "write"
    }

    @Transactional(readOnly = true)
    fun findById(id: UUID): Annotation? = annotationRepository.findById(id).orElse(null)

    @Transactional(readOnly = true)
    fun findByDocument(
        documentId: UUID,
        userId: UUID
    ): List<Annotation> = annotationRepository.findByDocumentIdAndUserIdOrderBySortIndex(documentId, userId)

    @Transactional(readOnly = true)
    fun findByCollection(
        collectionId: UUID,
        userId: UUID
    ): List<Annotation> = annotationRepository.findByCollectionIdAndUserIdOrderByCreatedAtDesc(collectionId, userId)

    @Transactional(readOnly = true)
    fun searchByText(
        userId: UUID,
        query: String
    ): List<UUID> = annotationRepository.searchByText(userId, query)

    @Transactional(readOnly = true)
    fun searchByComment(
        userId: UUID,
        query: String,
        maxResults: Int = 50
    ): List<Annotation> {
        val trimmed = query.trim()
        if (trimmed.isEmpty()) return emptyList()
        val limit = maxResults.coerceIn(1, 200)
        return annotationRepository.searchByComment(userId, trimmed, limit)
    }

    @Transactional(readOnly = true)
    fun findAnnotatedDocumentIds(
        collectionId: UUID,
        userId: UUID
    ): List<UUID> = annotationRepository.findAnnotatedDocumentIds(collectionId, userId)

    @Transactional(readOnly = true)
    fun countByDocument(
        documentId: UUID,
        userId: UUID
    ): Long = annotationRepository.countByDocumentIdAndUserId(documentId, userId)

    fun createAnnotation(
        userId: UUID,
        documentId: UUID,
        collectionId: UUID,
        positionJson: String,
        viewerType: String = "pdf",
        annotationType: Short = 1,
        selectedText: String? = null,
        comment: String? = null,
        color: String = "#ffd400",
        pageLabel: String? = null,
        sortIndex: String? = null,
        sessionId: UUID? = null,
        tagIds: List<String>? = null
    ): Annotation {
        val tagIdsJson =
            tagIds?.takeIf { it.isNotEmpty() }?.let {
                com.fasterxml.jackson.module.kotlin
                    .jacksonObjectMapper()
                    .writeValueAsString(it)
            }
        val annotation =
            Annotation(
                userId = userId,
                documentId = documentId,
                collectionId = collectionId,
                sessionId = sessionId,
                annotationType = annotationType,
                selectedText = selectedText,
                comment = comment,
                color = color,
                pageLabel = pageLabel,
                sortIndex = sortIndex,
                positionJson = positionJson,
                viewerType = viewerType,
                tagIds = tagIdsJson,
                createdAt = Instant.now(),
                updatedAt = Instant.now()
            )

        val saved = annotationRepository.save(annotation)
        logger.info { "Created annotation ${saved.id} on document $documentId (type=$annotationType, viewer=$viewerType)" }

        val annotationId = requireNotNull(saved.id) { "Saved annotation must have an ID" }
        val savedColor = saved.color
        runAfterCommit {
            redisEventPublisher.publishAnnotationEvent(
                type = EventType.ANNOTATION_CREATED,
                annotationId = annotationId,
                documentId = documentId,
                collectionId = collectionId,
                userId = userId,
                payload = mapOf("color" to savedColor)
            )
        }

        return saved
    }

    fun updateAnnotation(
        annotationId: UUID,
        userId: UUID,
        comment: String? = null,
        color: String? = null,
        isPinned: Boolean? = null,
        tagIds: List<String>? = null
    ): Annotation {
        val annotation =
            annotationRepository
                .findById(annotationId)
                .orElseThrow { NoSuchElementException("Annotation not found: $annotationId") }

        require(canWriteAnnotation(annotation, userId)) {
            "Cannot update annotation: only the owner or a user with a write share may patch it"
        }

        val newTagIds =
            tagIds?.let {
                if (it.isEmpty()) {
                    null
                } else {
                    com.fasterxml.jackson.module.kotlin
                        .jacksonObjectMapper()
                        .writeValueAsString(it)
                }
            } ?: annotation.tagIds

        val updated =
            annotation.copy(
                comment = comment ?: annotation.comment,
                color = color ?: annotation.color,
                isPinned = isPinned ?: annotation.isPinned,
                tagIds = newTagIds,
                updatedAt = Instant.now()
            )

        val saved = annotationRepository.save(updated)

        val docId = saved.documentId
        val collId = saved.collectionId
        val savedColor = saved.color
        runAfterCommit {
            redisEventPublisher.publishAnnotationEvent(
                type = EventType.ANNOTATION_UPDATED,
                annotationId = annotationId,
                documentId = docId,
                collectionId = collId,
                userId = userId,
                payload = mapOf("color" to savedColor)
            )
        }

        return saved
    }

    fun deleteAnnotation(
        annotationId: UUID,
        userId: UUID
    ) {
        val annotation =
            annotationRepository
                .findById(annotationId)
                .orElseThrow { NoSuchElementException("Annotation not found: $annotationId") }

        require(annotation.userId == userId) { "Cannot delete another user's annotation" }

        val docId = annotation.documentId
        val collId = annotation.collectionId
        val annotationColor = annotation.color

        annotationRepository.delete(annotation)
        logger.info { "Deleted annotation $annotationId" }

        runAfterCommit {
            redisEventPublisher.publishAnnotationEvent(
                type = EventType.ANNOTATION_DELETED,
                annotationId = annotationId,
                documentId = docId,
                collectionId = collId,
                userId = userId,
                payload = mapOf("color" to annotationColor)
            )
        }
    }

    fun deleteAllByDocument(
        documentId: UUID,
        userId: UUID
    ) {
        annotationRepository.deleteByDocumentIdAndUserId(documentId, userId)
        logger.info { "Deleted all annotations for document $documentId by user $userId" }
    }

    fun bulkCreate(annotations: List<Annotation>): List<Annotation> {
        val saved = annotationRepository.saveAll(annotations)
        logger.info { "Bulk created ${saved.size} annotations" }
        return saved
    }
}
