package com.scrapalot.backend.service

import com.scrapalot.backend.domain.collection.Collection
import com.scrapalot.backend.grpc.DocumentExtrasGrpcClient
import com.scrapalot.backend.repository.CollectionRepository
import com.scrapalot.backend.utils.BYTES_PER_GB
import com.scrapalot.backend.utils.SlugUtils
import com.scrapalot.backend.utils.orThrow
import com.scrapalot.backend.utils.runAfterCommit
import kotlinx.coroutines.runBlocking
import mu.KotlinLogging
import org.springframework.data.domain.Page
import org.springframework.data.domain.Pageable
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.NoSuchElementException
import java.util.UUID

private val logger = KotlinLogging.logger {}

@Service
@Transactional
class CollectionService(
    private val collectionRepository: CollectionRepository,
    private val documentExtrasGrpcClient: DocumentExtrasGrpcClient,
    private val workspaceService: WorkspaceService,
    private val redisEventPublisher: RedisEventPublisher,
    private val collectionWorkspaceSyncService: CollectionWorkspaceSyncService
) {
    @Transactional(readOnly = true)
    fun findById(id: UUID): Collection? = collectionRepository.findById(id).orElse(null)

    @Transactional(readOnly = true)
    fun findByWorkspaceId(workspaceId: UUID): List<Collection> = collectionRepository.findByWorkspaceIdOrderByCreatedAtDesc(workspaceId)

    @Transactional(readOnly = true)
    fun findByWorkspaceId(
        workspaceId: UUID,
        pageable: Pageable
    ): Page<Collection> = collectionRepository.findByWorkspaceId(workspaceId, pageable)

    @Transactional(readOnly = true)
    fun findByWorkspaceIds(
        workspaceIds: List<UUID>,
        pageable: Pageable
    ): Page<Collection> = collectionRepository.findByWorkspaceIdIn(workspaceIds, pageable)

    fun createCollection(
        name: String,
        workspaceId: UUID,
        userId: UUID,
        description: String? = null,
        chunkingStrategy: String? = null,
        chunkSize: Int? = null,
        chunkOverlap: Int? = null,
        parentCollectionId: UUID? = null,
        // 0=none, 1=light, 2=full; null=inherit from parent.
        graphTier: Int? = null
    ): Collection {
        // Validate workspace access
        if (!workspaceService.canEdit(workspaceId, userId)) {
            throw IllegalArgumentException("User does not have permission to create collections in this workspace")
        }

        // Validate parent depth for nested collections
        var depth = 0
        if (parentCollectionId != null) {
            val parent =
                collectionRepository
                    .findById(parentCollectionId)
                    .orElseThrow { IllegalArgumentException("Parent collection not found: $parentCollectionId") }
            if (parent.depth >= 3) {
                throw IllegalArgumentException("Maximum nesting depth (4 levels) exceeded")
            }
            depth = parent.depth + 1
        }

        // Slug is set once on create, scoped to workspace.
        val slug =
            SlugUtils.uniqueSlugify(
                name = name,
                fallback = "collection",
            ) { candidate -> collectionRepository.existsBySlugAndWorkspaceId(candidate, workspaceId) }

        val collection =
            Collection(
                name = name,
                slug = slug,
                description = description,
                workspaceId = workspaceId,
                parentCollectionId = parentCollectionId,
                depth = depth,
                chunkingStrategy = chunkingStrategy,
                chunkSize = chunkSize,
                chunkOverlap = chunkOverlap,
                graphTier = graphTier,
                isProcessing = false,
                processingError = null,
                createdAt = Instant.now(),
                updatedAt = Instant.now()
            )

        val saved = collectionRepository.save(collection)
        logger.info { "Created collection: ${saved.id} in workspace: $workspaceId (parent: $parentCollectionId, depth: $depth)" }

        val workspace = workspaceService.findById(workspaceId)
        val collId = requireNotNull(saved.id) { "Saved entity must have an ID" }
        val wsName = workspace?.name ?: ""
        runAfterCommit {
            redisEventPublisher.publishCollectionEvent(
                type = EventType.COLLECTION_CREATED,
                collectionId = collId,
                workspaceId = workspaceId,
                userId = userId,
                payload =
                    mapOf(
                        "collection_name" to name,
                        "workspace_name" to wsName,
                        "owner_user_id" to userId.toString(),
                        "description" to (description ?: ""),
                        "parent_collection_id" to (parentCollectionId?.toString() ?: ""),
                        "depth" to depth.toString(),
                        // "" = inherit-from-parent (NULL); Python coerces "" → NULL.
                        "graph_tier" to (graphTier?.toString() ?: "")
                    )
            )
            collectionWorkspaceSyncService.refreshSnapshot()
        }

        return saved
    }

    fun updateCollection(
        collectionId: UUID,
        userId: UUID,
        name: String? = null,
        description: String? = null,
        chunkingStrategy: String? = null,
        chunkSize: Int? = null,
        chunkOverlap: Int? = null,
        parentCollectionId: UUID? = null,
        moveToParent: Boolean = false,
        // null means "do not touch", "" clears, any
        // other string replaces. The DTO converts "" → "" (preserved
        // signal) so callers downstream can distinguish "leave alone"
        // from "wipe".
        customInstructions: String? = null,
        clearCustomInstructions: Boolean = false,
        // null = do not touch; -1 = reset to inherit-from-parent (NULL);
        // 0/1/2 = set explicit tier.
        graphTier: Int? = null
    ): Collection {
        val collection =
            collectionRepository.findById(collectionId).orElseThrow {
                NoSuchElementException("Collection not found: $collectionId")
            }

        // Validate workspace access
        if (!workspaceService.canEdit(collection.workspaceId, userId)) {
            throw IllegalArgumentException("User does not have permission to update this collection")
        }

        // Handle parent change (move collection)
        var newDepth = collection.depth
        var newParentId = collection.parentCollectionId
        if (moveToParent) {
            if (parentCollectionId != null) {
                val parent =
                    collectionRepository
                        .findById(parentCollectionId)
                        .orElseThrow { IllegalArgumentException("Parent collection not found: $parentCollectionId") }
                if (parent.depth >= 3) {
                    throw IllegalArgumentException("Maximum nesting depth (4 levels) exceeded")
                }
                // Check we're not making a cycle (can't move into own descendant)
                val descendants = collectionRepository.findDescendantIds(collectionId)
                if (descendants.contains(parentCollectionId)) {
                    throw IllegalArgumentException("Cannot move collection into its own descendant")
                }
                newDepth = parent.depth + 1
                newParentId = parentCollectionId
            } else {
                newDepth = 0
                newParentId = null
            }
        }

        val resolvedCustomInstructions =
            when {
                clearCustomInstructions -> null
                customInstructions != null -> customInstructions
                else -> collection.customInstructions
            }

        val resolvedGraphTier =
            when {
                graphTier == null -> collection.graphTier // do not touch
                graphTier < 0 -> null // reset to inherit-from-parent
                else -> graphTier // set 0/1/2
            }

        val updated =
            collection.copy(
                name = name ?: collection.name,
                description = description ?: collection.description,
                // A user explicitly setting the description takes ownership of it —
                // the background memory digest will no longer overwrite it.
                descriptionUserEdited = if (description != null) true else collection.descriptionUserEdited,
                chunkingStrategy = chunkingStrategy ?: collection.chunkingStrategy,
                chunkSize = chunkSize ?: collection.chunkSize,
                chunkOverlap = chunkOverlap ?: collection.chunkOverlap,
                parentCollectionId = newParentId,
                depth = newDepth,
                customInstructions = resolvedCustomInstructions,
                graphTier = resolvedGraphTier,
                updatedAt = Instant.now()
            )

        val saved = collectionRepository.save(updated)

        val workspace = workspaceService.findById(collection.workspaceId)
        val wsId = collection.workspaceId
        val savedName = saved.name
        val savedDescription = saved.description
        val wsName = workspace?.name ?: ""
        val savedCustomInstructions = saved.customInstructions
        runAfterCommit {
            redisEventPublisher.publishCollectionEvent(
                type = EventType.COLLECTION_UPDATED,
                collectionId = collectionId,
                workspaceId = wsId,
                userId = userId,
                payload =
                    mapOf(
                        "collection_name" to savedName,
                        "workspace_name" to wsName,
                        "owner_user_id" to userId.toString(),
                        "description" to (savedDescription ?: ""),
                        "parent_collection_id" to (saved.parentCollectionId?.toString() ?: ""),
                        "depth" to saved.depth.toString(),
                        // empty string means "no custom
                        // instructions"; Python coerces "" back to NULL.
                        "custom_instructions" to (savedCustomInstructions ?: ""),
                        // "" = inherit-from-parent (NULL); always sent so the replica stays authoritative.
                        "graph_tier" to (saved.graphTier?.toString() ?: "")
                    )
            )
            collectionWorkspaceSyncService.refreshSnapshot()
        }

        return saved
    }

    /**
     * Apply an auto-generated collection-memory digest (from the Python background
     * job, via the collection_summary Redis stream) as the collection description.
     * Skips collections whose description the user has manually edited, and is a
     * no-op when the digest matches the current value. Replicates the new value to
     * Python through the existing K→P collections stream.
     */
    @Transactional
    fun applyGeneratedDescription(
        collectionId: UUID,
        description: String
    ) {
        val collection = collectionRepository.findById(collectionId).orElse(null) ?: return
        if (collection.descriptionUserEdited) {
            logger.debug { "Collection $collectionId description is user-edited — skipping auto digest" }
            return
        }
        if (collection.description == description) return

        val saved = collectionRepository.save(collection.copy(description = description, updatedAt = Instant.now()))

        val wsId = collection.workspaceId
        val workspace = workspaceService.findById(wsId)
        val ownerUserId = workspace?.userId ?: return
        val savedName = saved.name
        val wsName = workspace.name
        val savedCustomInstructions = saved.customInstructions
        runAfterCommit {
            redisEventPublisher.publishCollectionEvent(
                type = EventType.COLLECTION_UPDATED,
                collectionId = collectionId,
                workspaceId = wsId,
                userId = ownerUserId,
                payload =
                    mapOf(
                        "collection_name" to savedName,
                        "workspace_name" to wsName,
                        "owner_user_id" to ownerUserId.toString(),
                        "description" to description,
                        "parent_collection_id" to (saved.parentCollectionId?.toString() ?: ""),
                        "depth" to saved.depth.toString(),
                        "custom_instructions" to (savedCustomInstructions ?: ""),
                        // include current tier so the digest update doesn't reset the replica.
                        "graph_tier" to (saved.graphTier?.toString() ?: "")
                    )
            )
            collectionWorkspaceSyncService.refreshSnapshot()
        }
        logger.info { "Applied generated description to collection $collectionId (${description.length} chars)" }
    }

    fun deleteCollection(
        collectionId: UUID,
        userId: UUID
    ) {
        val collection =
            collectionRepository.findById(collectionId).orElseThrow {
                NoSuchElementException("Collection not found: $collectionId")
            }

        // Validate workspace access
        if (!workspaceService.canEdit(collection.workspaceId, userId)) {
            throw IllegalArgumentException("User does not have permission to delete this collection")
        }

        val workspace = workspaceService.findById(collection.workspaceId)
        val wsId = collection.workspaceId
        val collName = collection.name
        val wsName = workspace?.name ?: ""

        collectionRepository.deleteById(collectionId)
        logger.info { "Deleted collection: $collectionId" }

        runAfterCommit {
            redisEventPublisher.publishCollectionEvent(
                type = EventType.COLLECTION_DELETED,
                collectionId = collectionId,
                workspaceId = wsId,
                userId = userId,
                payload =
                    mapOf(
                        "collection_name" to collName,
                        "workspace_name" to wsName,
                        "owner_user_id" to userId.toString()
                    )
            )
            collectionWorkspaceSyncService.refreshSnapshot()
        }
    }

    @Transactional(readOnly = true)
    fun getCollectionSummary(collectionId: UUID): Map<String, Any> {
        val collection =
            collectionRepository.findById(collectionId).orElseThrow {
                NoSuchElementException("Collection not found: $collectionId")
            }

        @Suppress("RunBlocking") // called from a Spring MVC thread, not a coroutine — runBlocking is safe here
        val usage =
            runBlocking {
                documentExtrasGrpcClient.getStorageUsage(listOf(collectionId.toString()))
            }

        return mapOf(
            "id" to collection.id.orThrow("Collection"),
            "name" to collection.name,
            "description" to (collection.description ?: ""),
            "documentCount" to usage.documentCount,
            "totalSizeBytes" to usage.totalSizeBytes,
            "totalSizeGB" to (usage.totalSizeBytes / BYTES_PER_GB),
            "chunkingStrategy" to (collection.chunkingStrategy ?: ""),
            "chunkSize" to (collection.chunkSize ?: 0),
            "chunkOverlap" to (collection.chunkOverlap ?: 0),
            "isProcessing" to collection.isProcessing,
            "createdAt" to collection.createdAt,
            "updatedAt" to collection.updatedAt
        )
    }
}
