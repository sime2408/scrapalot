package com.scrapalot.backend.controller.collection

import com.scrapalot.backend.config.PromptsProperties
import com.scrapalot.backend.domain.collection.Collection
import com.scrapalot.backend.dto.CollectionPaginationResponse
import com.scrapalot.backend.dto.CollectionResponse
import com.scrapalot.backend.dto.CollectionSummaryResponse
import com.scrapalot.backend.dto.CreateCollectionRequest
import com.scrapalot.backend.dto.PaginatedCollectionsResponse
import com.scrapalot.backend.dto.UpdateCollectionRequest
import com.scrapalot.backend.grpc.CollectionAIGrpcClient
import com.scrapalot.backend.grpc.collection.GenerateCustomInstructionsRequest
import com.scrapalot.backend.grpc.collection.GenerateDescriptionRequest
import com.scrapalot.backend.service.AiGenerationService
import com.scrapalot.backend.service.CollectionService
import com.scrapalot.backend.service.SubscriptionService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.service.WorkspaceService
import com.scrapalot.backend.utils.authenticatedUserId
import com.scrapalot.backend.utils.buildPageRequest
import com.scrapalot.backend.utils.orNotFound
import com.scrapalot.backend.utils.orThrow
import com.scrapalot.backend.utils.requireAccess
import com.scrapalot.backend.utils.requireEdit
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toNoContentResponse
import com.scrapalot.backend.utils.toResponseEntity
import jakarta.validation.Valid
import kotlinx.coroutines.runBlocking
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.util.*

@RestController
@RequestMapping("/api/v1/collections")
class CollectionController(
    private val collectionService: CollectionService,
    private val workspaceService: WorkspaceService,
    private val userService: UserService,
    private val collectionAIGrpcClient: CollectionAIGrpcClient,
    private val aiGenerationService: AiGenerationService,
    private val prompts: PromptsProperties,
    private val subscriptionService: SubscriptionService,
) {
    /**
     * Building a Neo4j knowledge graph (tier 1 light / tier 2 full) is the
     * most expensive ingestion path — Pro and above. Tier 0 / null (inherit,
     * no graph) passes for everyone, so free-plan collection creation and the
     * registration default flow are untouched.
     */
    private fun requireGraphTierAllowed(
        userId: java.util.UUID,
        graphTier: Int?
    ) {
        if (graphTier != null && graphTier > 0) {
            subscriptionService.requireFeature(userId, "knowledge_graph")
        }
    }

    private fun UserDetails.userId() = authenticatedUserId(userService)

    private fun getAccessibleCollection(
        collectionId: UUID,
        userDetails: UserDetails
    ): Collection {
        val userId = userDetails.userId()
        val collection =
            collectionService
                .findById(collectionId)
                .orNotFound("Collection not found: $collectionId")
        workspaceService.requireAccess(collection.workspaceId, userId)
        return collection
    }

    @GetMapping
    fun getCollections(
        @RequestParam(required = false) workspaceId: UUID?,
        @RequestParam(defaultValue = "1") page: Int,
        @RequestParam(defaultValue = "20") limit: Int,
        @RequestParam(name = "sort_by", defaultValue = "name") sortBy: String,
        @RequestParam(name = "sort_order", defaultValue = "asc") sortOrder: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<PaginatedCollectionsResponse> =
        resultOf {
            val userId = userDetails.userId()
            val pageable = buildPageRequest(page, limit, sortBy, sortOrder)

            val collectionsPage =
                if (workspaceId != null) {
                    workspaceService.requireAccess(workspaceId, userId)
                    collectionService.findByWorkspaceId(workspaceId, pageable)
                } else {
                    val workspaceIds =
                        workspaceService
                            .findAllAccessibleWorkspaces(userId)
                            .map { it.id.orThrow("Workspace") }
                    collectionService.findByWorkspaceIds(workspaceIds, pageable)
                }

            PaginatedCollectionsResponse(
                collections = collectionsPage.content.map { it.toResponse() },
                pagination =
                    CollectionPaginationResponse(
                        page = page,
                        limit = limit,
                        total = collectionsPage.totalElements.toInt(),
                        hasMore = collectionsPage.hasNext()
                    )
            )
        }.toResponseEntity()

    @GetMapping("/workspace/{workspaceId}")
    fun getCollectionsByWorkspace(
        @PathVariable workspaceId: UUID,
        @RequestParam(defaultValue = "1") page: Int,
        @RequestParam(defaultValue = "20") limit: Int,
        @RequestParam(name = "sort_by", defaultValue = "name") sortBy: String,
        @RequestParam(name = "sort_order", defaultValue = "asc") sortOrder: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<PaginatedCollectionsResponse> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireAccess(workspaceId, userId)

            val pageable = buildPageRequest(page, limit, sortBy, sortOrder)
            val collectionsPage = collectionService.findByWorkspaceId(workspaceId, pageable)

            PaginatedCollectionsResponse(
                collections = collectionsPage.content.map { it.toResponse() },
                pagination =
                    CollectionPaginationResponse(
                        page = page,
                        limit = limit,
                        total = collectionsPage.totalElements.toInt(),
                        hasMore = collectionsPage.hasNext()
                    )
            )
        }.toResponseEntity()

    @GetMapping("/{collectionId}")
    fun getCollection(
        @PathVariable collectionId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<CollectionResponse> =
        resultOf {
            getAccessibleCollection(collectionId, userDetails).toResponse()
        }.toResponseEntity()

    @PostMapping
    fun createCollection(
        @Valid @RequestBody request: CreateCollectionRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<CollectionResponse> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireEdit(request.workspaceId, userId)
            requireGraphTierAllowed(userId, request.graphTier)

            collectionService
                .createCollection(
                    name = request.name,
                    description = request.description,
                    workspaceId = request.workspaceId,
                    userId = userId,
                    chunkingStrategy = request.chunkingStrategy,
                    chunkSize = request.chunkSize,
                    chunkOverlap = request.chunkOverlap,
                    parentCollectionId = request.parentCollectionId,
                    graphTier = request.graphTier
                ).toResponse()
        }.toResponseEntity(HttpStatus.CREATED)

    @PutMapping("/{collectionId}")
    fun updateCollection(
        @PathVariable collectionId: UUID,
        @Valid @RequestBody request: UpdateCollectionRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<CollectionResponse> =
        resultOf {
            val userId = userDetails.userId()
            val collection =
                collectionService
                    .findById(collectionId)
                    .orNotFound("Collection not found: $collectionId")
            workspaceService.requireEdit(collection.workspaceId, userId)

            // empty string from the client means "wipe
            // the field"; null means "leave whatever was there alone".
            // Passing both signals through preserves that distinction.
            val explicitClear = request.customInstructions != null && request.customInstructions.isBlank()
            requireGraphTierAllowed(userId, request.graphTier)
            collectionService
                .updateCollection(
                    collectionId = collectionId,
                    userId = userId,
                    name = request.name,
                    description = request.description,
                    chunkingStrategy = request.chunkingStrategy,
                    chunkSize = request.chunkSize,
                    chunkOverlap = request.chunkOverlap,
                    customInstructions = if (explicitClear) null else request.customInstructions,
                    clearCustomInstructions = explicitClear,
                    graphTier = request.graphTier
                ).toResponse()
        }.toResponseEntity()

    @PostMapping("/{collectionId}/move")
    fun moveCollection(
        @PathVariable collectionId: UUID,
        @RequestBody body: Map<String, String?>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<CollectionResponse> =
        resultOf {
            val userId = userDetails.userId()
            val parentId = body["parent_collection_id"]?.let { UUID.fromString(it) }
            collectionService
                .updateCollection(
                    collectionId = collectionId,
                    userId = userId,
                    parentCollectionId = parentId,
                    moveToParent = true
                ).toResponse()
        }.toResponseEntity()

    @DeleteMapping("/{collectionId}")
    fun deleteCollection(
        @PathVariable collectionId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            val collection =
                collectionService
                    .findById(collectionId)
                    .orNotFound("Collection not found: $collectionId")
            workspaceService.requireEdit(collection.workspaceId, userId, "Edit access required to delete collections")

            collectionService.deleteCollection(collectionId, userId)
        }.toNoContentResponse()

    @GetMapping("/{collectionId}/summary")
    fun getCollectionSummary(
        @PathVariable collectionId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<CollectionSummaryResponse> =
        resultOf {
            val collection = getAccessibleCollection(collectionId, userDetails)
            val summary = collectionService.getCollectionSummary(collectionId)

            CollectionSummaryResponse(
                collectionId = collectionId,
                name = collection.name,
                documentCount = summary["documentCount"] as Long,
                totalSize = summary["totalSizeBytes"] as Long,
                processingStatus = if (summary["isProcessing"] as Boolean) "processing" else "completed"
            )
        }.toResponseEntity()

    @PostMapping("/{collectionId}/generate-description")
    fun generateDescription(
        @PathVariable collectionId: UUID,
        // Optional: the description currently in the editor (possibly user-edited
        // and unsaved). When present, Python refines THIS text by merging in book
        // summaries instead of generating from scratch.
        @RequestBody(required = false) body: Map<String, String>?,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, String>> {
        val userId = userDetails.userId()
        val collection =
            collectionService
                .findById(collectionId)
                .orNotFound("Collection not found: $collectionId")
        workspaceService.requireAccess(collection.workspaceId, userId)

        val grpcRequest =
            GenerateDescriptionRequest
                .newBuilder()
                .setCollectionId(collectionId.toString())
                .setUserId(userId.toString())
                .setExistingDescription(body?.get("existing_description") ?: "")
                .build()

        val response = runBlocking { collectionAIGrpcClient.generateDescription(grpcRequest) }

        return if (response.success) {
            ResponseEntity.ok(mapOf("description" to response.description))
        } else {
            ResponseEntity.ok(mapOf("error" to response.error))
        }
    }

    /**
     * Generate a system-prompt addendum (custom_instructions
     * baseline) for the collection. The Python service auto-generates the
     * collection's description if it has none yet, so the user gets a
     * one-click "fill it in for me" experience even on a fresh empty
     * collection.
     *
     * Response:
     *   { custom_instructions, description_used, description_generated }
     *
     * The frontend should show `custom_instructions` in the textarea and
     * persist it via PUT /collections/{id} when the user clicks Save.
     * If `description_generated` is true, the frontend should ALSO
     * persist `description_used` (so the next regeneration doesn't
     * waste another LLM call).
     */
    @PostMapping("/{collectionId}/generate-custom-instructions")
    fun generateCustomInstructions(
        @PathVariable collectionId: UUID,
        @RequestParam(required = false) language: String?,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> {
        val userId = userDetails.userId()
        val collection =
            collectionService
                .findById(collectionId)
                .orNotFound("Collection not found: $collectionId")
        workspaceService.requireAccess(collection.workspaceId, userId)

        val grpcRequest =
            GenerateCustomInstructionsRequest
                .newBuilder()
                .setCollectionId(collectionId.toString())
                .setUserId(userId.toString())
                .setLanguage(language ?: "")
                .build()

        val response = runBlocking { collectionAIGrpcClient.generateCustomInstructions(grpcRequest) }

        return if (response.success) {
            ResponseEntity.ok(
                mapOf(
                    "custom_instructions" to response.customInstructions,
                    "description_used" to response.descriptionUsed,
                    "description_generated" to response.descriptionGenerated
                )
            )
        } else {
            ResponseEntity.ok(mapOf("error" to response.error))
        }
    }

    @PostMapping("/generate-description-from-name")
    fun generateDescriptionFromName(
        @RequestParam("collection_name") collectionName: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, String>> {
        val userId = userDetails.userId()

        return runCatching {
            val template = prompts.collection.generateDescription
            val result =
                aiGenerationService.generate(
                    prompt = template.user("collection_name" to collectionName),
                    systemPrompt = template.system,
                    userId = userId,
                    maxTokens = 150
                )
            ResponseEntity.ok(mapOf("description" to result.content))
        }.getOrElse { e ->
            ResponseEntity.ok(mapOf("error" to (e.message ?: "Failed to generate description")))
        }
    }
}

private fun Collection.toResponse() =
    CollectionResponse(
        id = id.orThrow("Entity"),
        name = name,
        slug = slug,
        description = description,
        workspaceId = workspaceId,
        userId = workspaceId, // Collections belong to workspaces, not users directly. Using workspaceId as a placeholder.
        parentCollectionId = parentCollectionId,
        depth = depth,
        sortOrder = sortOrder,
        chunkingStrategy = chunkingStrategy ?: "recursive",
        chunkSize = chunkSize ?: 1000,
        chunkOverlap = chunkOverlap ?: 200,
        processingStatus = if (isProcessing) "processing" else "completed",
        settings = emptyMap(), // Collection entity doesn't have settings
        customInstructions = customInstructions,
        graphTier = graphTier,
        createdAt = createdAt.toString(),
        updatedAt = updatedAt.toString()
    )
