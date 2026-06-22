package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.admin.*
import mu.KotlinLogging
import org.springframework.stereotype.Service
import java.util.concurrent.TimeUnit

private val logger = KotlinLogging.logger {}

// 30-minute deadline for the heavy admin RPCs that create hierarchy
// rows synchronously. Hierarchy creation is ~5-10 s per doc (chunks
// → Neo4j persist), so a batch=50 takes 4-8 min and batch=200 takes
// 16-32 min — the previous 10 min deadline tripped on anything
// larger than ~50. Async entity-extraction itself runs in Celery —
// only the dispatch + Postgres checkpoint upserts block this RPC.
private val ADMIN_HEAVY_DEADLINE_SECONDS = 1800L

/**
 * gRPC client for Python AdminService.
 *
 * Admin operations (Docker logs, GitHub workflows) run in Python container.
 * Kotlin calls via gRPC.
 */
@Service
class AdminGrpcClient(
    private val stub: AdminServiceGrpcKt.AdminServiceCoroutineStub
) {
    suspend fun triggerAutofix(request: TriggerAutofixRequest): TriggerAutofixResponse {
        logger.info { "gRPC TriggerAutofix: user_id=${request.userId}, target_repo=${request.targetRepo}" }
        return stub.triggerAutofix(request)
    }

    suspend fun getDebugLogs(request: GetDebugLogsRequest): GetDebugLogsResponse {
        logger.info { "gRPC GetDebugLogs: user_id=${request.userId}" }
        return stub.getDebugLogs(request)
    }

    suspend fun rebuildGraph(request: RebuildGraphRequest): RebuildGraphResponse {
        logger.info { "gRPC RebuildGraph: user_id=${request.userId}, collection_id=${request.collectionId}" }
        return stub.withDeadlineAfter(ADMIN_HEAVY_DEADLINE_SECONDS, TimeUnit.SECONDS).rebuildGraph(request)
    }

    suspend fun rebuildCrossBookRelationships(request: RebuildCrossBookRequest): RebuildCrossBookResponse {
        logger.info { "gRPC RebuildCrossBookRelationships: user_id=${request.userId}, collection_id=${request.collectionId}" }
        return stub.rebuildCrossBookRelationships(request)
    }

    suspend fun relinkDocumentCooccurrence(request: RelinkDocumentCooccurrenceRequest): RelinkDocumentCooccurrenceResponse {
        logger.info { "gRPC RelinkDocumentCooccurrence: user_id=${request.userId}, collection_id=${request.collectionId}" }
        return stub.withDeadlineAfter(ADMIN_HEAVY_DEADLINE_SECONDS, TimeUnit.SECONDS).relinkDocumentCooccurrence(request)
    }

    // ---------- Graph Housekeeping ----------

    suspend fun graphHealthCheck(request: GraphHealthCheckRequest): GraphHealthCheckResponse {
        logger.info { "gRPC GraphHealthCheck: user_id=${request.userId}" }
        return stub.graphHealthCheck(request)
    }

    suspend fun sweepGraphOrphans(request: SweepGraphOrphansRequest): SweepGraphOrphansResponse {
        logger.info { "gRPC SweepGraphOrphans: user_id=${request.userId}, dry_run=${request.dryRun}" }
        return stub.sweepGraphOrphans(request)
    }

    suspend fun mergeDuplicateEntities(request: MergeDuplicateEntitiesRequest): MergeDuplicateEntitiesResponse {
        logger.info { "gRPC MergeDuplicateEntities: user_id=${request.userId}, dry_run=${request.dryRun}" }
        return stub.mergeDuplicateEntities(request)
    }

    suspend fun cleanupMissingFileDocs(request: CleanupMissingFileDocsRequest): CleanupMissingFileDocsResponse {
        logger.info { "gRPC CleanupMissingFileDocs: user_id=${request.userId}, dry_run=${request.dryRun}" }
        return stub.cleanupMissingFileDocs(request)
    }

    suspend fun graphAudit(request: GraphAuditRequest): GraphAuditResponse {
        logger.info { "gRPC GraphAudit: user_id=${request.userId}" }
        return stub.graphAudit(request)
    }

    suspend fun sweepOrphanEntities(request: SweepOrphanEntitiesRequest): SweepOrphanEntitiesResponse {
        logger.info {
            "gRPC SweepOrphanEntities: user_id=${request.userId}, dry_run=${request.dryRun}, " +
                "days=${request.createdBeforeDays}, limit=${request.limit}"
        }
        return stub.sweepOrphanEntities(request)
    }

    suspend fun evaluateGraphUtility(request: EvaluateGraphUtilityRequest): EvaluateGraphUtilityResponse {
        logger.info {
            "gRPC EvaluateGraphUtility: user_id=${request.userId}, eval_set=${request.evalSetPath}, " +
                "top_k=${request.topK}"
        }
        return stub.evaluateGraphUtility(request)
    }

    suspend fun recomputeEntityIdf(request: RecomputeEntityIdfRequest): RecomputeEntityIdfResponse {
        logger.info { "gRPC RecomputeEntityIdf: user_id=${request.userId}, dry_run=${request.dryRun}" }
        return stub.recomputeEntityIdf(request)
    }

    suspend fun getEntityExtractionMetrics(request: GetEntityExtractionMetricsRequest): GetEntityExtractionMetricsResponse {
        logger.info {
            "gRPC GetEntityExtractionMetrics: user_id=${request.userId}, window=${request.windowDays}d"
        }
        return stub.getEntityExtractionMetrics(request)
    }

    suspend fun recomputeCooccurrenceWeights(request: RecomputeCooccurrenceWeightsRequest): RecomputeCooccurrenceWeightsResponse {
        logger.info { "gRPC RecomputeCooccurrenceWeights: user_id=${request.userId}" }
        return stub.recomputeCooccurrenceWeights(request)
    }

    suspend fun pruneCooccurrenceEdges(request: PruneCooccurrenceEdgesRequest): PruneCooccurrenceEdgesResponse {
        logger.info {
            "gRPC PruneCooccurrenceEdges: user_id=${request.userId}, dry_run=${request.dryRun}, pct=${request.percentile}"
        }
        return stub.pruneCooccurrenceEdges(request)
    }

    suspend fun recomputePageRank(request: RecomputePageRankRequest): RecomputePageRankResponse {
        logger.info {
            "gRPC RecomputePageRank: user_id=${request.userId}, collection=${request.collectionId.ifBlank { "ALL" }}"
        }
        return stub.recomputePageRank(request)
    }

    suspend fun classifyTypedRelationships(request: ClassifyTypedRelationshipsRequest): ClassifyTypedRelationshipsResponse {
        logger.info {
            "gRPC ClassifyTypedRelationships: user_id=${request.userId}, document=${request.documentId}"
        }
        return stub.classifyTypedRelationships(request)
    }

    suspend fun recomputeCollectionFingerprints(request: RecomputeCollectionFingerprintsRequest): RecomputeCollectionFingerprintsResponse {
        logger.info {
            "gRPC RecomputeCollectionFingerprints: user_id=${request.userId}, collection=${request.collectionId.ifBlank { "ALL" }}"
        }
        return stub.recomputeCollectionFingerprints(request)
    }

    suspend fun detectCollectionBridge(request: DetectCollectionBridgeRequest): DetectCollectionBridgeResponse {
        logger.info {
            "gRPC DetectCollectionBridge: user_id=${request.userId}, collections=${request.collectionIdsCount}"
        }
        return stub.detectCollectionBridge(request)
    }

    // Leiden Communities

    suspend fun buildCommunities(request: BuildCommunitiesRequest): BuildCommunitiesResponse {
        logger.info {
            "gRPC BuildCommunities: user_id=${request.userId}, collection=${request.collectionId}, reports=${request.generateReports}"
        }
        return stub.withDeadlineAfter(ADMIN_HEAVY_DEADLINE_SECONDS, TimeUnit.SECONDS).buildCommunities(request)
    }

    suspend fun getCommunityHierarchy(request: GetCommunityHierarchyRequest): GetCommunityHierarchyResponse {
        logger.info {
            "gRPC GetCommunityHierarchy: user_id=${request.userId}, collection=${request.collectionId}"
        }
        return stub.getCommunityHierarchy(request)
    }

    suspend fun getCommunityReport(request: GetCommunityReportRequest): GetCommunityReportResponse {
        logger.info {
            "gRPC GetCommunityReport: user_id=${request.userId}, community=${request.communityId}"
        }
        return stub.getCommunityReport(request)
    }

    // Cross-factorial harness comparison. Kick-off is fire-and-forget on the
    // Python side; the call
    // returns the run_id immediately so the UI can start polling.
    suspend fun runHarnessComparison(request: RunHarnessComparisonRequest): RunHarnessComparisonResponse {
        logger.info {
            "gRPC RunHarnessComparison: user_id=${request.userId}, eval_set=${request.evalSetId}, " +
                "sample=${request.sampleSize}, retrievers=${request.retrieversList}"
        }
        return stub.runHarnessComparison(request)
    }

    suspend fun getHarnessComparison(request: GetHarnessComparisonRequest): GetHarnessComparisonResponse {
        logger.info {
            "gRPC GetHarnessComparison: user_id=${request.userId}, run_id=${request.runId}"
        }
        return stub.getHarnessComparison(request)
    }
}
