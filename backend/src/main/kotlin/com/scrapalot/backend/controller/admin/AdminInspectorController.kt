package com.scrapalot.backend.controller.admin

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.grpc.AdminGrpcClient
import com.scrapalot.backend.grpc.InspectionGrpcClient
import com.scrapalot.backend.grpc.admin.BuildCommunitiesRequest
import com.scrapalot.backend.grpc.admin.ClassifyTypedRelationshipsRequest
import com.scrapalot.backend.grpc.admin.CleanupMissingFileDocsRequest
import com.scrapalot.backend.grpc.admin.DetectCollectionBridgeRequest
import com.scrapalot.backend.grpc.admin.EvaluateGraphUtilityRequest
import com.scrapalot.backend.grpc.admin.GetCommunityHierarchyRequest
import com.scrapalot.backend.grpc.admin.GetCommunityReportRequest
import com.scrapalot.backend.grpc.admin.GetEntityExtractionMetricsRequest
import com.scrapalot.backend.grpc.admin.GetHarnessComparisonRequest
import com.scrapalot.backend.grpc.admin.GraphAuditRequest
import com.scrapalot.backend.grpc.admin.GraphHealthCheckRequest
import com.scrapalot.backend.grpc.admin.MergeDuplicateEntitiesRequest
import com.scrapalot.backend.grpc.admin.PruneCooccurrenceEdgesRequest
import com.scrapalot.backend.grpc.admin.RecomputeCollectionFingerprintsRequest
import com.scrapalot.backend.grpc.admin.RecomputeCooccurrenceWeightsRequest
import com.scrapalot.backend.grpc.admin.RecomputeEntityIdfRequest
import com.scrapalot.backend.grpc.admin.RecomputePageRankRequest
import com.scrapalot.backend.grpc.admin.RunHarnessComparisonRequest
import com.scrapalot.backend.grpc.admin.SweepGraphOrphansRequest
import com.scrapalot.backend.grpc.admin.SweepOrphanEntitiesRequest
import com.scrapalot.backend.grpc.inspection.*
import com.scrapalot.backend.repository.SessionRepository
import io.grpc.Status
import io.grpc.StatusException
import io.grpc.StatusRuntimeException
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.reactor.asFlux
import kotlinx.coroutines.runBlocking
import mu.KotlinLogging
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.http.codec.ServerSentEvent
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import org.springframework.web.server.ResponseStatusException
import reactor.core.publisher.Flux

private val logger = KotlinLogging.logger {}

/**
 * Checks if a gRPC exception is a transient connectivity issue (e.g., during container restart).
 * Logs as WARN instead of ERROR for transient failures to reduce log noise.
 */
private fun isTransientGrpcError(e: Exception): Boolean {
    val cause = generateSequence<Throwable>(e) { it.cause }
    return cause.any { it is StatusException && it.status.code == Status.Code.UNAVAILABLE } ||
        cause.any { it is StatusRuntimeException && it.status.code == Status.Code.UNAVAILABLE }
}

/**
 * Data Inspector API for document evaluation, graph analysis,
 * RAG trace monitoring, and LLM-based quality evaluation.
 *
 * Available to all authenticated users.
 */
@RestController
@RequestMapping("/api/v1/admin/inspector")
class AdminInspectorController(
    private val inspectionGrpcClient: InspectionGrpcClient,
    private val adminGrpcClient: AdminGrpcClient,
    private val objectMapper: ObjectMapper,
    private val sessionRepository: SessionRepository,
) {
    private fun userIdOf(userDetails: UserDetails): String = userDetails.username

    // =========================================================================
    // Document Evaluation
    // =========================================================================

    @GetMapping("/document/{documentId}/evaluation")
    fun getDocumentEvaluation(
        @PathVariable documentId: String,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val request =
                DocEvalRequest
                    .newBuilder()
                    .setDocumentId(documentId)
                    .build()

            val response =
                runBlocking {
                    inspectionGrpcClient.getDocumentEvaluation(request)
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "document_id" to response.documentId,
                    "document_title" to response.documentTitle,
                    "collection_id" to response.collectionId,
                    "parse_quality" to
                        mapOf(
                            "heading_count" to response.parseQuality.headingCount,
                            "list_count" to response.parseQuality.listCount,
                            "table_count" to response.parseQuality.tableCount,
                            "code_block_count" to response.parseQuality.codeBlockCount,
                            "image_ref_count" to response.parseQuality.imageRefCount,
                            "total_chunks" to response.parseQuality.totalChunks,
                            "structure_score" to response.parseQuality.structureScore,
                        ),
                    "chunk_quality" to
                        mapOf(
                            "total_chunks" to response.chunkQuality.totalChunks,
                            "size_distribution" to
                                mapOf(
                                    "mean" to response.chunkQuality.sizeDistribution.mean,
                                    "std" to response.chunkQuality.sizeDistribution.std,
                                    "min" to response.chunkQuality.sizeDistribution.min,
                                    "max" to response.chunkQuality.sizeDistribution.max,
                                    "median" to response.chunkQuality.sizeDistribution.median,
                                ),
                            "metadata_completeness" to response.chunkQuality.metadataCompleteness,
                            "micro_chunk_ratio" to response.chunkQuality.microChunkRatio,
                            "empty_chunk_count" to response.chunkQuality.emptyChunkCount,
                        ),
                    "embedding_coverage" to
                        mapOf(
                            "total_embeddings" to response.embeddingCoverage.totalEmbeddings,
                            "zero_embedding_docs" to response.embeddingCoverage.zeroEmbeddingDocs,
                            "embedding_density" to response.embeddingCoverage.embeddingDensity,
                            "pages_without_embeddings" to response.embeddingCoverage.pagesWithoutEmbeddings,
                        ),
                    "graph_integrity" to
                        mapOf(
                            "hierarchy_completeness" to response.graphIntegrity.hierarchyCompleteness,
                            "orphan_count" to response.graphIntegrity.orphanCount,
                            "entity_coverage" to response.graphIntegrity.entityCoverage,
                            "relationship_density" to response.graphIntegrity.relationshipDensity,
                            "total_nodes" to response.graphIntegrity.totalNodes,
                            "total_relationships" to response.graphIntegrity.totalRelationships,
                        ),
                    "overall_score" to response.overallScore,
                    "evaluated_at" to response.evaluatedAt,
                    "processing_stats" to response.processingStatsJson.takeIf { it.isNotBlank() }?.let { parseJson(it) },
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get document evaluation for $documentId")
        }

    // =========================================================================
    // Collection Evaluation
    // =========================================================================

    @GetMapping("/collection/{collectionId}/evaluation")
    fun getCollectionEvaluation(
        @PathVariable collectionId: String,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val request =
                CollectionEvalRequest
                    .newBuilder()
                    .setCollectionId(collectionId)
                    .build()

            val response =
                runBlocking {
                    inspectionGrpcClient.getCollectionEvaluation(request)
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "collection_id" to response.collectionId,
                    "document_count" to response.documentCount,
                    "avg_parse_quality" to response.avgParseQuality,
                    "avg_chunk_quality" to response.avgChunkQuality,
                    "avg_embedding_coverage" to response.avgEmbeddingCoverage,
                    "avg_graph_integrity" to response.avgGraphIntegrity,
                    "overall_score" to response.overallScore,
                    "failed_documents" to response.failedDocumentsList,
                    "cross_document_entities" to
                        mapOf(
                            "shared_entity_count" to response.crossDocumentEntities.sharedEntityCount,
                            "entities_by_type" to response.crossDocumentEntities.entitiesByTypeMap,
                            "cross_doc_relationship_count" to response.crossDocumentEntities.crossDocRelationshipCount,
                            "top_shared_entities" to parseJson(response.crossDocumentEntities.topSharedEntitiesJson),
                        ),
                    "evaluated_at" to response.evaluatedAt,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get collection evaluation for $collectionId")
        }

    // =========================================================================
    // Chunk Inspection
    // =========================================================================

    @GetMapping("/document/{documentId}/chunks")
    fun getChunkInspection(
        @PathVariable documentId: String,
        @RequestParam(defaultValue = "1") page: Int,
        @RequestParam(defaultValue = "20") pageSize: Int,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val request =
                ChunkInspectionRequest
                    .newBuilder()
                    .setDocumentId(documentId)
                    .setPage(page)
                    .setPageSize(pageSize)
                    .build()

            val response =
                runBlocking {
                    inspectionGrpcClient.getChunkInspection(request)
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "document_id" to response.documentId,
                    "total_chunks" to response.totalChunks,
                    "page" to response.page,
                    "page_size" to response.pageSize,
                    "chunks" to
                        response.chunksList.map { chunk ->
                            mapOf(
                                "chunk_index" to chunk.chunkIndex,
                                "text" to chunk.text,
                                "size" to chunk.size,
                                "metadata" to parseJson(chunk.metadataJson),
                                "embedding_id" to chunk.embeddingId,
                                "has_embedding" to chunk.hasEmbedding,
                                "section_heading" to chunk.sectionHeading,
                                "chapter_title" to chunk.chapterTitle,
                                "page_number" to chunk.pageNumber,
                            )
                        },
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get chunk inspection for $documentId")
        }

    // =========================================================================
    // Graph Explorer
    // =========================================================================

    @GetMapping("/graph/subgraph")
    fun getGraphSubgraph(
        @RequestParam(required = false) workspaceId: String?,
        @RequestParam(required = false) collectionId: String?,
        @RequestParam(required = false) documentId: String?,
        @RequestParam(defaultValue = "2") depth: Int,
        @RequestParam(defaultValue = "500") maxNodes: Int,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val requestBuilder =
                SubgraphRequest
                    .newBuilder()
                    .setDepth(depth)
                    .setMaxNodes(maxNodes)

            workspaceId?.let { requestBuilder.setWorkspaceId(it) }
            collectionId?.let { requestBuilder.setCollectionId(it) }
            documentId?.let { requestBuilder.setDocumentId(it) }

            val response =
                runBlocking {
                    inspectionGrpcClient.getGraphSubgraph(requestBuilder.build())
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "nodes" to parseJson(response.nodesJson),
                    "edges" to parseJson(response.edgesJson),
                    "total_nodes" to response.totalNodes,
                    "total_edges" to response.totalEdges,
                    "truncated" to response.truncated,
                    // Cache markers — UI renders a "Refreshing…" badge when
                    // stale=true so the user knows the snapshot is a
                    // slightly-out-of-date Redis hit while a background
                    // refresh runs.
                    "cached_at" to response.cachedAt.ifBlank { null },
                    "stale" to response.stale,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get graph subgraph")
        }

    @PostMapping("/graph/node-neighbors")
    fun getNodeNeighbors(
        @RequestBody body: Map<String, Any>,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val nodeElementId =
                body["nodeElementId"] as? String
                    ?: throw ResponseStatusException(HttpStatus.BAD_REQUEST, "nodeElementId is required")

            @Suppress("UNCHECKED_CAST")
            val excludeNodeIds = body["excludeNodeIds"] as? List<String>
            val maxNeighbors = (body["maxNeighbors"] as? Number)?.toInt() ?: 50

            val requestBuilder =
                NodeNeighborsRequest
                    .newBuilder()
                    .setNodeElementId(nodeElementId)
                    .setMaxNeighbors(maxNeighbors)

            excludeNodeIds?.let { requestBuilder.addAllExcludeNodeIds(it) }

            val response =
                runBlocking {
                    inspectionGrpcClient.getNodeNeighbors(requestBuilder.build())
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "nodes" to
                        response.nodesList.map { node ->
                            mapOf(
                                "neo_id" to node.neoId,
                                "labels" to node.labelsList,
                                "properties" to parseJson(node.propertiesJson),
                                "neighbor_count" to node.neighborCount,
                            )
                        },
                    "edges" to
                        response.edgesList.map { edge ->
                            mapOf(
                                "rel_id" to edge.relId,
                                "rel_type" to edge.relType,
                                "source" to edge.source,
                                "target" to edge.target,
                                "properties" to parseJson(edge.propertiesJson),
                            )
                        },
                    "total_neighbor_count" to response.totalNeighborCount,
                    "returned_count" to response.returnedCount,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get node neighbors")
        }

    @GetMapping("/graph/stats")
    fun getGraphStats(): ResponseEntity<Map<String, Any?>> =
        try {
            val response =
                runBlocking {
                    inspectionGrpcClient.getGraphStats(GraphStatsRequest.getDefaultInstance())
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "total_nodes" to response.totalNodes,
                    "total_edges" to response.totalEdges,
                    "node_counts_by_type" to response.nodeCountsByTypeMap,
                    "edge_counts_by_type" to response.edgeCountsByTypeMap,
                    "avg_degree" to response.avgDegree,
                    "cached_at" to response.cachedAt.ifBlank { null },
                    "stale" to response.stale,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get graph stats")
        }

    // Edge Provenance for the graph explorer's edge inspector.
    // Returns type, weight stats, typed-relationship metadata, and source
    // chunks (cap 20) for a single edge identified by Neo4j elementId.
    @GetMapping("/graph/edge-provenance")
    fun getEdgeProvenance(
        @RequestParam(name = "rel_element_id") relElementId: String,
    ): ResponseEntity<Map<String, Any?>> {
        if (relElementId.isBlank()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "rel_element_id is required")
        }
        return try {
            val request =
                EdgeProvenanceRequest
                    .newBuilder()
                    .setRelElementId(relElementId)
                    .build()

            val response = runBlocking { inspectionGrpcClient.getEdgeProvenance(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            val sourceChunks =
                response.sourceChunksList.map { sc ->
                    mapOf(
                        "chunk_id" to sc.chunkId,
                        "document_id" to sc.documentId,
                        "document_title" to sc.documentTitle,
                        "text_preview" to sc.textPreview,
                        "chunk_index" to sc.chunkIndex,
                    )
                }

            val properties: Map<String, Any?> =
                if (response.propertiesJson.isNotBlank()) {
                    @Suppress("UNCHECKED_CAST")
                    objectMapper.readValue(response.propertiesJson, Map::class.java) as Map<String, Any?>
                } else {
                    emptyMap()
                }

            ResponseEntity.ok(
                mapOf(
                    "rel_type" to response.relType,
                    "source_node_id" to response.sourceNodeId,
                    "target_node_id" to response.targetNodeId,
                    "source_node_name" to response.sourceNodeName,
                    "target_node_name" to response.targetNodeName,
                    "chunk_cooccurrence_count" to response.chunkCooccurrenceCount,
                    "document_cooccurrence_count" to response.documentCooccurrenceCount,
                    "document_weighted_score" to response.documentWeightedScore,
                    "confidence" to response.confidence,
                    "classifier_rationale" to response.classifierRationale,
                    "source_chunks" to sourceChunks,
                    "properties" to properties,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get edge provenance")
        }
    }

    @GetMapping("/graph/knowledge-gaps")
    fun getKnowledgeGaps(): ResponseEntity<Map<String, Any?>> =
        try {
            val response =
                runBlocking {
                    inspectionGrpcClient.getKnowledgeGaps(KnowledgeGapsRequest.getDefaultInstance())
                }
            if (response.error.isNotEmpty()) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }
            ResponseEntity.ok(
                mapOf(
                    "orphan_entities" to response.orphanEntitiesList.map { mapOf("name" to it.name, "type" to it.type) },
                    "dead_end_entities" to response.deadEndEntitiesList.map { mapOf("name" to it.name, "type" to it.type, "connections" to it.connections) },
                    "isolated_books" to response.isolatedBooksList.map { mapOf("title" to it.title, "id" to it.id) },
                    "low_density_sections" to response.lowDensitySectionsList.map { mapOf("title" to it.title, "chunks" to it.chunks) },
                    "cross_doc_lonely_entities" to response.crossDocLonelyEntitiesList.map { mapOf("name" to it.name, "type" to it.type, "doc_count" to it.docCount) },
                    "summary" to
                        if (response.hasSummary()) {
                            mapOf(
                                "orphan_entities" to response.summary.orphanEntities,
                                "dead_end_entities" to response.summary.deadEndEntities,
                                "isolated_books" to response.summary.isolatedBooks,
                                "low_density_sections" to response.summary.lowDensitySections,
                                "cross_doc_lonely_entities" to response.summary.crossDocLonelyEntities,
                                "total_issues" to response.summary.totalIssues,
                            )
                        } else {
                            null
                        },
                    "cached_at" to response.cachedAt.ifBlank { null },
                    "stale" to response.stale,
                )
            )
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get knowledge gaps")
        }

    @GetMapping("/graph/entities")
    fun getEntityRelationships(
        @RequestParam(required = false) query: String?,
        @RequestParam(required = false) type: String?,
        @RequestParam(defaultValue = "50") limit: Int,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val requestBuilder =
                EntityRelRequest
                    .newBuilder()
                    .setLimit(limit)

            query?.let { requestBuilder.setQuery(it) }
            type?.let { requestBuilder.setEntityType(it) }

            val response =
                runBlocking {
                    inspectionGrpcClient.getEntityRelationships(requestBuilder.build())
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "entities" to parseJson(response.entitiesJson),
                    "relationships" to parseJson(response.relationshipsJson),
                    "total_entities" to response.totalEntities,
                    "total_relationships" to response.totalRelationships,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get entity relationships")
        }

    // =========================================================================
    // RAG Traces
    // =========================================================================

    @GetMapping("/rag/traces")
    fun getRAGTraces(
        @RequestParam(defaultValue = "50") limit: Int,
        @RequestParam(defaultValue = "1") page: Int,
        @RequestParam(required = false) strategy: String?,
        @RequestParam(required = false) mode: String?,
        @RequestParam(required = false) from: String?,
        @RequestParam(required = false) to: String?,
        @RequestParam(required = false) userId: String?,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val requestBuilder =
                RAGTracesRequest
                    .newBuilder()
                    .setLimit(limit)
                    .setPage(page)

            strategy?.let { requestBuilder.setStrategyFilter(it) }
            mode?.let { requestBuilder.setModeFilter(it) }
            from?.let { requestBuilder.setFromDate(it) }
            to?.let { requestBuilder.setToDate(it) }
            userId?.let { requestBuilder.setUserId(it) }

            val response =
                runBlocking {
                    inspectionGrpcClient.getRAGTraces(requestBuilder.build())
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "traces" to
                        response.tracesList.map { trace ->
                            mapOf(
                                "id" to trace.id,
                                "session_id" to trace.sessionId,
                                "user_id" to trace.userId,
                                "query" to trace.query,
                                "selected_strategy" to trace.selectedStrategy,
                                "selected_orchestrator" to trace.selectedOrchestrator,
                                "strategy_type" to trace.strategyType,
                                "mode" to trace.mode,
                                "confidence" to trace.confidence,
                                "reasoning" to trace.reasoning,
                                "alternative_strategies" to parseJson(trace.alternativeStrategiesJson),
                                "query_characteristics" to parseJson(trace.queryCharacteristicsJson),
                                "latency_ms" to trace.latencyMs,
                                "token_count" to trace.tokenCount,
                                "created_at" to trace.createdAt,
                                "graph_traversal_stats" to trace.graphTraversalStatsJson.takeIf { it.isNotBlank() }?.let { parseJson(it) },
                            )
                        },
                    "total" to response.total,
                    "page" to response.page,
                    "page_size" to response.pageSize,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get RAG traces")
        }

    @GetMapping("/rag/distribution")
    fun getStrategyDistribution(
        @RequestParam(required = false) from: String?,
        @RequestParam(required = false) to: String?,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val requestBuilder = StrategyDistRequest.newBuilder()

            from?.let { requestBuilder.setFromDate(it) }
            to?.let { requestBuilder.setToDate(it) }

            val response =
                runBlocking {
                    inspectionGrpcClient.getStrategyDistribution(requestBuilder.build())
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "distributions" to
                        response.distributionsList.map { dist ->
                            mapOf(
                                "strategy_name" to dist.strategyName,
                                "count" to dist.count,
                                "avg_latency_ms" to dist.avgLatencyMs,
                                "avg_tokens" to dist.avgTokens,
                                "avg_confidence" to dist.avgConfidence,
                            )
                        },
                    "total_traces" to response.totalTraces,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get strategy distribution")
        }

    // =========================================================================
    // LLM Traces (full execution data)
    // =========================================================================

    @GetMapping("/llm/traces")
    fun getLLMTraces(
        @RequestParam(defaultValue = "20") limit: Int,
        @RequestParam(defaultValue = "1") page: Int,
        @RequestParam(required = false) chatMode: String?,
        @RequestParam(required = false) provider: String?,
        @RequestParam(required = false) model: String?,
        @RequestParam(required = false) from: String?,
        @RequestParam(required = false) to: String?,
        @RequestParam(required = false) userId: String?,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val requestBuilder =
                LLMTracesRequest
                    .newBuilder()
                    .setLimit(limit)
                    .setPage(page)

            chatMode?.let { requestBuilder.setChatModeFilter(it) }
            provider?.let { requestBuilder.setProviderFilter(it) }
            model?.let { requestBuilder.setModelFilter(it) }
            from?.let { requestBuilder.setFromDate(it) }
            to?.let { requestBuilder.setToDate(it) }
            userId?.let { requestBuilder.setUserId(it) }

            val response =
                runBlocking {
                    inspectionGrpcClient.getLLMTraces(requestBuilder.build())
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "traces" to
                        response.tracesList.map { trace ->
                            mapOf(
                                "id" to trace.id,
                                "session_id" to trace.sessionId,
                                "user_id" to trace.userId,
                                "workspace_id" to trace.workspaceId.takeIf { it.isNotBlank() },
                                "assistant_message_id" to trace.assistantMessageId.takeIf { it.isNotBlank() },
                                "query" to trace.query,
                                "chat_mode" to trace.chatMode,
                                "collection_ids" to parseJson(trace.collectionIdsJson),
                                "document_ids" to parseJson(trace.documentIdsJson),
                                "top_k" to trace.topK,
                                "similarity_threshold" to trace.similarityThreshold,
                                "strategy_name" to trace.strategyName.takeIf { it.isNotBlank() },
                                "strategy_type" to trace.strategyType.takeIf { it.isNotBlank() },
                                "agentic_routing" to trace.agenticRouting,
                                "retrieved_chunks" to parseJson(trace.retrievedChunksJson),
                                "retrieved_chunk_count" to trace.retrievedChunkCount,
                                "system_prompt_length" to trace.systemPromptLength,
                                "context_token_estimate" to trace.contextTokenEstimate,
                                "history_message_count" to trace.historyMessageCount,
                                "has_conversation_summary" to trace.hasConversationSummary,
                                "provider" to trace.provider.takeIf { it.isNotBlank() },
                                "model" to trace.model.takeIf { it.isNotBlank() },
                                "input_tokens" to trace.inputTokens,
                                "output_tokens" to trace.outputTokens,
                                "total_tokens" to trace.totalTokens,
                                "cost_usd" to trace.costUsd,
                                "latency_ms" to trace.latencyMs,
                                "duration_ms" to trace.durationMs,
                                "response_preview" to trace.responsePreview.takeIf { it.isNotBlank() },
                                "source_analysis" to trace.sourceAnalysisJson.takeIf { it.isNotBlank() }?.let { parseJson(it) },
                                "created_at" to trace.createdAt,
                            )
                        },
                    "total" to response.total,
                    "page" to response.page,
                    "page_size" to response.pageSize,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get LLM traces")
        }

    @GetMapping("/llm/summary")
    fun getLLMTraceSummary(
        @RequestParam(required = false) from: String?,
        @RequestParam(required = false) to: String?,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val requestBuilder = LLMTraceSummaryRequest.newBuilder()

            from?.let { requestBuilder.setFromDate(it) }
            to?.let { requestBuilder.setToDate(it) }

            val response =
                runBlocking {
                    inspectionGrpcClient.getLLMTraceSummary(requestBuilder.build())
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "total_traces" to response.totalTraces,
                    "total_cost_usd" to response.totalCostUsd,
                    "total_tokens" to response.totalTokens,
                    "avg_latency_ms" to response.avgLatencyMs,
                    "provider_distribution" to parseJson(response.providerDistributionJson),
                    "chat_mode_distribution" to parseJson(response.chatModeDistributionJson),
                    "model_distribution" to parseJson(response.modelDistributionJson),
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get LLM trace summary")
        }

    @GetMapping("/llm/agent-costs")
    fun getAgentCostAnalysis(
        @RequestParam(required = false) from: String?,
        @RequestParam(required = false) to: String?,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val requestBuilder = AgentCostAnalysisRequest.newBuilder()
            from?.let { requestBuilder.setFromDate(it) }
            to?.let { requestBuilder.setToDate(it) }

            val response =
                runBlocking {
                    inspectionGrpcClient.getAgentCostAnalysis(requestBuilder.build())
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "total_cost_usd" to response.totalCostUsd,
                    "total_tokens" to response.totalTokens,
                    "total_calls" to response.totalCalls,
                    "user_cost_usd" to response.userCostUsd,
                    "system_cost_usd" to response.systemCostUsd,
                    "agent_breakdown" to
                        response.agentBreakdownList.map { agent ->
                            mapOf(
                                "agent_type" to agent.agentType,
                                "call_count" to agent.callCount,
                                "total_cost_usd" to agent.totalCostUsd,
                                "total_input_tokens" to agent.totalInputTokens,
                                "total_output_tokens" to agent.totalOutputTokens,
                                "total_tokens" to agent.totalTokens,
                                "avg_latency_ms" to agent.avgLatencyMs,
                                "model" to agent.model,
                            )
                        },
                    "daily_costs" to
                        response.dailyCostsList.map { daily ->
                            mapOf(
                                "date" to daily.date,
                                "cost_usd" to daily.costUsd,
                                "tokens" to daily.tokens,
                                "calls" to daily.calls,
                            )
                        },
                    "model_costs" to response.modelCostsMap,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get agent cost analysis")
        }

    // =========================================================================
    // LLM Evaluation (SSE Stream)
    // =========================================================================

    @PostMapping("/rag/evaluate", produces = [MediaType.TEXT_EVENT_STREAM_VALUE])
    fun runLLMEvaluation(
        @RequestParam(defaultValue = "10") sampleSize: Int,
    ): Flux<ServerSentEvent<String>> {
        val request =
            LLMEvalRequest
                .newBuilder()
                .setSampleSize(sampleSize)
                .build()

        return inspectionGrpcClient
            .runLLMEvaluation(request)
            .map { progress ->
                val data =
                    mapOf(
                        "completed" to progress.completed,
                        "total" to progress.total,
                        "progress" to progress.progress,
                        "status" to progress.status,
                        "avg_faithfulness" to progress.avgFaithfulness,
                        "avg_context_relevance" to progress.avgContextRelevance,
                        "avg_completeness" to progress.avgCompleteness,
                        "current_result" to
                            if (progress.hasCurrentResult()) {
                                mapOf(
                                    "trace_id" to progress.currentResult.traceId,
                                    "faithfulness_score" to progress.currentResult.faithfulnessScore,
                                    "context_relevance_score" to progress.currentResult.contextRelevanceScore,
                                    "completeness_score" to progress.currentResult.completenessScore,
                                    "overall_score" to progress.currentResult.overallScore,
                                    "reasoning" to progress.currentResult.reasoning,
                                )
                            } else {
                                null
                            },
                    )
                ServerSentEvent
                    .builder<String>()
                    .data(objectMapper.writeValueAsString(data))
                    .build()
            }.asFlux()
    }

    // =========================================================================
    // Utilities
    // =========================================================================

    private fun parseJson(json: String): Any? =
        try {
            if (json.isBlank()) {
                null
            } else {
                objectMapper.readValue(json, Any::class.java)
            }
        } catch (_: Exception) {
            json
        }

    @Suppress("UNCHECKED_CAST")
    private fun parseJsonMap(json: String): Map<String, Any?> =
        if (json.isNotBlank()) {
            objectMapper.readValue(json, Map::class.java) as Map<String, Any?>
        } else {
            emptyMap()
        }

    // ──────────────────────────────────────────────
    // Cross-Book Entity Relationships
    // ──────────────────────────────────────────────

    @GetMapping("/graph/related-books")
    fun getRelatedBooks(
        @RequestParam(required = false) bookId: String?,
        @RequestParam(required = false) documentId: String?,
        @RequestParam(defaultValue = "20") limit: Int,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val requestBuilder =
                RelatedBooksRequest
                    .newBuilder()
                    .setLimit(limit)

            bookId?.let { requestBuilder.setBookId(it) }
            documentId?.let { requestBuilder.setDocumentId(it) }

            val response =
                runBlocking {
                    inspectionGrpcClient.getRelatedBooks(requestBuilder.build())
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "related_books" to
                        response.relatedBooksList.map { book ->
                            mapOf(
                                "book_id" to book.bookId,
                                "document_id" to book.documentId,
                                "title" to book.title,
                                "filename" to book.filename,
                                "shared_entity_count" to book.sharedEntityCount,
                                "entity_types" to book.entityTypesList,
                                "shared_entities" to
                                    book.sharedEntitiesList.map { entity ->
                                        mapOf(
                                            "name" to entity.name,
                                            "entity_type" to entity.entityType,
                                            "confidence" to entity.confidence,
                                        )
                                    },
                            )
                        },
                    "total_count" to response.totalCount,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get related books")
        }

    @GetMapping("/graph/cross-book")
    fun getCrossBookGraph(
        @RequestParam(required = false) collectionId: String?,
        @RequestParam(defaultValue = "50") limit: Int,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val requestBuilder =
                CrossBookGraphRequest
                    .newBuilder()
                    .setLimit(limit)

            collectionId?.let { requestBuilder.setCollectionId(it) }

            val response =
                runBlocking {
                    inspectionGrpcClient.getCrossBookGraph(requestBuilder.build())
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "nodes" to
                        response.nodesList.map { node ->
                            mapOf(
                                "id" to node.id,
                                "label" to node.title,
                                "document_id" to node.documentId,
                                "filename" to node.filename,
                                "collection_id" to node.collectionId,
                                "entity_count" to node.entityCount,
                                "chapter_count" to node.chapterCount,
                            )
                        },
                    "edges" to
                        response.edgesList.map { edge ->
                            mapOf(
                                "source" to edge.source,
                                "target" to edge.target,
                                "shared_entity_count" to edge.sharedEntityCount,
                                "entity_types" to edge.entityTypesList,
                                "top_entities" to edge.topEntitiesList,
                            )
                        },
                    "total_books" to response.nodesList.size,
                    "total_relationships" to response.edgesList.size,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get cross-book graph")
        }

    // =========================================================================
    // Graph Sync Status (Entity Extraction Progress)
    // =========================================================================

    @GetMapping("/graph/sync-status")
    fun getGraphSyncStatus(
        @RequestParam(required = false) collectionId: String?,
        @RequestParam(required = false) status: String?,
        @RequestParam(defaultValue = "50") limit: Int,
        @RequestParam(defaultValue = "1") page: Int,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val requestBuilder =
                GraphSyncStatusRequest
                    .newBuilder()
                    .setLimit(limit)
                    .setPage(page)

            collectionId?.let { requestBuilder.setCollectionId(it) }
            status?.let { requestBuilder.setStatusFilter(it) }

            val response =
                runBlocking {
                    inspectionGrpcClient.getGraphSyncStatus(requestBuilder.build())
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "items" to
                        response.itemsList.map { item ->
                            mapOf(
                                "document_id" to item.documentId,
                                "collection_id" to item.collectionId,
                                "status" to item.status,
                                "chunks_expected" to item.chunksExpected,
                                "chunks_created" to item.chunksCreated,
                                "entities_extracted" to item.entitiesExtracted,
                                "error_message" to item.errorMessage.takeIf { it.isNotBlank() },
                                "started_at" to item.startedAt.takeIf { it.isNotBlank() },
                                "completed_at" to item.completedAt.takeIf { it.isNotBlank() },
                                "updated_at" to item.updatedAt.takeIf { it.isNotBlank() },
                                "document_title" to item.documentTitle.takeIf { it.isNotBlank() },
                            )
                        },
                    "summary" to
                        mapOf(
                            "total_documents" to response.summary.totalDocuments,
                            "pending_count" to response.summary.pendingCount,
                            "hierarchy_done_count" to response.summary.hierarchyDoneCount,
                            "entity_running_count" to response.summary.entityRunningCount,
                            "completed_count" to response.summary.completedCount,
                            "failed_count" to response.summary.failedCount,
                            "total_entities_extracted" to response.summary.totalEntitiesExtracted,
                            "total_chunks" to response.summary.totalChunks,
                            "avg_entities_per_doc" to response.summary.avgEntitiesPerDoc,
                            "latest_completed_at" to response.summary.latestCompletedAt.takeIf { it.isNotBlank() },
                        ),
                    "total" to response.total,
                    "page" to response.page,
                    "page_size" to response.pageSize,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get graph sync status")
        }

    @GetMapping("/graph/quality-audit")
    fun getGraphQualityAudit(
        @RequestParam(required = false) collectionId: String?,
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val request =
                GraphQualityAuditRequest
                    .newBuilder()
                    .apply {
                        collectionId?.let { setCollectionId(it) }
                    }.build()

            val response =
                runBlocking {
                    inspectionGrpcClient.getGraphQualityAudit(request)
                }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            val coverage = response.coverage
            val hierarchy = response.hierarchy
            val entityHealth = response.entityHealth
            val relHealth = response.relationshipHealth
            val chunkAlign = response.chunkAlignment

            ResponseEntity.ok(
                mapOf(
                    "overall_score" to response.overallScore,
                    "coverage" to
                        mapOf(
                            "pg_documents" to coverage.pgDocuments,
                            "neo4j_books" to coverage.neo4JBooks,
                            "missing_in_graph" to coverage.missingInGraph,
                            "coverage_pct" to coverage.coveragePct,
                            "sync_completed" to coverage.syncCompleted,
                            "sync_running" to coverage.syncRunning,
                            "sync_failed" to coverage.syncFailed,
                            "sync_pending" to coverage.syncPending,
                        ),
                    "hierarchy" to
                        mapOf(
                            "total_books" to hierarchy.totalBooks,
                            "total_chapters" to hierarchy.totalChapters,
                            "total_sections" to hierarchy.totalSections,
                            "total_chunks" to hierarchy.totalChunks,
                            "orphan_chunks" to hierarchy.orphanChunks,
                            "orphan_sections" to hierarchy.orphanSections,
                            "orphan_chapters" to hierarchy.orphanChapters,
                            "books_without_chapters" to hierarchy.booksWithoutChapters,
                            "integrity_score" to hierarchy.integrityScore,
                        ),
                    "entity_health" to
                        mapOf(
                            "total_entities" to entityHealth.totalEntities,
                            "entities_with_mentions" to entityHealth.entitiesWithMentions,
                            "orphaned_entities" to entityHealth.orphanedEntities,
                            "health_pct" to entityHealth.healthPct,
                            "by_type" to
                                entityHealth.byTypeList.map { bt ->
                                    mapOf(
                                        "entity_type" to bt.entityType,
                                        "total" to bt.total,
                                        "with_mentions" to bt.withMentions,
                                        "orphaned" to bt.orphaned,
                                    )
                                },
                        ),
                    "relationship_health" to
                        mapOf(
                            "total_co_occurs" to relHealth.totalCoOccurs,
                            "valid_co_occurs" to relHealth.validCoOccurs,
                            "stale_co_occurs" to relHealth.staleCoOccurs,
                            "co_occurs_health_pct" to relHealth.coOccursHealthPct,
                            "total_shared_entity" to relHealth.totalSharedEntity,
                            "total_mentions" to relHealth.totalMentions,
                            "total_contains" to relHealth.totalContains,
                        ),
                    "chunk_alignment" to
                        mapOf(
                            "neo4j_chunks" to chunkAlign.neo4JChunks,
                            "pg_embeddings" to chunkAlign.pgEmbeddings,
                            "matched" to chunkAlign.matched,
                            "neo4j_only" to chunkAlign.neo4JOnly,
                            "pg_only" to chunkAlign.pgOnly,
                            "alignment_pct" to chunkAlign.alignmentPct,
                        ),
                    "collections" to
                        response.collectionsList.map { ci ->
                            mapOf(
                                "collection_id" to ci.collectionId,
                                "collection_name" to ci.collectionName,
                                "pg_documents" to ci.pgDocuments,
                                "neo4j_books" to ci.neo4JBooks,
                                "coverage_pct" to ci.coveragePct,
                                "total_entities" to ci.totalEntities,
                                "total_chunks" to ci.totalChunks,
                            )
                        },
                    "cross_book_health" to
                        response.crossBookHealth.let { cb ->
                            mapOf(
                                "total_shared_links" to cb.totalSharedLinks,
                                "cross_collection_links" to cb.crossCollectionLinks,
                                "within_collection_links" to cb.withinCollectionLinks,
                                "connected_books" to cb.connectedBooks,
                                "disconnected_books" to cb.disconnectedBooks,
                                "avg_shared_per_pair" to cb.avgSharedPerPair,
                                "connectivity_pct" to cb.connectivityPct,
                            )
                        },
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to get graph quality audit")
        }

    private fun handleGrpcError(
        e: Exception,
        message: String
    ): Nothing {
        if (isTransientGrpcError(e)) {
            logger.warn { "$message: Python AI backend temporarily unavailable (container restarting?)" }
            throw ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "$message: AI backend temporarily unavailable")
        }
        logger.error(e) { message }
        throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, message)
    }

    // =========================================================================
    // Trace Cleanup
    // =========================================================================

    @PostMapping("/traces/cleanup-orphaned")
    fun cleanupOrphanedTraces(): ResponseEntity<Map<String, Any?>> =
        try {
            val validSessionIds = sessionRepository.findAll().map { it.id.toString() }
            logger.info { "Cleanup orphaned traces: ${validSessionIds.size} valid sessions in DB" }

            val request =
                CleanupOrphanedTracesRequest
                    .newBuilder()
                    .addAllValidSessionIds(validSessionIds)
                    .build()

            val response = runBlocking { inspectionGrpcClient.cleanupOrphanedTraces(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.error)
            }

            ResponseEntity.ok(
                mapOf(
                    "rag_traces_deleted" to response.ragTracesDeleted,
                    "llm_traces_deleted" to response.llmTracesDeleted,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to cleanup orphaned traces")
        }

    // =========================================================================
    // Graph Housekeeping
    // =========================================================================

    @PostMapping("/graph/health-check")
    fun graphHealthCheck(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val request =
                GraphHealthCheckRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .build()

            val response = runBlocking { adminGrpcClient.graphHealthCheck(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Health check failed")
            }

            val statsMap: Map<String, Any?> =
                if (response.statsJson.isNotBlank()) {
                    @Suppress("UNCHECKED_CAST")
                    objectMapper.readValue(response.statsJson, Map::class.java) as Map<String, Any?>
                } else {
                    emptyMap()
                }

            ResponseEntity.ok(
                mapOf(
                    "critical_count" to response.criticalCount,
                    "warning_count" to response.warningCount,
                    "info_count" to response.infoCount,
                    "findings" to
                        response.findingsList.map {
                            mapOf(
                                "severity" to it.severity,
                                "category" to it.category,
                                "metric" to it.metric,
                                "message" to it.message,
                                "sample" to it.sampleList,
                            )
                        },
                    "stats" to statsMap,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to run graph health check")
        }

    data class SweepRequest(
        val dryRun: Boolean = true,
        val purgeEmptyWorkspaces: Boolean = false
    )

    @PostMapping("/graph/sweep-orphans")
    fun sweepGraphOrphans(
        @RequestBody body: SweepRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val request =
                SweepGraphOrphansRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setDryRun(body.dryRun)
                    .setPurgeEmptyWorkspaces(body.purgeEmptyWorkspaces)
                    .build()

            val response = runBlocking { adminGrpcClient.sweepGraphOrphans(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }

            ResponseEntity.ok(
                mapOf(
                    "orphan_chunks_deleted" to response.orphanChunksDeleted,
                    "orphan_sections_deleted" to response.orphanSectionsDeleted,
                    "orphan_chapters_deleted" to response.orphanChaptersDeleted,
                    "orphan_books_deleted" to response.orphanBooksDeleted,
                    "empty_workspaces_deleted" to response.emptyWorkspacesDeleted,
                    "total_deleted" to response.totalDeleted,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to sweep graph orphans")
        }

    data class MergeRequest(
        val dryRun: Boolean = true,
        val batchSize: Int = 500
    )

    @PostMapping("/graph/merge-duplicates")
    fun mergeDuplicateEntities(
        @RequestBody body: MergeRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val request =
                MergeDuplicateEntitiesRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setDryRun(body.dryRun)
                    .setBatchSize(body.batchSize)
                    .build()

            val response = runBlocking { adminGrpcClient.mergeDuplicateEntities(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }

            // When dry_run=true the Python service includes a
            // sample_groups_json blob describing the duplicate-groups it
            // WOULD merge. Parse it here so the merge wizard UI can show
            // a per-group preview before the operator commits.
            val sampleGroups: List<Any> =
                if (response.sampleGroupsJson.isNotBlank()) {
                    @Suppress("UNCHECKED_CAST")
                    objectMapper.readValue(response.sampleGroupsJson, List::class.java) as List<Any>
                } else {
                    emptyList()
                }

            ResponseEntity.ok(
                mapOf(
                    "groups_merged" to response.groupsMerged,
                    "duplicate_nodes_removed" to response.duplicateNodesRemoved,
                    "edges_redirected" to response.edgesRedirected,
                    "message" to response.message,
                    "sample_groups" to sampleGroups,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to merge duplicate entities")
        }

    data class CleanupRequest(
        val dryRun: Boolean = true
    )

    @PostMapping("/graph/cleanup-missing-files")
    fun cleanupMissingFileDocs(
        @RequestBody body: CleanupRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val request =
                CleanupMissingFileDocsRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setDryRun(body.dryRun)
                    .build()

            val response = runBlocking { adminGrpcClient.cleanupMissingFileDocs(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }

            ResponseEntity.ok(
                mapOf(
                    "docs_processed" to response.docsProcessed,
                    "pg_embeddings_deleted" to response.pgEmbeddingsDeleted,
                    "neo4j_nodes_deleted" to response.neo4JNodesDeleted,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to cleanup missing file docs")
        }

    data class SweepOrphanEntitiesBody(
        val dryRun: Boolean = true,
        val createdBeforeDays: Int = 7,
        val limit: Int = 0,
    )

    @PostMapping("/graph/sweep-orphan-entities")
    fun sweepOrphanEntities(
        @RequestBody body: SweepOrphanEntitiesBody,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val request =
                SweepOrphanEntitiesRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setDryRun(body.dryRun)
                    .setCreatedBeforeDays(body.createdBeforeDays)
                    .setLimit(body.limit)
                    .build()

            val response = runBlocking { adminGrpcClient.sweepOrphanEntities(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }

            ResponseEntity.ok(
                mapOf(
                    "candidates" to response.candidates,
                    "deleted" to response.deleted,
                    "created_before_days" to response.createdBeforeDays,
                    "sample_names" to response.sampleNamesList,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to sweep orphan entities")
        }

    data class RecomputeIdfBody(
        val dryRun: Boolean = false
    )

    @PostMapping("/graph/recompute-idf")
    fun recomputeEntityIdf(
        @RequestBody(required = false) body: RecomputeIdfBody?,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val req = body ?: RecomputeIdfBody()
        return try {
            val request =
                RecomputeEntityIdfRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setDryRun(req.dryRun)
                    .build()

            val response = runBlocking { adminGrpcClient.recomputeEntityIdf(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }

            val sampleList: Any =
                if (response.sampleRareEntitiesJson.isNotBlank()) {
                    objectMapper.readValue(response.sampleRareEntitiesJson, List::class.java)
                } else {
                    emptyList<Any>()
                }

            ResponseEntity.ok(
                mapOf(
                    "total_documents" to response.totalDocuments,
                    "total_entities" to response.totalEntities,
                    "updated" to response.updated,
                    "skipped_no_mentions" to response.skippedNoMentions,
                    "p50_idf" to response.p50Idf,
                    "p95_idf" to response.p95Idf,
                    "max_idf" to response.maxIdf,
                    "min_idf" to response.minIdf,
                    "sample_rare_entities" to sampleList,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to recompute entity IDF")
        }
    }

    data class RecomputeFingerprintsBody(
        val collectionId: String = ""
    )

    @PostMapping("/graph/recompute-fingerprints")
    fun recomputeCollectionFingerprints(
        @RequestBody(required = false) body: RecomputeFingerprintsBody?,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val req = body ?: RecomputeFingerprintsBody()
        return try {
            val request =
                RecomputeCollectionFingerprintsRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setCollectionId(req.collectionId)
                    .build()

            val response = runBlocking { adminGrpcClient.recomputeCollectionFingerprints(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }

            val fingerprintsList: Any =
                if (response.fingerprintsJson.isNotBlank()) {
                    objectMapper.readValue(response.fingerprintsJson, List::class.java)
                } else {
                    emptyList<Any>()
                }

            ResponseEntity.ok(
                mapOf(
                    "collections_processed" to response.collectionsProcessed,
                    "with_centroid" to response.withCentroid,
                    "fingerprints" to fingerprintsList,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to recompute collection fingerprints")
        }
    }

    data class DetectBridgeBody(
        val collectionIds: List<String>
    )

    @PostMapping("/graph/detect-bridge")
    fun detectCollectionBridge(
        @RequestBody body: DetectBridgeBody,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        if (body.collectionIds.size < 2) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "collectionIds must contain ≥ 2 entries")
        }
        return try {
            val request =
                DetectCollectionBridgeRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .addAllCollectionIds(body.collectionIds)
                    .build()

            val response = runBlocking { adminGrpcClient.detectCollectionBridge(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }

            val verdictMap = parseJsonMap(response.verdictJson)

            ResponseEntity.ok(
                mapOf(
                    "mode" to response.mode,
                    "verdict" to verdictMap,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to detect cross-domain bridge")
        }
    }

    data class ClassifyTypedRelationshipsBody(
        val documentId: String,
        val maxPairs: Int = 0,
        val minWeight: Double = 0.0,
        val minConfidence: Double = 0.0,
    )

    @PostMapping("/graph/classify-typed-relationships")
    fun classifyTypedRelationships(
        @RequestBody body: ClassifyTypedRelationshipsBody,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        if (body.documentId.isBlank()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "documentId is required")
        }
        return try {
            val request =
                ClassifyTypedRelationshipsRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setDocumentId(body.documentId)
                    .setMaxPairs(body.maxPairs)
                    .setMinWeight(body.minWeight)
                    .setMinConfidence(body.minConfidence)
                    .build()

            val response = runBlocking { adminGrpcClient.classifyTypedRelationships(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }

            val persistedMap = parseJsonMap(response.persistedByTypeJson)

            ResponseEntity.ok(
                mapOf(
                    "document_id" to response.documentId,
                    "pair_count" to response.pairCount,
                    "llm_calls" to response.llmCalls,
                    "skipped_low_confidence" to response.skippedLowConfidence,
                    "skipped_none" to response.skippedNone,
                    "persisted_by_type" to persistedMap,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to classify typed relationships")
        }
    }

    data class RecomputePageRankBody(
        val collectionId: String = ""
    )

    @PostMapping("/graph/recompute-pagerank")
    fun recomputePageRank(
        @RequestBody(required = false) body: RecomputePageRankBody?,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val req = body ?: RecomputePageRankBody()
        return try {
            val request =
                RecomputePageRankRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setCollectionId(req.collectionId)
                    .build()

            val response = runBlocking { adminGrpcClient.recomputePageRank(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }

            val resultsList: Any =
                if (response.resultsJson.isNotBlank()) {
                    objectMapper.readValue(response.resultsJson, List::class.java)
                } else {
                    emptyList<Any>()
                }

            ResponseEntity.ok(
                mapOf(
                    "collections_processed" to response.collectionsProcessed,
                    "books_scored" to response.booksScored,
                    "books_considered" to response.booksConsidered,
                    "edges_projected" to response.edgesProjected,
                    "longest_duration_ms" to response.longestDurationMs,
                    "results" to resultsList,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to recompute PageRank")
        }
    }

    @PostMapping("/graph/recompute-cooccurrence-weights")
    fun recomputeCooccurrenceWeights(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val request =
                RecomputeCooccurrenceWeightsRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .build()

            val response = runBlocking { adminGrpcClient.recomputeCooccurrenceWeights(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }

            val sampleList: Any =
                if (response.sampleTopEdgesJson.isNotBlank()) {
                    objectMapper.readValue(response.sampleTopEdgesJson, List::class.java)
                } else {
                    emptyList<Any>()
                }

            ResponseEntity.ok(
                mapOf(
                    "total_edges" to response.totalEdges,
                    "updated" to response.updated,
                    "skipped" to response.skipped,
                    "p50_weighted" to response.p50Weighted,
                    "p95_weighted" to response.p95Weighted,
                    "max_weighted" to response.maxWeighted,
                    "max_chunk_count" to response.maxChunkCount,
                    "max_document_count" to response.maxDocumentCount,
                    "sample_top_edges" to sampleList,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to recompute co-occurrence weights")
        }

    data class PruneCooccurrenceBody(
        val dryRun: Boolean = true,
        val percentile: Double = 0.0,
    )

    @PostMapping("/graph/prune-cooccurrence")
    fun pruneCooccurrenceEdges(
        @RequestBody(required = false) body: PruneCooccurrenceBody?,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val req = body ?: PruneCooccurrenceBody()
        return try {
            val request =
                PruneCooccurrenceEdgesRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setDryRun(req.dryRun)
                    .setPercentile(req.percentile)
                    .build()

            val response = runBlocking { adminGrpcClient.pruneCooccurrenceEdges(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }

            val sampleList: Any =
                if (response.samplePrunedJson.isNotBlank()) {
                    objectMapper.readValue(response.samplePrunedJson, List::class.java)
                } else {
                    emptyList<Any>()
                }

            ResponseEntity.ok(
                mapOf(
                    "dry_run" to response.dryRun,
                    "threshold_percentile" to response.thresholdPercentile,
                    "threshold_value" to response.thresholdValue,
                    "total_edges_before" to response.totalEdgesBefore,
                    "edges_deleted" to response.edgesDeleted,
                    "snapshot_key_prefix" to response.snapshotKeyPrefix,
                    "sample_pruned" to sampleList,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to prune co-occurrence edges")
        }
    }

    @GetMapping("/graph/extraction-metrics")
    fun getEntityExtractionMetrics(
        @RequestParam(required = false, defaultValue = "7") windowDays: Int,
        @RequestParam(required = false, defaultValue = "100") topDocumentsLimit: Int,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val request =
                GetEntityExtractionMetricsRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setWindowDays(windowDays)
                    .setTopDocumentsLimit(topDocumentsLimit)
                    .build()

            val response = runBlocking { adminGrpcClient.getEntityExtractionMetrics(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }

            val summaryMap = parseJsonMap(response.summaryJson)

            ResponseEntity.ok(
                mapOf(
                    "summary" to summaryMap,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to fetch entity extraction metrics")
        }

    data class EvaluateGraphUtilityBody(
        val evalSetPath: String = "",
        val configurationsJson: String = "",
        val topK: Int = 10,
    )

    @PostMapping("/graph/evaluate-utility")
    fun evaluateGraphUtility(
        @RequestBody(required = false) body: EvaluateGraphUtilityBody?,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val req = body ?: EvaluateGraphUtilityBody()
        return try {
            val request =
                EvaluateGraphUtilityRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setEvalSetPath(req.evalSetPath)
                    .setConfigurationsJson(req.configurationsJson)
                    .setTopK(req.topK)
                    .build()

            val response = runBlocking { adminGrpcClient.evaluateGraphUtility(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }

            val runMap = parseJsonMap(response.runJson)

            ResponseEntity.ok(
                mapOf(
                    "started_at" to response.startedAt,
                    "finished_at" to response.finishedAt,
                    "run" to runMap,
                    "markdown_report" to response.markdownReport,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to run graph utility evaluation")
        }
    }

    // ---------- Harness Comparison ----------
    //
    // POST /admin/harness/run — fire-and-forget; returns run_id immediately.
    // GET  /admin/harness/{run_id} — poll status + summary + markdown.
    //
    // Body fields default to empty lists / zero so the Python side falls back
    // to evaluation.harness_comparison defaults from config.yaml.

    data class RunHarnessComparisonBody(
        val evalSetId: String = "",
        val retrievers: List<String> = emptyList(),
        val deliveryModes: List<String> = emptyList(),
        val promptVariants: List<String> = emptyList(),
        val sampleSize: Int = 0,
        val maxConcurrent: Int = 0,
    )

    @PostMapping("/harness/run")
    fun runHarnessComparison(
        @RequestBody(required = false) body: RunHarnessComparisonBody?,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val req = body ?: RunHarnessComparisonBody()
        return try {
            val request =
                RunHarnessComparisonRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setEvalSetId(req.evalSetId)
                    .addAllRetrievers(req.retrievers)
                    .addAllDeliveryModes(req.deliveryModes)
                    .addAllPromptVariants(req.promptVariants)
                    .setSampleSize(req.sampleSize)
                    .setMaxConcurrent(req.maxConcurrent)
                    .build()

            val response = runBlocking { adminGrpcClient.runHarnessComparison(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }

            ResponseEntity.ok(
                mapOf(
                    "run_id" to response.runId,
                    "status" to response.status,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to start harness comparison")
        }
    }

    @GetMapping("/harness/{runId}")
    fun getHarnessComparison(
        @PathVariable("runId") runId: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val request =
                GetHarnessComparisonRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setRunId(runId)
                    .build()

            val response = runBlocking { adminGrpcClient.getHarnessComparison(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.NOT_FOUND, response.message)
            }

            val configMap = parseJsonMap(response.configJson)
            val summaryMap = parseJsonMap(response.summaryJson)

            ResponseEntity.ok(
                mapOf(
                    "run_id" to response.runId,
                    "status" to response.status,
                    "started_at" to response.startedAt,
                    "completed_at" to response.completedAt,
                    "config" to configMap,
                    "summary" to summaryMap,
                    "markdown_report" to response.markdownReport,
                    "error_message" to response.errorMessage,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to fetch harness comparison")
        }

    @PostMapping("/graph/audit")
    fun graphAudit(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> =
        try {
            val request =
                GraphAuditRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .build()

            val response = runBlocking { adminGrpcClient.graphAudit(request) }

            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Graph audit failed")
            }

            val auditMap: Map<String, Any?> =
                if (response.auditJson.isNotBlank()) {
                    @Suppress("UNCHECKED_CAST")
                    objectMapper.readValue(response.auditJson, Map::class.java) as Map<String, Any?>
                } else {
                    emptyMap()
                }

            ResponseEntity.ok(
                mapOf(
                    "measured_at" to response.measuredAt,
                    "audit" to auditMap,
                    "markdown_report" to response.markdownReport,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to run graph audit")
        }

    // Leiden Communities — admin trigger + read endpoints.

    data class BuildCommunitiesBody(
        val collectionId: String,
        val maxClusterSize: Int = 12,
        val generateReports: Boolean = true,
        val parallelism: Int = 4,
    )

    @PostMapping("/graph/build-communities")
    fun buildCommunities(
        @RequestBody body: BuildCommunitiesBody,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        if (body.collectionId.isBlank()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "collectionId is required")
        }
        return try {
            val request =
                BuildCommunitiesRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setCollectionId(body.collectionId)
                    .setMaxClusterSize(body.maxClusterSize)
                    .setGenerateReports(body.generateReports)
                    .setParallelism(body.parallelism)
                    .build()

            val response = runBlocking { adminGrpcClient.buildCommunities(request) }
            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }
            val sizesByLevel = parseJsonMap(response.sizesByLevelJson)
            ResponseEntity.ok(
                mapOf(
                    "communities_total" to response.communitiesTotal,
                    "reports_written" to response.reportsWritten,
                    "sizes_by_level" to sizesByLevel,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to build communities")
        }
    }

    @GetMapping("/graph/community-hierarchy")
    fun getCommunityHierarchy(
        @RequestParam collectionId: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        if (collectionId.isBlank()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "collectionId is required")
        }
        return try {
            val request =
                GetCommunityHierarchyRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setCollectionId(collectionId)
                    .build()
            val response = runBlocking { adminGrpcClient.getCommunityHierarchy(request) }
            if (!response.success) {
                throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, response.message)
            }
            val communities =
                response.communitiesList.map { c ->
                    mapOf(
                        "community_id" to c.communityId,
                        "level" to c.level,
                        "size" to c.size,
                        "weight" to c.weight,
                        "title" to c.title,
                        "rating" to c.rating,
                        "parent_community_id" to c.parentCommunityId.ifBlank { null },
                    )
                }
            ResponseEntity.ok(
                mapOf(
                    "communities" to communities,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to load community hierarchy")
        }
    }

    @GetMapping("/graph/community/{communityId}")
    fun getCommunityReport(
        @PathVariable communityId: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        if (communityId.isBlank()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "communityId is required")
        }
        return try {
            val request =
                GetCommunityReportRequest
                    .newBuilder()
                    .setUserId(userIdOf(userDetails))
                    .setCommunityId(communityId)
                    .build()
            val response = runBlocking { adminGrpcClient.getCommunityReport(request) }
            if (!response.success) {
                throw ResponseStatusException(HttpStatus.NOT_FOUND, response.message)
            }
            val findings =
                response.findingsList.map {
                    mapOf(
                        "summary" to it.summary,
                        "explanation" to it.explanation,
                    )
                }
            ResponseEntity.ok(
                mapOf(
                    "community_id" to response.communityId,
                    "title" to response.title,
                    "summary" to response.summary,
                    "rating" to response.rating,
                    "rating_explanation" to response.ratingExplanation,
                    "findings" to findings,
                    "member_entity_ids" to response.memberEntityIdsList,
                    "message" to response.message,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            handleGrpcError(e, "Failed to load community report")
        }
    }
}
