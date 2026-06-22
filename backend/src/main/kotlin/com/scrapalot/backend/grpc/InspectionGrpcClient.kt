package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.inspection.*
import io.grpc.Status
import io.grpc.StatusException
import io.grpc.StatusRuntimeException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import mu.KotlinLogging
import org.springframework.stereotype.Service
import java.util.concurrent.TimeUnit
import kotlin.time.Duration.Companion.milliseconds

private val logger = KotlinLogging.logger {}

private const val MAX_RETRIES = 2
private const val RETRY_DELAY_MS = 1000L
private const val HEAVY_DEADLINE_SECONDS = 120L

/**
 * gRPC client for Python InspectionService.
 *
 * Proxies Data Inspector requests to the Python AI backend
 * for document evaluation, graph analysis, and RAG trace monitoring.
 * Automatically retries transient UNAVAILABLE errors (e.g., during container restart).
 */
@Service
class InspectionGrpcClient(
    private val stub: InspectionServiceGrpcKt.InspectionServiceCoroutineStub
) {
    private suspend fun <T> withRetry(
        operation: String,
        block: suspend () -> T
    ): T {
        var lastException: Exception? = null
        repeat(MAX_RETRIES + 1) { attempt ->
            try {
                return block()
            } catch (e: Exception) {
                lastException = e
                if (attempt < MAX_RETRIES && isTransientUnavailable(e)) {
                    logger.warn { "gRPC $operation: UNAVAILABLE (attempt ${attempt + 1}/$MAX_RETRIES), retrying in ${RETRY_DELAY_MS}ms..." }
                    delay((RETRY_DELAY_MS * (attempt + 1)).milliseconds)
                } else {
                    throw e
                }
            }
        }
        throw requireNotNull(lastException) { "No exception captured" }
    }

    private fun isTransientUnavailable(e: Exception): Boolean {
        val grpcStatus =
            when (e) {
                is StatusException -> e.status
                is StatusRuntimeException -> e.status
                else -> null
            }
        return grpcStatus?.code == Status.Code.UNAVAILABLE
    }

    suspend fun getDocumentEvaluation(request: DocEvalRequest): DocEvalResponse =
        withRetry("GetDocumentEvaluation") {
            logger.info { "gRPC GetDocumentEvaluation: document_id=${request.documentId}" }
            // Cold path runs a Neo4j hierarchy traversal — global 15 s default is too tight.
            stub.withDeadlineAfter(HEAVY_DEADLINE_SECONDS, TimeUnit.SECONDS).getDocumentEvaluation(request)
        }

    suspend fun getCollectionEvaluation(request: CollectionEvalRequest): CollectionEvalResponse =
        withRetry("GetCollectionEvaluation") {
            logger.info { "gRPC GetCollectionEvaluation: collection_id=${request.collectionId}" }
            stub.withDeadlineAfter(HEAVY_DEADLINE_SECONDS, TimeUnit.SECONDS).getCollectionEvaluation(request)
        }

    suspend fun getChunkInspection(request: ChunkInspectionRequest): ChunkInspectionResponse =
        withRetry("GetChunkInspection") {
            logger.info { "gRPC GetChunkInspection: document_id=${request.documentId}, page=${request.page}" }
            stub.getChunkInspection(request)
        }

    suspend fun getGraphSubgraph(request: SubgraphRequest): SubgraphResponse =
        withRetry("GetGraphSubgraph") {
            logger.info { "gRPC GetGraphSubgraph" }
            stub.withDeadlineAfter(HEAVY_DEADLINE_SECONDS, TimeUnit.SECONDS).getGraphSubgraph(request)
        }

    suspend fun getNodeNeighbors(request: NodeNeighborsRequest): NodeNeighborsResponse =
        withRetry("GetNodeNeighbors") {
            logger.info { "gRPC GetNodeNeighbors: node_id=${request.nodeElementId}" }
            stub.getNodeNeighbors(request)
        }

    suspend fun getGraphStats(request: GraphStatsRequest): GraphStatsResponse =
        withRetry("GetGraphStats") {
            logger.info { "gRPC GetGraphStats" }
            stub.withDeadlineAfter(HEAVY_DEADLINE_SECONDS, TimeUnit.SECONDS).getGraphStats(request)
        }

    suspend fun getKnowledgeGaps(request: KnowledgeGapsRequest): KnowledgeGapsResponse =
        withRetry("GetKnowledgeGaps") {
            logger.info { "gRPC GetKnowledgeGaps" }
            stub.getKnowledgeGaps(request)
        }

    suspend fun getEntityRelationships(request: EntityRelRequest): EntityRelResponse =
        withRetry("GetEntityRelationships") {
            logger.info { "gRPC GetEntityRelationships" }
            stub.getEntityRelationships(request)
        }

    suspend fun getRAGTraces(request: RAGTracesRequest): RAGTracesResponse =
        withRetry("GetRAGTraces") {
            logger.info { "gRPC GetRAGTraces: page=${request.page}, limit=${request.limit}" }
            stub.getRAGTraces(request)
        }

    suspend fun getStrategyDistribution(request: StrategyDistRequest): StrategyDistResponse =
        withRetry("GetStrategyDistribution") {
            logger.info { "gRPC GetStrategyDistribution" }
            stub.getStrategyDistribution(request)
        }

    suspend fun getLLMTraces(request: LLMTracesRequest): LLMTracesResponse =
        withRetry("GetLLMTraces") {
            logger.info { "gRPC GetLLMTraces: page=${request.page}, limit=${request.limit}" }
            stub.getLLMTraces(request)
        }

    suspend fun getLLMTraceSummary(request: LLMTraceSummaryRequest): LLMTraceSummaryResponse =
        withRetry("GetLLMTraceSummary") {
            logger.info { "gRPC GetLLMTraceSummary" }
            stub.getLLMTraceSummary(request)
        }

    fun runLLMEvaluation(request: LLMEvalRequest): Flow<LLMEvalProgress> {
        logger.info { "gRPC RunLLMEvaluation: sample_size=${request.sampleSize}" }
        return stub.runLLMEvaluation(request)
    }

    suspend fun getRelatedBooks(request: RelatedBooksRequest): RelatedBooksResponse =
        withRetry("GetRelatedBooks") {
            logger.info { "gRPC GetRelatedBooks: book_id=${request.bookId}, document_id=${request.documentId}" }
            stub.getRelatedBooks(request)
        }

    suspend fun getCrossBookGraph(request: CrossBookGraphRequest): CrossBookGraphResponse =
        withRetry("GetCrossBookGraph") {
            logger.info { "gRPC GetCrossBookGraph: collection_id=${request.collectionId}, limit=${request.limit}" }
            stub.withDeadlineAfter(HEAVY_DEADLINE_SECONDS, TimeUnit.SECONDS).getCrossBookGraph(request)
        }

    suspend fun getGraphSyncStatus(request: GraphSyncStatusRequest): GraphSyncStatusResponse =
        withRetry("GetGraphSyncStatus") {
            logger.info { "gRPC GetGraphSyncStatus: collection_id=${request.collectionId}, page=${request.page}" }
            stub.getGraphSyncStatus(request)
        }

    suspend fun getGraphQualityAudit(request: GraphQualityAuditRequest): GraphQualityAuditResponse =
        withRetry("GetGraphQualityAudit") {
            logger.info { "gRPC GetGraphQualityAudit: collection_id=${request.collectionId}" }
            stub.withDeadlineAfter(HEAVY_DEADLINE_SECONDS, TimeUnit.SECONDS).getGraphQualityAudit(request)
        }

    suspend fun getAgentCostAnalysis(request: AgentCostAnalysisRequest): AgentCostAnalysisResponse =
        withRetry("GetAgentCostAnalysis") {
            logger.info { "gRPC GetAgentCostAnalysis" }
            stub.getAgentCostAnalysis(request)
        }

    suspend fun cleanupOrphanedTraces(request: CleanupOrphanedTracesRequest): CleanupOrphanedTracesResponse =
        withRetry("CleanupOrphanedTraces") {
            logger.info { "gRPC CleanupOrphanedTraces: ${request.validSessionIdsList.size} valid sessions" }
            stub.cleanupOrphanedTraces(request)
        }

    suspend fun getEdgeProvenance(request: EdgeProvenanceRequest): EdgeProvenanceResponse =
        withRetry("GetEdgeProvenance") {
            logger.info { "gRPC GetEdgeProvenance: rel=${request.relElementId}" }
            stub.getEdgeProvenance(request)
        }
}
