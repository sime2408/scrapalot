package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.chat.*
import kotlinx.coroutines.flow.Flow
import mu.KotlinLogging
import org.springframework.stereotype.Service
import java.util.concurrent.TimeUnit

private val logger = KotlinLogging.logger {}

/**
 * gRPC client for Python ChatService.
 *
 * Wraps each specialized RPC method with logging and error handling.
 * Python (port 9091) owns AI/ML execution — Kotlin sends pre-resolved
 * model/provider info, so Python never needs to do model lookups.
 *
 * Streaming RPCs rely on keepalive pings (configured in application.yaml
 * and Python server.py) to detect dead connections — no call deadline is set
 * because stream duration is unpredictable (deep research can run 10+ minutes).
 *
 * Unary RPCs (generateTitle) have a 30-second deadline as a safety net.
 */
@Service
class ChatGrpcClient(
    private val stub: ChatServiceGrpcKt.ChatServiceCoroutineStub
) {
    fun generateDirectLLM(request: DirectLLMRequest): Flow<ChatResponsePacket> {
        logger.info { "gRPC GenerateDirectLLM: prompt=${request.prompt.take(80)}..." }
        return stub.generateDirectLLM(request)
    }

    fun generateRAG(request: RAGRequest): Flow<ChatResponsePacket> {
        logger.info { "gRPC GenerateRAG: prompt=${request.prompt.take(80)}..., collections=${request.collectionIdsList.size}" }
        return stub.generateRAG(request)
    }

    fun generateDeepResearch(request: DeepResearchRequest): Flow<ChatResponsePacket> {
        logger.info { "gRPC GenerateDeepResearch: prompt=${request.prompt.take(80)}..., breadth=${request.researchBreadth}, depth=${request.researchDepth}" }
        return stub.generateDeepResearch(request)
    }

    fun generateWebSearch(request: WebSearchRequest): Flow<ChatResponsePacket> {
        logger.info { "gRPC GenerateWebSearch: prompt=${request.prompt.take(80)}..." }
        return stub.generateWebSearch(request)
    }

    fun generateAgenticRAG(request: AgenticRAGRequest): Flow<ChatResponsePacket> {
        logger.info { "gRPC GenerateAgenticRAG: prompt=${request.prompt.take(80)}..., maxSources=${request.maxSources}" }
        return stub.generateAgenticRAG(request)
    }

    fun generateDocumentQA(request: DocumentQARequest): Flow<ChatResponsePacket> {
        logger.info { "gRPC GenerateDocumentQA: prompt=${request.prompt.take(80)}..., documentId=${request.documentId}" }
        return stub.generateDocumentQA(request)
    }

    suspend fun generateTitle(request: TitleRequest): TitleResponse {
        logger.info { "gRPC GenerateTitle: message=${request.userMessage.take(80)}..." }
        return stub.withDeadlineAfter(30, TimeUnit.SECONDS).generateTitle(request)
    }

    fun generateChatTutor(request: TutorChatRequest): Flow<ChatResponsePacket> {
        logger.info { "gRPC GenerateChatTutor: collection=${request.collectionId}, prompt=${request.prompt.take(80)}..." }
        return stub.generateChatTutor(request)
    }

    suspend fun getTutorProgress(request: GetTutorProgressRequest): TutorProgressResponse {
        logger.info { "gRPC GetTutorProgress: user=${request.userId}, collection=${request.collectionId}" }
        return stub.withDeadlineAfter(15, TimeUnit.SECONDS).getTutorProgress(request)
    }

    fun generateImage(request: GenerateImageRequest): Flow<ChatResponsePacket> {
        logger.info { "gRPC GenerateImage: user=${request.userId}, prompt=${request.prompt.take(80)}..., size=${request.size}, n=${request.n}" }
        return stub.generateImage(request)
    }
}
