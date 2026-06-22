package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.collection.*
import com.scrapalot.backend.grpc.common.PageResponse
import com.scrapalot.backend.grpc.common.StatusResponse
import com.scrapalot.backend.grpc.common.Timestamp
import com.scrapalot.backend.service.CollectionService
import com.scrapalot.backend.service.WorkspaceService
import com.scrapalot.backend.utils.grpcCall
import com.scrapalot.backend.utils.orThrow
import io.grpc.Status
import io.grpc.StatusRuntimeException
import mu.KotlinLogging
import net.devh.boot.grpc.server.service.GrpcService
import org.springframework.data.domain.PageRequest
import org.springframework.data.domain.Sort
import java.util.UUID
import com.scrapalot.backend.grpc.common.UUID as ProtoUUID

private val logger = KotlinLogging.logger {}

@Suppress("HasPlatformType") // gRPC grpcCall { } infers return type from proto builder — explicit types would be verbose
@GrpcService
class CollectionServiceImpl(
    private val collectionService: CollectionService,
    private val workspaceService: WorkspaceService,
    private val documentExtrasGrpcClient: DocumentExtrasGrpcClient,
) : CollectionServiceGrpcKt.CollectionServiceCoroutineImplBase() {
    // ── CRUD ─────────────────────────────────────────────────────────────────

    override suspend fun getCollection(request: GetCollectionRequest) =
        grpcCall {
            val collectionId = request.collectionId.uuid()
            val userId = request.userId.uuid()
            val collection =
                collectionService.findById(collectionId)
                    ?: throw StatusRuntimeException(Status.NOT_FOUND.withDescription("Collection not found: $collectionId"))
            requireAccess(collection.workspaceId, userId)
            logger.debug { "Retrieved collection: $collectionId for user: $userId" }
            collection.toResponse()
        }

    override suspend fun listCollections(request: ListCollectionsRequest) =
        grpcCall {
            val userId = request.userId.uuid()
            val pageRequest = request.buildPageRequest()

            val collectionsPage =
                if (request.hasWorkspaceId()) {
                    val workspaceId = request.workspaceId.uuid()
                    requireAccess(workspaceId, userId)
                    collectionService.findByWorkspaceId(workspaceId, pageRequest)
                } else {
                    val workspaceIds = workspaceService.findAllAccessibleWorkspaces(userId).mapNotNull { it.id }
                    if (workspaceIds.isEmpty()) return@grpcCall emptyCollectionList(pageRequest.pageSize)
                    collectionService.findByWorkspaceIds(workspaceIds, pageRequest)
                }

            logger.debug { "Listed ${collectionsPage.content.size} collections for user: $userId" }
            CollectionListResponse
                .newBuilder()
                .addAllCollections(collectionsPage.content.map { it.toResponse() })
                .setPageInfo(collectionsPage.toPageResponse())
                .build()
        }

    override suspend fun createCollection(request: CreateCollectionRequest) =
        grpcCall {
            val userId = request.userId.uuid()
            val workspaceId = request.workspaceId.uuid()
            val name = request.name.requireNotBlank("Collection name")
            val collection =
                collectionService.createCollection(
                    name = name,
                    workspaceId = workspaceId,
                    userId = userId,
                    description = request.optionalStr { description },
                    chunkingStrategy = request.optionalStr { chunkingStrategy },
                )
            logger.info { "Created collection: ${collection.id} in workspace: $workspaceId" }
            collection.toResponse()
        }

    override suspend fun updateCollection(request: UpdateCollectionRequest) =
        grpcCall {
            val collection =
                collectionService.updateCollection(
                    collectionId = request.collectionId.uuid(),
                    userId = request.userId.uuid(),
                    name = request.optionalStr { name },
                    description = request.optionalStr { description },
                    chunkingStrategy = request.optionalStr { chunkingStrategy },
                )
            logger.info { "Updated collection: ${request.collectionId.value}" }
            collection.toResponse()
        }

    override suspend fun deleteCollection(request: DeleteCollectionRequest) =
        grpcCall {
            collectionService.deleteCollection(request.collectionId.uuid(), request.userId.uuid())
            logger.info { "Deleted collection: ${request.collectionId.value}" }
            statusOk("Collection deleted successfully")
        }

    override suspend fun getCollectionSummary(request: GetCollectionRequest) =
        grpcCall {
            val collectionId = request.collectionId.uuid()
            val collection =
                collectionService.findById(collectionId)
                    ?: throw StatusRuntimeException(Status.NOT_FOUND.withDescription("Collection not found: $collectionId"))
            requireAccess(collection.workspaceId, request.userId.uuid())

            val summary = collectionService.getCollectionSummary(collectionId)
            logger.debug { "Retrieved summary for collection: $collectionId" }

            CollectionSummary
                .newBuilder()
                .setId(collectionId.toProto())
                .setName(summary["name"] as String)
                .setDocumentCount((summary["documentCount"] as Number).toInt())
                .setTotalSizeBytes((summary["totalSizeBytes"] as Number).toLong())
                .setStatus(if (collection.isProcessing) "processing" else "ready")
                .apply { collection.chunkingStrategy?.let { setChunkingStrategy(it) } }
                .build()
        }

    override suspend fun notifyDocumentProcessed(request: DocumentProcessedNotification) =
        grpcCall {
            logger.info { "Document processed: collection=${request.collectionId.value}, doc=${request.documentId.value}, status=${request.status}" }
            if (request.hasErrorMessage()) logger.warn { "Processing failed: ${request.documentId.value} - ${request.errorMessage}" }
            statusOk("Notification received")
        }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private fun ProtoUUID.uuid(): UUID =
        runCatching { UUID.fromString(value) }
            .getOrElse { throw StatusRuntimeException(Status.INVALID_ARGUMENT.withDescription("Invalid UUID: $value")) }

    private fun UUID.toProto() = ProtoUUID.newBuilder().setValue(toString()).build()

    @Suppress("SameParameterValue")
    private fun String.requireNotBlank(field: String): String = takeIf { it.isNotBlank() } ?: throw StatusRuntimeException(Status.INVALID_ARGUMENT.withDescription("$field cannot be blank"))

    private inline fun <T> T.optionalStr(getter: T.() -> String): String? = getter().takeIf { it.isNotBlank() }

    private fun requireAccess(
        workspaceId: UUID,
        userId: UUID
    ) {
        if (!workspaceService.hasAccess(workspaceId, userId)) {
            throw StatusRuntimeException(Status.PERMISSION_DENIED.withDescription("User does not have access"))
        }
    }

    private fun statusOk(msg: String) =
        StatusResponse
            .newBuilder()
            .setSuccess(true)
            .setMessage(msg)
            .build()

    private fun java.time.Instant.toTs() =
        Timestamp
            .newBuilder()
            .setSeconds(epochSecond)
            .setNanos(nano)
            .build()

    private fun ListCollectionsRequest.buildPageRequest(): PageRequest =
        if (hasPage()) {
            val p = page
            PageRequest.of(
                p.page,
                p.size.coerceIn(1, 100),
                Sort.by(if (p.sortDirection.lowercase() == "asc") Sort.Direction.ASC else Sort.Direction.DESC, p.sortBy.ifBlank { "createdAt" })
            )
        } else {
            PageRequest.of(0, 20, Sort.by(Sort.Direction.DESC, "createdAt"))
        }

    private fun emptyCollectionList(pageSize: Int) =
        CollectionListResponse
            .newBuilder()
            .setPageInfo(PageResponse.newBuilder().setPageSize(pageSize).build())
            .build()

    private fun <T> org.springframework.data.domain.Page<T>.toPageResponse() =
        PageResponse
            .newBuilder()
            .setTotalPages(totalPages)
            .setTotalElements(totalElements)
            .setCurrentPage(number)
            .setPageSize(size)
            .setHasNext(hasNext())
            .setHasPrevious(hasPrevious())
            .build()

    private fun com.scrapalot.backend.domain.collection.Collection.toResponse(): CollectionResponse {
        val collectionId = id.orThrow("Collection")

        @Suppress("RunBlocking") // called from suspend gRPC handler via non-suspend extension; runBlocking bridges the gap
        val usage = kotlinx.coroutines.runBlocking { documentExtrasGrpcClient.getStorageUsage(listOf(collectionId.toString())) }
        return CollectionResponse
            .newBuilder()
            .setId(collectionId.toProto())
            .setName(name)
            .setWorkspaceId(workspaceId.toProto())
            .setDocumentCount(usage.documentCount.toInt())
            .setCreatedAt(createdAt.toTs())
            .setUpdatedAt(updatedAt.toTs())
            .apply {
                description?.let { setDescription(it) }
                chunkingStrategy?.let { setChunkingStrategy(it) }
            }.build()
    }
}
