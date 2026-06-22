package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.ai.DocumentProcessingServiceGrpcKt
import com.scrapalot.backend.grpc.ai.ProcessDocumentRequest
import com.scrapalot.backend.grpc.ai.ProcessPendingRequest
import com.scrapalot.backend.grpc.ai.ProcessingStatusChunk
import com.scrapalot.backend.grpc.ai.ReprocessDocumentRequest
import kotlinx.coroutines.flow.Flow
import mu.KotlinLogging
import org.springframework.stereotype.Service

private val logger = KotlinLogging.logger {}

/**
 * gRPC client for Python DocumentProcessingService.
 *
 * Delegates document processing (chunking, embedding, indexing) to Python AI backend.
 */
@Service
class DocumentProcessingGrpcClient(
    private val stub: DocumentProcessingServiceGrpcKt.DocumentProcessingServiceCoroutineStub
) {
    fun processDocument(
        documentId: String,
        userId: String
    ): Flow<ProcessingStatusChunk> {
        logger.info { "gRPC ProcessDocument: document_id=$documentId, user_id=$userId" }
        val request =
            ProcessDocumentRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setUserId(userId)
                .build()
        return stub.processDocument(request)
    }

    fun reprocessDocument(
        documentId: String,
        userId: String,
        collectionId: String
    ): Flow<ProcessingStatusChunk> {
        logger.info { "gRPC ReprocessDocument: document_id=$documentId, user_id=$userId, collection_id=$collectionId" }
        val request =
            ReprocessDocumentRequest
                .newBuilder()
                .setDocumentId(documentId)
                .setUserId(userId)
                .setCollectionId(collectionId)
                .build()
        return stub.reprocessDocument(request)
    }

    fun processPendingDocuments(
        collectionId: String,
        userId: String,
        workspaceId: String
    ): Flow<ProcessingStatusChunk> {
        logger.info { "gRPC ProcessPendingDocuments: collection_id=$collectionId, user_id=$userId, workspace_id=$workspaceId" }
        val request =
            ProcessPendingRequest
                .newBuilder()
                .setCollectionId(collectionId)
                .setUserId(userId)
                .setWorkspaceId(workspaceId)
                .build()
        return stub.processPendingDocuments(request)
    }
}
