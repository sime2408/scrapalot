package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.research.*
import mu.KotlinLogging
import org.springframework.stereotype.Service

private val logger = KotlinLogging.logger {}

/**
 * gRPC client for Python ResearchDataService.
 *
 * Retrieval and deletion of deep research data (plans, synthesis, sources).
 */
@Service
class ResearchGrpcClient(
    private val stub: ResearchDataServiceGrpcKt.ResearchDataServiceCoroutineStub
) {
    suspend fun getByPlan(request: GetByPlanRequest): FullResearchResponse {
        logger.info { "gRPC GetByPlan: plan_id=${request.planId}" }
        return stub.getByPlan(request)
    }

    suspend fun getByMessage(request: GetByMessageRequest): FullResearchResponse {
        logger.info { "gRPC GetByMessage: message_id=${request.messageId}" }
        return stub.getByMessage(request)
    }

    suspend fun getSessionPlans(request: GetSessionPlansRequest): SessionPlansResponse {
        logger.info { "gRPC GetSessionPlans: session_id=${request.sessionId}" }
        return stub.getSessionPlans(request)
    }

    suspend fun deleteByMessageIds(request: DeleteByMessageIdsRequest): DeleteByMessageIdsResponse {
        logger.info { "gRPC DeleteByMessageIds: ${request.messageIdsList.size} message_ids" }
        return stub.deleteByMessageIds(request)
    }

    suspend fun getActiveResearch(request: GetActiveResearchRequest): ActiveResearchResponse {
        logger.info { "gRPC GetActiveResearch: session_id=${request.sessionId}" }
        return stub.getActiveResearch(request)
    }

    suspend fun cancelResearch(request: CancelResearchRequest): CancelResearchResponse {
        logger.info { "gRPC CancelResearch: plan_id=${request.planId}" }
        return stub.cancelResearch(request)
    }
}
