package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.common.StatusResponse
import com.scrapalot.backend.grpc.document.*
import io.grpc.Status
import io.grpc.StatusRuntimeException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import mu.KotlinLogging
import org.springframework.stereotype.Service
import java.util.concurrent.TimeUnit
import kotlin.time.Duration.Companion.milliseconds

private val logger = KotlinLogging.logger {}

/**
 * gRPC client for Python DocumentExtrasService.
 *
 * File serving, thumbnails, DOCX previews, uploads, and reading positions.
 * Upload/register methods retry on UNAVAILABLE (backend restart) for up to 5 minutes.
 */
@Service
class DocumentExtrasGrpcClient(
    private val stub: DocumentExtrasServiceGrpcKt.DocumentExtrasServiceCoroutineStub
) {
    companion object {
        private const val MAX_RETRY_DURATION_MS = 5 * 60 * 1000L // 5 minutes
        private const val INITIAL_BACKOFF_MS = 2_000L
        private const val MAX_BACKOFF_MS = 30_000L
        private val RETRYABLE_STATUSES = setOf(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
        private const val STORAGE_USAGE_DEADLINE_SECONDS = 60L
    }

    private suspend fun <T> withRetry(
        operation: String,
        block: suspend () -> T
    ): T {
        val startTime = System.currentTimeMillis()
        var attempt = 0
        var backoff = INITIAL_BACKOFF_MS

        while (true) {
            try {
                return block()
            } catch (e: StatusRuntimeException) {
                val elapsed = System.currentTimeMillis() - startTime
                if (e.status.code !in RETRYABLE_STATUSES || elapsed + backoff > MAX_RETRY_DURATION_MS) {
                    throw e
                }
                attempt++
                logger.warn { "$operation: backend unavailable (attempt $attempt), retrying in ${backoff / 1000}s... (${elapsed / 1000}s elapsed)" }
                delay(backoff.milliseconds)
                backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
            }
        }
    }

    suspend fun uploadDocument(request: UploadDocumentRequest): UploadDocumentResponse {
        logger.info { "gRPC UploadDocument: collection=${request.collectionId}, file=${request.filename}" }
        return withRetry("UploadDocument[${request.filename}]") {
            stub.uploadDocument(request)
        }
    }

    suspend fun getThumbnail(request: GetThumbnailRequest): ThumbnailResponse {
        logger.info { "gRPC GetThumbnail: doc=${request.documentId}, size=${request.size}" }
        return stub.getThumbnail(request)
    }

    suspend fun uploadCustomThumbnail(request: UploadCustomThumbnailRequest): StatusResponse {
        logger.info { "gRPC UploadCustomThumbnail: doc=${request.documentId}" }
        return stub.uploadCustomThumbnail(request)
    }

    suspend fun deleteThumbnail(request: DeleteThumbnailRequest): StatusResponse {
        logger.info { "gRPC DeleteThumbnail: doc=${request.documentId}" }
        return stub.deleteThumbnail(request)
    }

    suspend fun downloadBookCover(documentId: String): DownloadBookCoverResponse {
        logger.info { "gRPC DownloadBookCover: doc=$documentId" }
        return stub.downloadBookCover(
            DownloadBookCoverRequest.newBuilder().setDocumentId(documentId).build()
        )
    }

    suspend fun getDocxPreview(request: DocxPreviewRequest): DocxPreviewResponse {
        logger.info { "gRPC GetDocxPreview: doc=${request.documentId}" }
        return stub.getDocxPreview(request)
    }

    @Suppress("unused") // future API — alternative DOCX preview using Mammoth renderer
    suspend fun getDocxMammothPreview(request: DocxPreviewRequest): DocxPreviewResponse {
        logger.info { "gRPC GetDocxMammothPreview: doc=${request.documentId}" }
        return stub.getDocxMammothPreview(request)
    }

    suspend fun getDocumentFile(request: GetDocumentFileRequest): DocumentFileResponse {
        logger.info { "gRPC GetDocumentFile: doc=${request.documentId}" }
        return stub.getDocumentFile(request)
    }

    suspend fun listCollectionDocuments(request: ListCollectionDocsRequest): ListCollectionDocsResponse {
        logger.info { "gRPC ListCollectionDocuments: collection=${request.collectionId}" }
        return stub.listCollectionDocuments(request)
    }

    suspend fun getReadingPosition(request: ReadingPositionRequest): ReadingPositionResponse {
        logger.info { "gRPC GetReadingPosition: doc=${request.documentId}" }
        return stub.getReadingPosition(request)
    }

    suspend fun setReadingPosition(request: SetReadingPositionRequest): StatusResponse {
        logger.info { "gRPC SetReadingPosition: doc=${request.documentId}, page=${request.page}" }
        return stub.setReadingPosition(request)
    }

    suspend fun getBookSummary(request: GetBookSummaryRequest): BookSummaryResponse {
        logger.info { "gRPC GetBookSummary: doc=${request.documentId}" }
        return stub.getBookSummary(request)
    }

    suspend fun getDocument(documentId: String): DocumentDetailResponse {
        logger.info { "gRPC GetDocument: doc=$documentId" }
        val request =
            GetDocumentByIdRequest
                .newBuilder()
                .setDocumentId(documentId)
                .build()
        return stub.getDocument(request)
    }

    suspend fun deleteDocument(
        documentId: String,
        collectionId: String,
        userId: String
    ): DeleteDocumentByIdResponse {
        logger.info { "gRPC DeleteDocument: doc=$documentId, collection=$collectionId" }
        val request =
            DeleteDocumentByIdRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setCollectionId(collectionId)
                .setUserId(userId)
                .build()
        return stub.deleteDocument(request)
    }

    suspend fun partialDeleteDocument(
        documentId: String,
        collectionId: String,
        userId: String,
        deleteScope: String
    ): PartialDeleteResponse {
        logger.info { "gRPC PartialDeleteDocument: doc=$documentId, scope=$deleteScope" }
        val request =
            PartialDeleteRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setCollectionId(collectionId)
                .setUserId(userId)
                .setDeleteScope(deleteScope)
                .build()
        return stub.partialDeleteDocument(request)
    }

    suspend fun getStorageUsage(collectionIds: List<String>): StorageUsageResponse {
        logger.info { "gRPC GetStorageUsage: collections=${collectionIds.size}" }
        val request =
            GetStorageUsageRequest
                .newBuilder()
                .addAllCollectionIds(collectionIds)
                .build()
        // Walks /app/data/upload + /app/data/thumbnails on disk — slower than the global 15 s default.
        return stub.withDeadlineAfter(STORAGE_USAGE_DEADLINE_SECONDS, TimeUnit.SECONDS).getStorageUsage(request)
    }

    fun generateBookSummary(
        documentId: String,
        userId: String
    ): Flow<SummaryProgressPacket> {
        logger.info { "gRPC GenerateBookSummary: doc=$documentId, user=$userId" }
        val request =
            GenerateBookSummaryRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setUserId(userId)
                .build()
        return stub.generateBookSummary(request)
    }

    fun translateBookSummary(
        documentId: String,
        targetLanguage: String
    ): Flow<TranslationPacket> {
        logger.info { "gRPC TranslateBookSummary: doc=$documentId, lang=$targetLanguage" }
        val request =
            TranslateBookSummaryRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setTargetLanguage(targetLanguage)
                .build()
        return stub.translateBookSummary(request)
    }

    suspend fun registerDocumentFromMarkdown(
        collectionId: String,
        userId: String,
        filename: String,
        title: String,
        markdownContent: String,
        metadataJson: String = "{}"
    ): RegisterMarkdownResponse {
        logger.info { "gRPC RegisterDocumentFromMarkdown: collection=$collectionId, file=$filename" }
        val request =
            RegisterMarkdownRequest
                .newBuilder()
                .setCollectionId(collectionId)
                .setUserId(userId)
                .setFilename(filename)
                .setTitle(title)
                .setMarkdownContent(markdownContent)
                .setMetadataJson(metadataJson)
                .build()
        return withRetry("RegisterMarkdown[$filename]") {
            stub.registerDocumentFromMarkdown(request)
        }
    }

    suspend fun moveDocuments(
        documentIds: List<String>,
        targetCollectionId: String,
        userId: String
    ): MoveDocumentsResponse {
        logger.info { "gRPC MoveDocuments: ${documentIds.size} docs → collection=$targetCollectionId" }
        val request =
            MoveDocumentsRequest
                .newBuilder()
                .addAllDocumentIds(documentIds)
                .setTargetCollectionId(targetCollectionId)
                .setUserId(userId)
                .build()
        return stub.moveDocuments(request)
    }

    suspend fun batchDeleteDocuments(
        documentIds: List<String>,
        userId: String
    ): BatchDeleteDocumentsResponse {
        logger.info { "gRPC BatchDeleteDocuments: ${documentIds.size} docs" }
        val request =
            BatchDeleteDocumentsRequest
                .newBuilder()
                .addAllDocumentIds(documentIds)
                .setUserId(userId)
                .build()
        return stub.batchDeleteDocuments(request)
    }

    suspend fun getCollectionStats(collectionId: String): CollectionStatsResponse {
        logger.info { "gRPC GetCollectionStats: collection=$collectionId" }
        val request =
            GetCollectionStatsRequest
                .newBuilder()
                .setCollectionId(collectionId)
                .build()
        return stub.getCollectionStats(request)
    }

    suspend fun buildDocumentGraph(
        documentId: String,
        collectionId: String,
        userId: String
    ): StatusResponse {
        logger.info { "gRPC BuildDocumentGraph: doc=$documentId" }
        val request =
            BuildDocumentGraphRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setCollectionId(collectionId)
                .setUserId(userId)
                .build()
        return stub.buildDocumentGraph(request)
    }

    suspend fun rebuildDocumentEmbeddings(
        documentId: String,
        collectionId: String,
        userId: String
    ): StatusResponse {
        logger.info { "gRPC RebuildDocumentEmbeddings: doc=$documentId" }
        val request =
            RebuildDocumentEmbeddingsRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setCollectionId(collectionId)
                .setUserId(userId)
                .build()
        return stub.rebuildDocumentEmbeddings(request)
    }

    // ── Multimodal element listing ──────────────────────────────────────────

    suspend fun listDocumentMultimodalElements(
        documentId: String,
        userId: String,
    ): ListDocumentMultimodalElementsResponse {
        logger.info { "gRPC ListDocumentMultimodalElements: doc=$documentId" }
        return stub.listDocumentMultimodalElements(
            ListDocumentMultimodalElementsRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setUserId(userId)
                .build()
        )
    }

    // ── Tags ─────────────────────────────────────────────────────────

    suspend fun listTags(
        userId: String,
        workspaceId: String
    ): ListTagsResponse {
        logger.info { "gRPC ListTags: workspace=$workspaceId" }
        return stub.listTags(
            ListTagsRequest
                .newBuilder()
                .setUserId(userId)
                .setWorkspaceId(workspaceId)
                .build()
        )
    }

    suspend fun tagDocument(
        documentId: String,
        tagId: String,
        userId: String
    ): com.scrapalot.backend.grpc.common.Empty {
        logger.info { "gRPC TagDocument: doc=$documentId, tag=$tagId, user=$userId" }
        return stub.tagDocument(
            TagDocumentRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setTagId(tagId)
                .setUserId(userId)
                .build()
        )
    }

    suspend fun untagDocument(
        documentId: String,
        tagId: String,
        userId: String
    ): com.scrapalot.backend.grpc.common.Empty {
        logger.info { "gRPC UntagDocument: doc=$documentId, tag=$tagId, user=$userId" }
        return stub.untagDocument(
            UntagDocumentRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setTagId(tagId)
                .setUserId(userId)
                .build()
        )
    }

    suspend fun getDocumentTags(documentId: String): ListTagsResponse {
        logger.info { "gRPC GetDocumentTags: doc=$documentId" }
        return stub.getDocumentTags(
            GetDocumentTagsRequest.newBuilder().setDocumentId(documentId).build()
        )
    }

    // ── Document Relations ───────────────────────────────────────────

    suspend fun createDocumentRelation(
        sourceDocId: String,
        targetDocId: String,
        relationType: String,
        userId: String,
        workspaceId: String,
        note: String?,
    ): DocumentRelationResponse {
        logger.info { "gRPC CreateDocumentRelation: $sourceDocId → $targetDocId ($relationType)" }
        val builder =
            CreateRelationRequest
                .newBuilder()
                .setSourceDocumentId(sourceDocId)
                .setTargetDocumentId(targetDocId)
                .setRelationshipType(relationType)
                .setUserId(userId)
                .setWorkspaceId(workspaceId)
        note?.let { builder.setNote(it) }
        return stub.createDocumentRelation(builder.build())
    }

    suspend fun listDocumentRelations(documentId: String): ListRelationsResponse {
        logger.info { "gRPC ListDocumentRelations: doc=$documentId" }
        return stub.listDocumentRelations(
            ListRelationsRequest.newBuilder().setDocumentId(documentId).build()
        )
    }

    @Suppress("unused") // future API — deletes a document relation by source/target/type (use deleteDocumentRelationById for production)
    suspend fun deleteDocumentRelation(
        sourceDocId: String,
        targetDocId: String,
        relationType: String,
        userId: String,
    ): com.scrapalot.backend.grpc.common.Empty {
        logger.info { "gRPC DeleteDocumentRelation: $sourceDocId → $targetDocId ($relationType)" }
        return stub.deleteDocumentRelation(
            DeleteRelationRequest
                .newBuilder()
                .setSourceDocumentId(sourceDocId)
                .setTargetDocumentId(targetDocId)
                .setRelationshipType(relationType)
                .setUserId(userId)
                .build()
        )
    }

    suspend fun deleteDocumentRelationById(
        relationId: String,
        userId: String
    ): com.scrapalot.backend.grpc.common.Empty {
        logger.info { "gRPC DeleteDocumentRelationById: $relationId" }
        return stub.deleteDocumentRelation(
            DeleteRelationRequest
                .newBuilder()
                .setRelationId(relationId)
                .setUserId(userId)
                .build()
        )
    }

    // ── Saved Searches ───────────────────────────────────────────────

    suspend fun createSavedSearch(
        userId: String,
        workspaceId: String,
        name: String,
        criteriaJson: String,
        color: String?,
    ): SavedSearchResponse {
        logger.info { "gRPC CreateSavedSearch: name=$name, workspace=$workspaceId" }
        val builder =
            CreateSavedSearchRequest
                .newBuilder()
                .setUserId(userId)
                .setWorkspaceId(workspaceId)
                .setName(name)
                .setCriteriaJson(criteriaJson)
        color?.let { builder.setColor(it) }
        return stub.createSavedSearch(builder.build())
    }

    suspend fun listSavedSearches(
        userId: String,
        workspaceId: String
    ): ListSavedSearchesResponse {
        logger.info { "gRPC ListSavedSearches: workspace=$workspaceId" }
        return stub.listSavedSearches(
            ListSavedSearchesRequest
                .newBuilder()
                .setUserId(userId)
                .setWorkspaceId(workspaceId)
                .build()
        )
    }

    suspend fun executeSavedSearch(
        searchId: String,
        userId: String,
        limit: Int = 100
    ): ExecuteSavedSearchResponse {
        logger.info { "gRPC ExecuteSavedSearch: search=$searchId" }
        return stub.executeSavedSearch(
            ExecuteSavedSearchRequest
                .newBuilder()
                .setSearchId(searchId)
                .setUserId(userId)
                .setLimit(limit)
                .build()
        )
    }

    suspend fun deleteSavedSearch(
        searchId: String,
        userId: String
    ): com.scrapalot.backend.grpc.common.Empty {
        logger.info { "gRPC DeleteSavedSearch: search=$searchId" }
        return stub.deleteSavedSearch(
            DeleteSavedSearchRequest
                .newBuilder()
                .setSearchId(searchId)
                .setUserId(userId)
                .build()
        )
    }

    suspend fun updateSavedSearch(
        searchId: String,
        userId: String,
        name: String?,
        criteriaJson: String?,
        color: String?,
        isPinned: Boolean?,
    ): SavedSearchResponse {
        logger.info { "gRPC UpdateSavedSearch: search=$searchId" }
        val builder = UpdateSavedSearchRequest.newBuilder().setSearchId(searchId).setUserId(userId)
        name?.let { builder.setName(it) }
        criteriaJson?.let { builder.setCriteriaJson(it) }
        color?.let { builder.setColor(it) }
        isPinned?.let { builder.setIsPinned(it) }
        return stub.updateSavedSearch(builder.build())
    }

    suspend fun previewSavedSearch(
        userId: String,
        workspaceId: String,
        criteriaJson: String
    ): PreviewSavedSearchResponse {
        logger.info { "gRPC PreviewSavedSearch: workspace=$workspaceId" }
        return stub.previewSavedSearch(
            PreviewSavedSearchRequest
                .newBuilder()
                .setUserId(userId)
                .setWorkspaceId(workspaceId)
                .setCriteriaJson(criteriaJson)
                .build()
        )
    }

    // ── Duplicate Detection ──────────────────────────────────────────

    suspend fun findDuplicates(documentId: String): FindDuplicatesResponse {
        logger.info { "gRPC FindDuplicates: doc=$documentId" }
        return stub.findDuplicates(
            FindDuplicatesRequest.newBuilder().setDocumentId(documentId).build()
        )
    }

    suspend fun mergeDuplicates(
        canonicalId: String,
        duplicateId: String,
        userId: String
    ): MergeDuplicatesResponse {
        logger.info { "gRPC MergeDuplicates: canonical=$canonicalId, duplicate=$duplicateId" }
        return stub.mergeDuplicates(
            MergeDuplicatesRequest
                .newBuilder()
                .setCanonicalId(canonicalId)
                .setDuplicateId(duplicateId)
                .setUserId(userId)
                .build()
        )
    }

    // ── Metadata Enrichment ───────────────────────────────────────────

    suspend fun enrichDocumentMetadata(
        documentId: String,
        userId: String,
        forceRefresh: Boolean = false
    ): EnrichMetadataResponse {
        logger.info { "gRPC EnrichDocumentMetadata: doc=$documentId force=$forceRefresh" }
        return stub.enrichDocumentMetadata(
            EnrichMetadataRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setUserId(userId)
                .setForceRefresh(forceRefresh)
                .build()
        )
    }

    suspend fun lookupIdentifier(
        documentId: String,
        userId: String,
        identifierType: String,
        identifierValue: String
    ): LookupIdentifierResponse {
        logger.info { "gRPC LookupIdentifier: doc=$documentId type=$identifierType value=$identifierValue" }
        return stub.lookupIdentifier(
            LookupIdentifierRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setUserId(userId)
                .setIdentifierType(identifierType)
                .setIdentifierValue(identifierValue)
                .build()
        )
    }

    suspend fun updateDocumentType(
        documentId: String,
        userId: String,
        documentType: String
    ): UpdateDocumentTypeResponse {
        logger.info { "gRPC UpdateDocumentType: doc=$documentId type=$documentType" }
        return stub.updateDocumentType(
            UpdateDocumentTypeRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setUserId(userId)
                .setDocumentType(documentType)
                .build()
        )
    }

    suspend fun updateDocumentPriority(
        documentId: String,
        userId: String,
        priority: Double
    ): UpdateDocumentPriorityResponse {
        logger.info { "gRPC UpdateDocumentPriority: doc=$documentId priority=$priority" }
        return stub.updateDocumentPriority(
            UpdateDocumentPriorityRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setUserId(userId)
                .setPriority(priority)
                .build()
        )
    }

    suspend fun restoreDocument(
        documentId: String,
        userId: String
    ): UpdateDocumentTypeResponse {
        logger.info { "gRPC RestoreDocument: doc=$documentId" }
        return stub.restoreDocument(
            RestoreDocumentRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setUserId(userId)
                .build()
        )
    }

    suspend fun purgeTrash(userId: String): UpdateDocumentTypeResponse {
        logger.info { "gRPC PurgeTrash: user=$userId" }
        return stub.purgeTrash(
            PurgeTrashRequest
                .newBuilder()
                .setUserId(userId)
                .build()
        )
    }

    suspend fun findOpenAccessPdf(
        documentId: String,
        userId: String
    ): FindOpenAccessPdfResponse {
        logger.info { "gRPC FindOpenAccessPdf: doc=$documentId" }
        return stub.findOpenAccessPdf(
            FindOpenAccessPdfRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setUserId(userId)
                .build()
        )
    }

    suspend fun extractPdfAnnotations(
        documentId: String,
        userId: String
    ): ExtractPdfAnnotationsResponse {
        logger.info { "gRPC ExtractPdfAnnotations: doc=$documentId" }
        return stub.extractPdfAnnotations(
            ExtractPdfAnnotationsRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setUserId(userId)
                .build()
        )
    }
}
