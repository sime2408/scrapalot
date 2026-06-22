package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.collection.*
import mu.KotlinLogging
import org.springframework.stereotype.Service

private val logger = KotlinLogging.logger {}

/**
 * gRPC client for Python CollectionAIService.
 *
 * AI-powered collection description generation using LLM.
 */
@Service
class CollectionAIGrpcClient(
    private val stub: CollectionAIServiceGrpcKt.CollectionAIServiceCoroutineStub
) {
    suspend fun generateDescription(request: GenerateDescriptionRequest): GenerateDescriptionResponse {
        logger.info { "gRPC GenerateDescription: collection_id=${request.collectionId}" }
        return stub.generateDescription(request)
    }

    @Suppress("unused") // future API — generates a collection description from its name without existing documents
    suspend fun generateDescriptionFromName(request: GenerateDescriptionFromNameRequest): GenerateDescriptionResponse {
        logger.info { "gRPC GenerateDescriptionFromName: name=${request.collectionName}" }
        return stub.generateDescriptionFromName(request)
    }

    suspend fun generateCustomInstructions(request: GenerateCustomInstructionsRequest): GenerateCustomInstructionsResponse {
        logger.info { "gRPC GenerateCustomInstructions: collection_id=${request.collectionId}" }
        return stub.generateCustomInstructions(request)
    }
}
