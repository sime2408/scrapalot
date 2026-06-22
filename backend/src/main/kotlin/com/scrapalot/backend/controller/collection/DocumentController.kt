package com.scrapalot.backend.controller.collection

import com.fasterxml.jackson.databind.ObjectMapper
import com.google.protobuf.ByteString
import com.scrapalot.backend.dto.DocumentResponse
import com.scrapalot.backend.dto.RegisterMarkdownDocumentRequest
import com.scrapalot.backend.dto.RegisterMarkdownDocumentResponse
import com.scrapalot.backend.dto.StorageUsageResponse
import com.scrapalot.backend.grpc.DocumentCollectionGrpcClient
import com.scrapalot.backend.grpc.DocumentExtrasGrpcClient
import com.scrapalot.backend.grpc.DocumentProcessingGrpcClient
import com.scrapalot.backend.grpc.JobsGrpcClient
import com.scrapalot.backend.grpc.document.*
import com.scrapalot.backend.grpc.jobs.GetJobStatusRequest
import com.scrapalot.backend.service.CollectionService
import com.scrapalot.backend.service.DocumentViewService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.service.WorkspaceService
import com.scrapalot.backend.utils.*
import io.grpc.Status
import io.grpc.StatusRuntimeException
import jakarta.validation.Valid
import kotlinx.coroutines.runBlocking
import mu.KotlinLogging
import org.springframework.core.io.FileSystemResource
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import org.springframework.web.multipart.MultipartFile
import org.springframework.web.server.ResponseStatusException
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody
import java.io.File
import java.util.NoSuchElementException
import java.util.UUID

private val logger = KotlinLogging.logger {}

@RestController
@RequestMapping("/api/v1/documents")
class DocumentController(
    private val collectionService: CollectionService,
    private val workspaceService: WorkspaceService,
    private val userService: UserService,
    private val documentExtrasGrpcClient: DocumentExtrasGrpcClient,
    private val documentProcessingGrpcClient: DocumentProcessingGrpcClient,
    private val documentCollectionGrpcClient: DocumentCollectionGrpcClient,
    private val jobsGrpcClient: JobsGrpcClient,
    private val documentViewService: DocumentViewService,
    private val objectMapper: ObjectMapper,
) {
    // ── Auth helpers ─────────────────────────────────────────────────────────

    private fun UserDetails.userId() = authenticatedUserId(userService)

    private fun requireCollectionAccess(
        collectionId: UUID,
        userId: UUID
    ) {
        val collection = collectionService.findById(collectionId).orNotFound("Collection not found: $collectionId")
        workspaceService.requireAccess(collection.workspaceId, userId)
    }

    private fun requireCollectionEdit(
        collectionId: UUID,
        userId: UUID
    ) {
        val collection = collectionService.findById(collectionId).orNotFound("Collection not found: $collectionId")
        workspaceService.requireEdit(collection.workspaceId, userId)
    }

    // ── Document CRUD ────────────────────────────────────────────────────────

    @GetMapping("/{documentId}")
    fun getDocument(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val userId = user.userId()
        val response = documentExtrasGrpcClient.getDocument(documentId.toString())
        if (!response.found) throw NoSuchElementException("Document not found: $documentId")
        requireCollectionAccess(UUID.fromString(response.collectionId), userId)
        ResponseEntity.ok(response.toDocumentResponse())
    }

    @DeleteMapping("/{documentId}")
    fun deleteDocument(
        @PathVariable documentId: UUID,
        @RequestParam(required = false) collectionId: UUID?,
        @AuthenticationPrincipal user: UserDetails,
    ): ResponseEntity<Void> =
        runBlocking {
            val userId = user.userId()
            val doc = documentExtrasGrpcClient.getDocument(documentId.toString())
            if (!doc.found) throw NoSuchElementException("Document not found: $documentId")
            requireCollectionEdit(UUID.fromString(doc.collectionId), userId)
            val result = documentExtrasGrpcClient.deleteDocument(documentId.toString(), doc.collectionId, userId.toString())
            check(result.success) { result.message }
            documentViewService.deleteAllForDocument(documentId)
            ResponseEntity.noContent().build()
        }

    @DeleteMapping("/{documentId}/partial")
    fun partialDeleteDocument(
        @PathVariable documentId: UUID,
        @RequestParam scope: String,
        @AuthenticationPrincipal user: UserDetails,
    ) = runBlocking {
        val userId = user.userId()
        val doc = documentExtrasGrpcClient.getDocument(documentId.toString())
        if (!doc.found) throw NoSuchElementException("Document not found: $documentId")
        requireCollectionEdit(UUID.fromString(doc.collectionId), userId)
        val result = documentExtrasGrpcClient.partialDeleteDocument(documentId.toString(), doc.collectionId, userId.toString(), scope)
        check(result.success) { result.message }
        ResponseEntity.ok(mapOf("success" to true, "message" to result.message))
    }

    // ── Multimodal elements ──────────────────────────────────────────────────

    @GetMapping("/{documentId}/multimodal-elements")
    fun listMultimodalElements(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal user: UserDetails,
    ) = runBlocking {
        val userId = user.userId()
        val doc = documentExtrasGrpcClient.getDocument(documentId.toString())
        if (!doc.found) throw NoSuchElementException("Document not found: $documentId")
        requireCollectionAccess(UUID.fromString(doc.collectionId), userId)
        val response =
            documentExtrasGrpcClient.listDocumentMultimodalElements(
                documentId.toString(),
                userId.toString(),
            )
        ResponseEntity.ok(
            mapOf(
                "elements" to
                    response.elementsList.map { e ->
                        mapOf(
                            "id" to e.id,
                            "element_type" to e.elementType,
                            "entity_subtype" to e.entitySubtype.ifEmpty { null },
                            "page_idx" to e.pageIdx,
                            "entity_name" to e.entityName.ifEmpty { null },
                            "caption" to e.caption.ifEmpty { null },
                            "description" to e.description.ifEmpty { null },
                            "content_text" to e.contentText.ifEmpty { null },
                            "storage_path" to e.storagePath.ifEmpty { null },
                            "bbox_json" to e.bboxJson.ifEmpty { null },
                            "symbol_map_json" to e.symbolMapJson.ifEmpty { null },
                            "structured_data_json" to e.structuredDataJson.ifEmpty { null },
                            "derived_stats_json" to e.derivedStatsJson.ifEmpty { null },
                            "processing_status" to e.processingStatus,
                            "described_at" to e.describedAt.ifEmpty { null },
                        )
                    },
                "total_count" to response.totalCount,
            )
        )
    }

    // ── Storage ──────────────────────────────────────────────────────────────

    @GetMapping("/storage/collection/{collectionId}")
    fun getCollectionStorageUsage(
        @PathVariable collectionId: UUID,
        @AuthenticationPrincipal user: UserDetails
    ): ResponseEntity<StorageUsageResponse> =
        runBlocking {
            requireCollectionAccess(collectionId, user.userId())
            val usage = documentExtrasGrpcClient.getStorageUsage(listOf(collectionId.toString()))
            ResponseEntity.ok(StorageUsageResponse(collectionId, null, usage.documentCount, usage.totalSizeBytes, formatBytes(usage.totalSizeBytes)))
        }

    @GetMapping("/storage/workspace/{workspaceId}")
    fun getWorkspaceStorageUsage(
        @PathVariable workspaceId: UUID,
        @AuthenticationPrincipal user: UserDetails
    ): ResponseEntity<StorageUsageResponse> =
        runBlocking {
            workspaceService.requireAccess(workspaceId, user.userId())
            val ids = collectionService.findByWorkspaceId(workspaceId).mapNotNull { it.id?.toString() }
            val usage = ids.takeIf { it.isNotEmpty() }?.let { documentExtrasGrpcClient.getStorageUsage(it) }
            ResponseEntity.ok(StorageUsageResponse(null, workspaceId, usage?.documentCount ?: 0, usage?.totalSizeBytes ?: 0, formatBytes(usage?.totalSizeBytes ?: 0)))
        }

    @GetMapping("/collection/{collectionId}/stats")
    fun getCollectionStats(
        @PathVariable collectionId: UUID,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        requireCollectionAccess(collectionId, user.userId())
        val s = documentExtrasGrpcClient.getCollectionStats(collectionId.toString())
        ResponseEntity.ok(
            mapOf(
                "total_documents" to s.totalDocuments,
                "docs_stored_on_disk" to s.docsStoredOnDisk,
                "docs_memory_only" to s.docsMemoryOnly,
                "docs_with_embeddings" to s.docsWithEmbeddings,
                "total_embedding_chunks" to s.totalEmbeddingChunks,
                "graph_completed" to s.graphCompleted,
                "graph_entity_running" to s.graphEntityRunning,
                "graph_hierarchy_done" to s.graphHierarchyDone,
                "graph_failed" to s.graphFailed,
                "graph_pending" to s.graphPending,
                "docs_with_summaries" to s.docsWithSummaries,
                "total_summary_records" to s.totalSummaryRecords,
                "docs_with_thumbnails" to s.docsWithThumbnails,
            )
        )
    }

    // ── Graph & Embeddings ───────────────────────────────────────────────────

    @PostMapping("/{documentId}/build-graph")
    fun buildDocumentGraph(
        @PathVariable documentId: UUID,
        @RequestParam("collection_id") collectionId: UUID,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val r = documentExtrasGrpcClient.buildDocumentGraph(documentId.toString(), collectionId.toString(), user.userId().toString())
        ResponseEntity.ok(mapOf("success" to r.success, "message" to r.message))
    }

    @PostMapping("/{documentId}/rebuild-embeddings")
    fun rebuildDocumentEmbeddings(
        @PathVariable documentId: UUID,
        @RequestParam("collection_id") collectionId: UUID,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val r = documentExtrasGrpcClient.rebuildDocumentEmbeddings(documentId.toString(), collectionId.toString(), user.userId().toString())
        ResponseEntity.ok(mapOf("success" to r.success, "message" to r.message))
    }

    // ── Processing ──────────────────────────────────────────────────────────

    @PostMapping("/process/{documentId}")
    fun processDocument(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal user: UserDetails,
    ) = runBlocking {
        val userId = user.userId()
        try {
            var result: Map<String, Any?> = mapOf("message" to "Processing started", "document_id" to documentId.toString(), "job_id" to documentId.toString(), "status" to "processing")
            documentProcessingGrpcClient.processDocument(documentId.toString(), userId.toString()).collect { chunk ->
                result =
                    mapOf(
                        "message" to chunk.message,
                        "document_id" to documentId.toString(),
                        "job_id" to chunk.jobId.ifEmpty { documentId.toString() },
                        "status" to chunk.status,
                    )
            }
            ResponseEntity.ok(result)
        } catch (e: StatusRuntimeException) {
            handleDocumentProcessingGrpcError(e, documentId, "processing")
        }
    }

    @PostMapping("/reprocess/{documentId}")
    fun reprocessDocument(
        @PathVariable documentId: UUID,
        @RequestParam(value = "collection_id", required = false) collectionId: String?,
        @AuthenticationPrincipal user: UserDetails,
    ) = runBlocking {
        val userId = user.userId()
        val effectiveCollectionId = collectionId ?: ""
        try {
            var result: Map<String, Any?> = mapOf("message" to "Reprocessing started", "document_id" to documentId.toString(), "job_id" to documentId.toString(), "status" to "processing")
            documentProcessingGrpcClient.reprocessDocument(documentId.toString(), userId.toString(), effectiveCollectionId).collect { chunk ->
                result =
                    mapOf(
                        "message" to chunk.message,
                        "document_id" to documentId.toString(),
                        "job_id" to chunk.jobId.ifEmpty { documentId.toString() },
                        "status" to chunk.status,
                    )
            }
            ResponseEntity.ok(result)
        } catch (e: StatusRuntimeException) {
            handleDocumentProcessingGrpcError(e, documentId, "reprocessing")
        }
    }

    @PostMapping("/process_pending_documents/{collectionId}")
    fun processPendingDocuments(
        @PathVariable collectionId: UUID,
        @AuthenticationPrincipal user: UserDetails,
    ) = runBlocking {
        val userId = user.userId()
        val collection = collectionService.findById(collectionId).orNotFound("Collection not found: $collectionId")
        workspaceService.requireAccess(collection.workspaceId, userId)
        try {
            var result: Map<String, Any?> = mapOf("message" to "No pending documents", "documents_processed" to 0)
            documentProcessingGrpcClient.processPendingDocuments(collectionId.toString(), userId.toString(), collection.workspaceId.toString()).collect { chunk ->
                result =
                    mapOf(
                        "message" to chunk.message,
                        "documents_processed" to chunk.progress.toInt(),
                    )
            }
            ResponseEntity.ok(result)
        } catch (e: StatusRuntimeException) {
            logger.error(e) { "gRPC error processing pending documents for collection $collectionId" }
            throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, e.status.description ?: "Batch processing failed")
        }
    }

    // ── Upload ───────────────────────────────────────────────────────────────

    @PostMapping("/upload")
    fun uploadDocument(
        @RequestParam collectionId: String,
        @RequestParam file: MultipartFile,
        @RequestParam(defaultValue = "true") autoProcess: Boolean,
        @RequestParam(value = "store_file", defaultValue = "true") storeFile: Boolean,
        @RequestParam(value = "build_graph", defaultValue = "false") buildGraph: Boolean,
        @RequestParam(value = "generate_summary", defaultValue = "false") generateSummary: Boolean,
        @AuthenticationPrincipal user: UserDetails,
    ) = runBlocking {
        val response =
            documentExtrasGrpcClient.uploadDocument(
                UploadDocumentRequest
                    .newBuilder()
                    .setCollectionId(collectionId)
                    .setFilename(file.originalFilename ?: "unknown")
                    .setFileData(ByteString.copyFrom(file.bytes))
                    .setUserId(user.userId().toString())
                    .setAutoProcess(autoProcess)
                    .setStoreFile(storeFile)
                    .setBuildGraph(buildGraph)
                    .setGenerateSummary(generateSummary)
                    .build()
            )
        if (response.success) {
            ResponseEntity.ok(mapOf("success" to true, "document_id" to response.documentId, "job_id" to response.jobId, "message" to response.message))
        } else {
            ResponseEntity.badRequest().body(mapOf("success" to false, "error" to response.error))
        }
    }

    @PostMapping("/upload_stream", produces = ["text/plain"])
    fun uploadDocumentStream(
        @RequestParam("collection_id") collectionId: String,
        @RequestParam file: MultipartFile,
        @RequestParam(value = "auto_process", defaultValue = "false") autoProcess: String,
        @RequestParam(value = "store_file", defaultValue = "true") storeFile: String,
        @RequestParam(value = "build_graph", defaultValue = "false") buildGraph: String,
        @RequestParam(value = "generate_summary", defaultValue = "false") generateSummary: String,
        @RequestParam(value = "workspace_id", required = false) workspaceId: String?,
        @AuthenticationPrincipal user: UserDetails,
    ): ResponseEntity<StreamingResponseBody> {
        val userId = runBlocking { user.userId() }

        fun String.toBool() = lowercase() in listOf("true", "1", "yes", "on")

        val body =
            StreamingResponseBody { output ->
                output.bufferedWriter().use { writer ->
                    fun emit(json: String) {
                        writer.write(json)
                        writer.newLine()
                        writer.flush()
                    }
                    emit("""{"type":"status","content":{"status":"processing","progress":2,"message":"Starting file upload..."}}""")
                    try {
                        val response =
                            runBlocking {
                                documentExtrasGrpcClient.uploadDocument(
                                    UploadDocumentRequest
                                        .newBuilder()
                                        .setCollectionId(collectionId)
                                        .setFilename(file.originalFilename ?: "unknown")
                                        .setFileData(ByteString.copyFrom(file.bytes))
                                        .setUserId(userId.toString())
                                        .setAutoProcess(autoProcess.toBool())
                                        .setStoreFile(!storeFile.lowercase().let { it in listOf("false", "0", "no", "off") })
                                        .setBuildGraph(buildGraph.toBool())
                                        .setGenerateSummary(generateSummary.toBool())
                                        .build()
                                )
                            }
                        if (response.success) {
                            // CLAUDE.md rule #16 (frontend): emit camelCase status
                            // codes, never English. Frontend translates via
                            // `knowledge.uploader.<code>`. Adding a new code here
                            // means adding the matching key in en + hr translation
                            // files, otherwise the user sees the raw code.
                            when {
                                response.message.startsWith(
                                    "Skipped"
                                ) -> emit("""{"type":"status","content":{"status":"completed","progress":100,"message":"alreadyExistsThumbnailsUpdated","document_id":"${response.documentId}"}}""")
                                response.message.startsWith(
                                    "Memory-only"
                                ) ->
                                    emit(
                                        """{"type":"status","content":{"status":"completed","progress":100,"message":"documentUpgradedFileStored","document_id":"${response.documentId}","file_stored":true}}"""
                                    )
                                else -> {
                                    // Upload phase finished — the per-job STOMP
                                    // tracker subscribes to /topic/job.{jobId}
                                    // and drives progress from 10 -> 100 as
                                    // Celery workers publish parse/chunk/embed
                                    // events. Emitting status="completed" here
                                    // made the UI treat the whole job as done
                                    // at 10 %, which is why the bar jumped
                                    // straight from 10 % to done without any
                                    // intermediate progress. Keep the status at
                                    // "processing" so the tracker stays armed.
                                    emit(
                                        """{"type":"status","content":{"status":"processing","progress":5,"message":"fileSavedQueued","document_id":"${response.documentId}","job_id":"${response.jobId}"}}"""
                                    )
                                    emit(
                                        """{"type":"status","content":{"status":"processing","progress":10,"message":"uploadCompleteProcessing","document_id":"${response.documentId}","job_id":"${response.jobId}"}}"""
                                    )
                                }
                            }
                        } else {
                            emit("""{"type":"error","content":{"detail":"${response.error.replace("\"", "'")}"}}""")
                        }
                    } catch (e: Exception) {
                        emit("""{"type":"error","content":{"detail":"${(e.message ?: "Upload failed").replace("\"", "'")}"}}""")
                    }
                }
            }
        return ResponseEntity.ok().contentType(MediaType.TEXT_PLAIN).body(body)
    }

    @PostMapping("/register-markdown")
    fun registerDocumentFromMarkdown(
        @Valid @RequestBody request: RegisterMarkdownDocumentRequest,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val userId = user.userId()
        val collectionId = runCatching { UUID.fromString(request.collectionId) }.getOrElse { throw IllegalArgumentException("Invalid collection ID") }
        requireCollectionEdit(collectionId, userId)
        val markdownBytes = request.markdownContent.toByteArray(Charsets.UTF_8).size
        require(markdownBytes <= 9 * 1024 * 1024) { "Markdown content too large: ${markdownBytes / 1024 / 1024} MB (max 9 MB)" }
        val response =
            documentExtrasGrpcClient.registerDocumentFromMarkdown(
                request.collectionId,
                userId.toString(),
                request.filename,
                request.title,
                request.markdownContent,
                objectMapper.writeValueAsString(request.metadata),
            )
        check(response.success) { "Markdown registration failed: ${response.error}" }
        ResponseEntity.status(201).body(RegisterMarkdownDocumentResponse(documentId = response.documentId))
    }

    // ── Thumbnails ───────────────────────────────────────────────────────────

    @GetMapping("/{documentId}/thumbnail")
    fun getThumbnail(
        @PathVariable documentId: UUID,
        @RequestParam(defaultValue = "medium") size: String
    ): ResponseEntity<Any> =
        runBlocking {
            val response =
                documentExtrasGrpcClient.getThumbnail(
                    GetThumbnailRequest
                        .newBuilder()
                        .setDocumentId(documentId.toString())
                        .setSize(size)
                        .build()
                )
            if (response.found && response.filePath.isNotEmpty()) {
                val file = File(response.filePath)
                if (file.exists()) {
                    ResponseEntity.ok().contentType(MediaType.parseMediaType(response.contentType.ifEmpty { "image/png" })).body(FileSystemResource(file))
                } else {
                    ResponseEntity.notFound().build()
                }
            } else {
                ResponseEntity.notFound().build()
            }
        }

    @PostMapping("/{documentId}/thumbnail")
    fun uploadCustomThumbnail(
        @PathVariable documentId: UUID,
        @RequestParam file: MultipartFile
    ) = runBlocking {
        val r =
            documentExtrasGrpcClient.uploadCustomThumbnail(
                UploadCustomThumbnailRequest
                    .newBuilder()
                    .setDocumentId(documentId.toString())
                    .setImageData(
                        ByteString.copyFrom(file.bytes)
                    ).setFilename(file.originalFilename ?: "thumbnail.png")
                    .build()
            )
        ResponseEntity.ok(mapOf("success" to r.success, "message" to r.message))
    }

    @DeleteMapping("/{documentId}/thumbnail")
    fun deleteThumbnail(
        @PathVariable documentId: UUID
    ) = runBlocking {
        val r = documentExtrasGrpcClient.deleteThumbnail(DeleteThumbnailRequest.newBuilder().setDocumentId(documentId.toString()).build())
        ResponseEntity.ok(mapOf("success" to r.success, "message" to r.message))
    }

    @PostMapping("/{documentId}/cover/download")
    fun downloadBookCover(
        @PathVariable documentId: UUID
    ) = runBlocking {
        val r = documentExtrasGrpcClient.downloadBookCover(documentId.toString())
        ResponseEntity.ok(
            mapOf(
                "success" to r.success,
                "message" to r.message,
                "isbn" to r.isbn,
                "source" to r.source
            )
        )
    }

    // ── Document file serving ────────────────────────────────────────────────

    @GetMapping("/{documentId}/file")
    fun getDocumentFile(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal user: UserDetails,
        @RequestParam(required = false, defaultValue = "false") download: Boolean
    ) = runBlocking {
        val response = documentExtrasGrpcClient.getDocumentFile(GetDocumentFileRequest.newBuilder().setDocumentId(documentId.toString()).build())
        if (response.found && response.filePath.isNotEmpty()) {
            val file = File(response.filePath)
            val disposition = if (download) "attachment" else "inline"
            if (file.exists()) {
                ResponseEntity
                    .ok()
                    .contentType(MediaType.parseMediaType(response.contentType.ifEmpty { "application/octet-stream" }))
                    .header("Content-Disposition", "$disposition; filename=\"${response.filename}\"")
                    .body(FileSystemResource(file))
            } else {
                ResponseEntity.notFound().build()
            }
        } else {
            ResponseEntity.notFound().build()
        }
    }

    @GetMapping("/{documentId}/preview/docx")
    fun getDocxPreview(
        @PathVariable documentId: UUID
    ) = runBlocking {
        val r = documentExtrasGrpcClient.getDocxPreview(DocxPreviewRequest.newBuilder().setDocumentId(documentId.toString()).build())
        if (r.success) {
            ResponseEntity.ok(mapOf("success" to true, "html" to r.html, "metadata" to r.metadataJson))
        } else {
            ResponseEntity.badRequest().body(mapOf("success" to false, "error" to r.error))
        }
    }

    // ── Collection documents ─────────────────────────────────────────────────

    @GetMapping("/collection/{collectionId}")
    fun listCollectionDocuments(
        @PathVariable collectionId: UUID,
        @RequestParam(defaultValue = "1") page: Int,
        @RequestParam(value = "page_size", defaultValue = "20") pageSize: Int,
        @RequestParam(required = false) search: String?,
        @RequestParam(required = false) folderId: UUID?,
        @AuthenticationPrincipal user: UserDetails,
    ) = runBlocking {
        val r =
            documentExtrasGrpcClient.listCollectionDocuments(
                ListCollectionDocsRequest
                    .newBuilder()
                    .setCollectionId(collectionId.toString())
                    .setPage(page)
                    .setPageSize(pageSize)
                    .setSearch(search ?: "")
                    .build()
            )
        """{"documents":${r.documentsJson},"hasMore":${r.hasMore},"total":${r.total}}""".asJsonResponse()
    }

    // ── Book summary & translation ───────────────────────────────────────────

    @GetMapping("/{documentId}/summary")
    fun getBookSummary(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val r =
            documentExtrasGrpcClient.getBookSummary(
                GetBookSummaryRequest
                    .newBuilder()
                    .setDocumentId(documentId.toString())
                    .setUserId(user.userId().toString())
                    .build()
            )
        ResponseEntity.ok(mapOf("found" to r.found, "summary_text" to if (r.found) r.summaryText else null))
    }

    @GetMapping("/{documentId}/summary/translate", produces = [MediaType.APPLICATION_NDJSON_VALUE])
    fun translateBookSummary(
        @PathVariable documentId: UUID,
        @RequestParam lang: String,
        @AuthenticationPrincipal user: UserDetails
    ): ResponseEntity<StreamingResponseBody> {
        runBlocking { user.userId() }
        return documentExtrasGrpcClient
            .translateBookSummary(documentId.toString(), lang)
            .toNdjsonStream { """{"type":"${it.type}","content":"${it.content.escapeJson()}"}""" }
    }

    @PostMapping("/{documentId}/summary/generate", produces = [MediaType.APPLICATION_NDJSON_VALUE])
    fun generateBookSummary(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal user: UserDetails
    ): ResponseEntity<StreamingResponseBody> {
        val userId = runBlocking { user.userId() }
        return documentExtrasGrpcClient
            .generateBookSummary(documentId.toString(), userId.toString())
            .toNdjsonStream { """{"type":"${it.type}","message":"${it.message.escapeJson()}","progress":${it.progress},"summary_text":"${it.summaryText.escapeJson()}"}""" }
    }

    // ── Reading positions ────────────────────────────────────────────────────

    @GetMapping("/{documentId}/reading-position")
    fun getReadingPosition(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val r =
            documentExtrasGrpcClient.getReadingPosition(
                ReadingPositionRequest
                    .newBuilder()
                    .setDocumentId(documentId.toString())
                    .setUserId(user.userId().toString())
                    .build()
            )
        if (r.found) {
            ResponseEntity.ok(mapOf("document_id" to r.documentId, "page" to r.page, "position" to r.positionJson))
        } else {
            ResponseEntity.notFound().build<Map<String, Any?>>()
        }
    }

    @PostMapping("/{documentId}/reading-position")
    fun saveReadingPosition(
        @PathVariable documentId: UUID,
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val r =
            documentExtrasGrpcClient.setReadingPosition(
                SetReadingPositionRequest
                    .newBuilder()
                    .setDocumentId(documentId.toString())
                    .setUserId(user.userId().toString())
                    .setPage((body["page"] as? Number)?.toInt() ?: (body["pageNumber"] as? Number)?.toInt() ?: 0)
                    .setPositionJson(body["position"]?.toString() ?: body["positionJson"]?.toString() ?: "")
                    .build()
            )
        ResponseEntity.ok(mapOf("success" to r.success, "message" to r.message))
    }

    @PutMapping("/{documentId}/reading-position")
    fun updateReadingPosition(
        @PathVariable documentId: UUID,
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal user: UserDetails
    ) = saveReadingPosition(documentId, body, user)

    // ── Metadata Enrichment ──────────────────────────────────────────

    @PostMapping("/{documentId}/enrich")
    fun enrichDocumentMetadata(
        @PathVariable documentId: UUID,
        @RequestBody(required = false) body: Map<String, Any>?,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val userId = user.userId()
        val forceRefresh = body?.get("force_refresh") as? Boolean ?: false
        val r = documentExtrasGrpcClient.enrichDocumentMetadata(documentId.toString(), userId.toString(), forceRefresh)
        ResponseEntity.ok(
            mapOf(
                "success" to r.success,
                "enrichment_status" to r.enrichmentStatus,
                "metadata" to
                    if (r.success) {
                        mapOf(
                            "title" to r.resolvedTitle.ifEmpty { null },
                            "authors" to r.resolvedAuthorsList.ifEmpty { null },
                            "year" to if (r.resolvedYear > 0) r.resolvedYear else null,
                            "journal" to r.resolvedJournal.ifEmpty { null },
                            "doi" to r.resolvedDoi.ifEmpty { null }
                        )
                    } else {
                        null
                    },
                "message" to
                    when (r.enrichmentStatus) {
                        "no_identifiers" -> "No DOI, ISBN, or other identifiers found in this document."
                        "resolution_failed" -> "Identifiers found but metadata resolution failed."
                        "already_enriched" -> "Document already has metadata."
                        else -> null
                    }
            )
        )
    }

    @PostMapping("/{documentId}/lookup")
    fun lookupDocumentIdentifier(
        @PathVariable documentId: UUID,
        @RequestBody body: Map<String, String>,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val userId = user.userId()
        val identifierType = body["identifier_type"] ?: throw IllegalArgumentException("identifier_type is required")
        val identifierValue = body["identifier_value"] ?: throw IllegalArgumentException("identifier_value is required")
        val r = documentExtrasGrpcClient.lookupIdentifier(documentId.toString(), userId.toString(), identifierType, identifierValue)
        ResponseEntity.ok(
            mapOf(
                "success" to r.success,
                "message" to r.message,
                "metadata" to
                    if (r.hasMetadata()) {
                        mapOf(
                            "title" to r.metadata.resolvedTitle.ifEmpty { null },
                            "authors" to r.metadata.resolvedAuthorsList.ifEmpty { null },
                            "year" to if (r.metadata.resolvedYear > 0) r.metadata.resolvedYear else null,
                            "journal" to r.metadata.resolvedJournal.ifEmpty { null },
                            "doi" to r.metadata.resolvedDoi.ifEmpty { null }
                        )
                    } else {
                        null
                    }
            )
        )
    }

    @PatchMapping("/{documentId}/type")
    fun updateDocumentType(
        @PathVariable documentId: UUID,
        @RequestBody body: Map<String, String>,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val userId = user.userId()
        val documentType = body["document_type"] ?: throw IllegalArgumentException("document_type is required")
        val r = documentExtrasGrpcClient.updateDocumentType(documentId.toString(), userId.toString(), documentType)
        ResponseEntity.ok(mapOf("success" to r.success, "document_type" to r.documentType, "message" to r.message))
    }

    @PatchMapping("/{documentId}/priority")
    fun updateDocumentPriority(
        @PathVariable documentId: UUID,
        @RequestBody body: Map<String, Double>,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val priority = body["priority"] ?: throw IllegalArgumentException("priority is required")
        val r = documentExtrasGrpcClient.updateDocumentPriority(documentId.toString(), user.userId().toString(), priority)
        ResponseEntity.ok(mapOf("success" to r.success, "priority" to r.priority, "message" to r.message))
    }

    // ── Trash / Soft-Delete ──────────────────────────────────────────

    @PostMapping("/{documentId}/restore")
    fun restoreDocument(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val userId = user.userId()
        val r = documentExtrasGrpcClient.restoreDocument(documentId.toString(), userId.toString())
        ResponseEntity.ok(mapOf("success" to r.success, "message" to r.message))
    }

    @DeleteMapping("/trash")
    fun purgeTrash(
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val userId = user.userId()
        val r = documentExtrasGrpcClient.purgeTrash(userId.toString())
        ResponseEntity.ok(mapOf("success" to r.success, "message" to r.message))
    }

    // Find open-access PDF via Unpaywall
    @PostMapping("/{documentId}/find-pdf")
    fun findOpenAccessPdf(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val userId = user.userId()
        val r = documentExtrasGrpcClient.findOpenAccessPdf(documentId.toString(), userId.toString())
        ResponseEntity.ok(
            mapOf(
                "success" to r.success,
                "is_oa" to r.isOa,
                "pdf_url" to r.pdfUrl,
                "oa_status" to r.oaStatus,
                "message" to r.message
            )
        )
    }

    // Extract annotations from uploaded PDF
    @PostMapping("/{documentId}/extract-annotations")
    fun extractPdfAnnotations(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val userId = user.userId()
        val r = documentExtrasGrpcClient.extractPdfAnnotations(documentId.toString(), userId.toString())
        ResponseEntity.ok(
            mapOf(
                "success" to r.success,
                "annotations" to
                    r.annotationsList.map { a ->
                        mapOf(
                            "page_index" to a.pageIndex,
                            "annotation_type" to a.annotationType,
                            "selected_text" to a.selectedText,
                            "comment" to a.comment,
                            "color_index" to a.colorIndex,
                            "position_json" to a.positionJson,
                        )
                    },
                "page_count" to r.pageCount,
                "message" to r.message
            )
        )
    }

    // ── Batch operations ─────────────────────────────────────────────────────

    @PostMapping("/move")
    fun moveDocuments(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        val userId = user.userId()

        @Suppress("UNCHECKED_CAST")
        val documentIds = (body["document_ids"] as? List<String>) ?: throw IllegalArgumentException("document_ids is required")
        val targetCollectionId = body["target_collection_id"] as? String ?: throw IllegalArgumentException("target_collection_id is required")
        requireCollectionEdit(UUID.fromString(targetCollectionId), userId)
        val r = documentExtrasGrpcClient.moveDocuments(documentIds, targetCollectionId, userId.toString())
        ResponseEntity.ok(mapOf("success" to r.success, "moved_count" to r.movedCount, "failed_count" to r.failedCount, "message" to r.message))
    }

    @PostMapping("/batch-delete")
    fun batchDeleteDocuments(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal user: UserDetails
    ) = runBlocking {
        @Suppress("UNCHECKED_CAST")
        val documentIds = (body["document_ids"] as? List<String>) ?: throw IllegalArgumentException("document_ids is required")
        val r = documentExtrasGrpcClient.batchDeleteDocuments(documentIds, user.userId().toString())
        ResponseEntity.ok(mapOf("success" to r.success, "deleted_count" to r.deletedCount, "failed_count" to r.failedCount))
    }

    // ── Processing Status ─────────────────────────────────────────────────────

    @GetMapping("/processing_status/{jobId}")
    fun getProcessingStatus(
        @PathVariable jobId: String,
        @AuthenticationPrincipal user: UserDetails
    ): ResponseEntity<Map<String, Any?>> =
        runBlocking {
            val userId = user.userId()
            try {
                val response =
                    jobsGrpcClient.getJobStatus(
                        GetJobStatusRequest
                            .newBuilder()
                            .setJobId(jobId)
                            .setUserId(userId.toString())
                            .build()
                    )
                ResponseEntity.ok(response.toJobStatusMap())
            } catch (e: io.grpc.StatusException) {
                // Coroutine stubs throw the checked StatusException, NOT
                // StatusRuntimeException — catching only the latter let every
                // NOT_FOUND fall through to the generic handler below and be logged
                // as an ERROR + returned as 500. A polling client then hammered this
                // endpoint forever with stack-trace spam for jobs that had simply
                // completed and aged out of Python's in-memory store.
                handleJobStatusGrpcError(e.status, jobId)
            } catch (e: StatusRuntimeException) {
                handleJobStatusGrpcError(e.status, jobId)
            } catch (e: Exception) {
                logger.error(e) { "Error getting processing status for job $jobId" }
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to get processing status")
            }
        }

    /**
     * Map a job-status gRPC error to an HTTP response. A missing job during
     * polling is an expected, benign outcome (the job finished and aged out of
     * Python's job store) — return 404 quietly so the client stops polling,
     * never an ERROR log + 500.
     */
    private fun handleJobStatusGrpcError(
        status: Status,
        jobId: String
    ): Nothing =
        when (status.code) {
            Status.Code.NOT_FOUND -> throw ResponseStatusException(HttpStatus.NOT_FOUND, "Job not found")
            Status.Code.PERMISSION_DENIED -> throw ResponseStatusException(HttpStatus.FORBIDDEN, "No access to this job")
            else -> {
                logger.error { "gRPC error getting processing status for job $jobId: ${status.code} ${status.description}" }
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to get processing status")
            }
        }

    // ── Multi-Collection Membership ────────────────────────────────

    @GetMapping("/{documentId}/collections")
    fun getDocumentCollections(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Any> =
        runBlocking {
            val memberships = documentCollectionGrpcClient.getDocumentCollections(documentId.toString())
            ResponseEntity.ok(memberships.map { mapOf("collection_id" to it.collectionId, "added_at" to it.addedAt) })
        }

    @PostMapping("/{documentId}/collections")
    fun addDocumentToCollection(
        @PathVariable documentId: UUID,
        @RequestBody body: Map<String, String>,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Any> =
        runBlocking {
            val collectionId = body["collection_id"] ?: throw ResponseStatusException(HttpStatus.BAD_REQUEST, "collection_id required")
            documentCollectionGrpcClient.addDocumentToCollection(documentId.toString(), collectionId, userDetails.userId().toString())
            ResponseEntity.ok(mapOf("success" to true))
        }

    @DeleteMapping("/{documentId}/collections/{collectionId}")
    fun removeDocumentFromCollection(
        @PathVariable documentId: UUID,
        @PathVariable collectionId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Any> =
        runBlocking {
            documentCollectionGrpcClient.removeDocumentFromCollection(documentId.toString(), collectionId.toString(), userDetails.userId().toString())
            ResponseEntity.ok(mapOf("success" to true))
        }

    private fun handleDocumentProcessingGrpcError(
        e: StatusRuntimeException,
        documentId: UUID,
        operation: String
    ): Nothing =
        when (e.status.code) {
            Status.Code.NOT_FOUND -> throw ResponseStatusException(HttpStatus.NOT_FOUND, e.status.description ?: "Document not found")
            Status.Code.INVALID_ARGUMENT -> throw ResponseStatusException(HttpStatus.BAD_REQUEST, e.status.description ?: "Invalid request")
            else -> {
                logger.error(e) { "gRPC error $operation document $documentId" }
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, e.status.description ?: "$operation failed")
            }
        }
}

// ── Extensions ───────────────────────────────────────────────────────────────

private fun DocumentDetailResponse.toDocumentResponse() =
    DocumentResponse(
        id = UUID.fromString(id),
        fileName = filename,
        fileType = fileType.ifEmpty { null },
        fileSize = fileSize,
        filePath = filePath,
        collectionId = UUID.fromString(collectionId),
        userId = UUID.fromString(collectionId),
        processingStatus = processingStatus,
        processingProgress = processingProgress.toInt(),
        errorMessage = processingError.ifEmpty { null },
        fileMetadata = null,
        uploadedAt = createdAt,
        processedAt = if (processingStatus == "completed") updatedAt else null,
        createdAt = createdAt,
        updatedAt = updatedAt,
    )

private fun formatBytes(bytes: Long): String =
    when {
        bytes >= 1_073_741_824 -> "%.2f GB".format(bytes / 1_073_741_824.0)
        bytes >= 1_048_576 -> "%.2f MB".format(bytes / 1_048_576.0)
        bytes >= 1024 -> "%.2f KB".format(bytes / 1024.0)
        else -> "$bytes bytes"
    }
