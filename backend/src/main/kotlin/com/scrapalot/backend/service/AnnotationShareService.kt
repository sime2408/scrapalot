package com.scrapalot.backend.service

import com.scrapalot.backend.domain.collection.Annotation
import com.scrapalot.backend.domain.collection.AnnotationShare
import com.scrapalot.backend.repository.AnnotationRepository
import com.scrapalot.backend.repository.AnnotationShareRepository
import com.scrapalot.backend.repository.CollectionRepository
import com.scrapalot.backend.utils.runAfterCommit
import org.springframework.messaging.simp.SimpMessagingTemplate
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.UUID

data class AnnotationShareCandidate(
    val userId: UUID,
    val email: String?,
    val username: String?,
    val role: String,
)

/**
 * Multi-user annotation sharing service.
 *
 * The annotation owner (the user whose `userId` matches the underlying
 * Annotation row) is the only one who may add or remove shares. Share
 * recipients with `permission == "write"` may patch comment + color via
 * `AnnotationService.updateAnnotation`.
 *
 * Every share lifecycle event is broadcast on STOMP topic
 * `/topic/annotations.{document_id}.events` so that other users viewing
 * the same document refresh their annotation list, and is also pushed
 * to Redis Stream `scrapalot:stream:annotations` so the Python AI side
 * can invalidate the user's annotation-context cache.
 */
@Service
class AnnotationShareService(
    private val annotationShareRepository: AnnotationShareRepository,
    private val annotationRepository: AnnotationRepository,
    private val collectionRepository: CollectionRepository,
    private val workspaceService: WorkspaceService,
    private val userService: UserService,
    private val redisEventPublisher: RedisEventPublisher,
    private val messagingTemplate: SimpMessagingTemplate,
) {
    private val allowedPermissions = setOf("read", "write")

    @Transactional(readOnly = true)
    fun listShares(
        annotationId: UUID,
        currentUserId: UUID
    ): List<AnnotationShare> {
        requireOwner(annotationId, currentUserId)
        return annotationShareRepository.findByAnnotationId(annotationId)
    }

    @Transactional
    fun share(
        annotationId: UUID,
        recipientUserId: UUID,
        permission: String,
        currentUserId: UUID,
    ): AnnotationShare {
        val annotation = requireOwner(annotationId, currentUserId)
        require(recipientUserId != currentUserId) {
            "Cannot share an annotation with yourself"
        }
        require(permission in allowedPermissions) {
            "Permission must be one of $allowedPermissions, got '$permission'"
        }
        val existing = annotationShareRepository.findByAnnotationIdAndUserId(annotationId, recipientUserId)
        val saved =
            if (existing != null) {
                existing.permission = permission
                annotationShareRepository.save(existing)
            } else {
                annotationShareRepository.save(
                    AnnotationShare(
                        annotationId = annotationId,
                        userId = recipientUserId,
                        permission = permission,
                    )
                )
            }
        publishShareLifecycleEvent(
            annotation = annotation,
            ownerId = currentUserId,
            recipientId = recipientUserId,
            permission = saved.permission,
            type = EventType.ANNOTATION_SHARED,
        )
        return saved
    }

    @Transactional
    fun revoke(
        annotationId: UUID,
        recipientUserId: UUID,
        currentUserId: UUID
    ): Boolean {
        val annotation = requireOwner(annotationId, currentUserId)
        val deleted = annotationShareRepository.deleteByAnnotationIdAndUserId(annotationId, recipientUserId)
        if (deleted > 0) {
            publishShareLifecycleEvent(
                annotation = annotation,
                ownerId = currentUserId,
                recipientId = recipientUserId,
                permission = null,
                type = EventType.ANNOTATION_SHARE_REVOKED,
            )
        }
        return deleted > 0
    }

    @Transactional(readOnly = true)
    fun listSharedWith(userId: UUID): List<Annotation> = annotationShareRepository.findAnnotationsSharedWith(userId)

    /**
     * Eligible recipients for sharing this annotation: users who already
     * have access to the workspace that owns the annotation's collection.
     * Excludes the annotation owner themselves so the dialog never lists
     * the user-as-self. The frontend dialog renders this list as a
     * dropdown; freeform email input is forbidden because shares to
     * users outside the workspace would point at a document the
     * recipient cannot open.
     */
    @Transactional(readOnly = true)
    fun listShareCandidates(
        annotationId: UUID,
        currentUserId: UUID
    ): List<AnnotationShareCandidate> {
        val annotation =
            annotationRepository.findById(annotationId).orElseThrow {
                NoSuchElementException("Annotation not found: $annotationId")
            }
        require(annotation.userId == currentUserId) {
            "Only the annotation owner may list share candidates"
        }
        val collection =
            collectionRepository.findById(annotation.collectionId).orElseThrow {
                NoSuchElementException("Collection not found: ${annotation.collectionId}")
            }
        val members = workspaceService.getWorkspaceUsers(collection.workspaceId)
        return members
            .filter { it.userId != currentUserId }
            .map { wu ->
                val user = userService.findById(wu.userId)
                AnnotationShareCandidate(
                    userId = wu.userId,
                    email = user?.email,
                    username = user?.username,
                    role = wu.permission,
                )
            }
    }

    /**
     * Used by `AnnotationService` to gate write access for share recipients.
     * Returns true when the user can update the annotation: either they
     * own it or they hold a "write" share on it.
     */
    @Transactional(readOnly = true)
    fun canWrite(
        annotationId: UUID,
        userId: UUID
    ): Boolean {
        val annotation = annotationRepository.findById(annotationId).orElse(null) ?: return false
        if (annotation.userId == userId) return true
        val share = annotationShareRepository.findByAnnotationIdAndUserId(annotationId, userId)
        return share?.permission == "write"
    }

    private fun requireOwner(
        annotationId: UUID,
        currentUserId: UUID
    ): Annotation {
        val annotation =
            annotationRepository.findById(annotationId).orElseThrow {
                NoSuchElementException("Annotation not found: $annotationId")
            }
        require(annotation.userId == currentUserId) {
            "Only the annotation owner may manage its shares"
        }
        return annotation
    }

    /**
     * Fan share lifecycle out on:
     *  1) STOMP topic so connected clients refresh in real time
     *  2) Redis Stream so Python AI invalidates the recipient's
     *     annotation-context cache
     *
     * Both broadcasts are deferred until after the surrounding transaction
     * commits — otherwise consumers can race the DB write and read stale
     * state. STOMP failures are logged and swallowed so a broken WebSocket
     * never poisons the share operation.
     */
    private fun publishShareLifecycleEvent(
        annotation: Annotation,
        ownerId: UUID,
        recipientId: UUID,
        permission: String?,
        type: EventType,
    ) {
        val annotationId = annotation.id ?: return
        val documentId = annotation.documentId
        val collectionId = annotation.collectionId

        val payload =
            mutableMapOf<String, Any>(
                "type" to type.name,
                "annotation_id" to annotationId.toString(),
                "document_id" to documentId.toString(),
                "shared_with_user_id" to recipientId.toString(),
                "owner_id" to ownerId.toString(),
                "occurred_at" to Instant.now().toString(),
            )
        if (permission != null) payload["permission"] = permission

        val topic = "/topic/annotations.$documentId.events"

        runAfterCommit {
            try {
                messagingTemplate.convertAndSend(topic, payload)
            } catch (_: Exception) {
                // STOMP downstream failure must not roll back the share.
            }
            redisEventPublisher.publishAnnotationEvent(
                type = type,
                annotationId = annotationId,
                documentId = documentId,
                collectionId = collectionId,
                userId = ownerId,
                payload = payload,
            )
        }
    }
}
