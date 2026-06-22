package com.scrapalot.backend.grpc

import com.google.protobuf.Empty
import com.scrapalot.backend.grpc.ai.*
import com.scrapalot.backend.grpc.ai.DocumentCollectionServiceGrpcKt
import mu.KotlinLogging
import org.springframework.stereotype.Service

private val logger = KotlinLogging.logger {}

/**
 * gRPC client for Python DocumentCollectionService (multi-collection membership).
 */
@Service
class DocumentCollectionGrpcClient(
    private val stub: DocumentCollectionServiceGrpcKt.DocumentCollectionServiceCoroutineStub
) {
    suspend fun addDocumentToCollection(
        documentId: String,
        collectionId: String,
        userId: String
    ): Empty {
        logger.debug { "addDocumentToCollection: doc=$documentId coll=$collectionId user=$userId" }
        return stub.addDocumentToCollection(
            addDocToCollectionRequest {
                this.documentId = documentId
                this.collectionId = collectionId
                this.userId = userId
            }
        )
    }

    suspend fun removeDocumentFromCollection(
        documentId: String,
        collectionId: String,
        userId: String
    ): Empty {
        logger.debug { "removeDocumentFromCollection: doc=$documentId coll=$collectionId user=$userId" }
        return stub.removeDocumentFromCollection(
            removeDocFromCollectionRequest {
                this.documentId = documentId
                this.collectionId = collectionId
                this.userId = userId
            }
        )
    }

    suspend fun getDocumentCollections(documentId: String): List<CollectionMembership> {
        logger.debug { "getDocumentCollections: doc=$documentId" }
        val response =
            stub.getDocumentCollections(
                getDocCollectionsRequest { this.documentId = documentId }
            )
        return response.membershipsList
    }
}
