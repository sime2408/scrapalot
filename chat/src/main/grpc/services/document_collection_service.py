"""
DocumentCollectionService gRPC Implementation

Implements the DocumentCollectionService defined in documents.proto.
Handles multi-collection document membership (add, remove, list).
"""

# noinspection PyUnresolvedReferences
from google.protobuf import empty_pb2
import grpc

from src.main.grpc import documents_pb2, documents_pb2_grpc
from src.main.grpc.grpc_utils import grpc_db_session
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# noinspection PyUnresolvedReferences
class DocumentCollectionServiceServicer(documents_pb2_grpc.DocumentCollectionServiceServicer):
    """DocumentCollectionService gRPC implementation."""

    async def AddDocumentToCollection(
        self,
        request: documents_pb2.AddDocToCollectionRequest,
        context: grpc.aio.ServicerContext,
    ) -> empty_pb2.Empty:
        """Add a document to a collection."""
        logger.info(
            "DocumentCollectionService.AddDocumentToCollection called - document_id=%s, collection_id=%s, user_id=%s",
            request.document_id,
            request.collection_id,
            request.user_id,
        )

        try:
            from src.main.service.document.document_collections import add_to_collection

            with grpc_db_session() as db:
                success = add_to_collection(
                    db=db,
                    document_id=request.document_id,
                    collection_id=request.collection_id,
                )

                if not success:
                    await context.abort(
                        grpc.StatusCode.INTERNAL,
                        f"Failed to add document {request.document_id} to collection {request.collection_id}",
                    )

                return empty_pb2.Empty()

        except Exception as e:
            logger.exception("Error in DocumentCollectionService.AddDocumentToCollection: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, "Add to collection failed: %s" % str(e))

    async def RemoveDocumentFromCollection(
        self,
        request: documents_pb2.RemoveDocFromCollectionRequest,
        context: grpc.aio.ServicerContext,
    ) -> empty_pb2.Empty:
        """Remove a document from a collection."""
        logger.info(
            "DocumentCollectionService.RemoveDocumentFromCollection called - document_id=%s, collection_id=%s, user_id=%s",
            request.document_id,
            request.collection_id,
            request.user_id,
        )

        try:
            from src.main.service.document.document_collections import remove_from_collection

            with grpc_db_session() as db:
                deleted = remove_from_collection(
                    db=db,
                    document_id=request.document_id,
                    collection_id=request.collection_id,
                )

                if not deleted:
                    await context.abort(
                        grpc.StatusCode.NOT_FOUND,
                        f"Document {request.document_id} not found in collection {request.collection_id}",
                    )

                return empty_pb2.Empty()

        except Exception as e:
            logger.exception("Error in DocumentCollectionService.RemoveDocumentFromCollection: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, "Remove from collection failed: %s" % str(e))

    async def GetDocumentCollections(
        self,
        request: documents_pb2.GetDocCollectionsRequest,
        context: grpc.aio.ServicerContext,
    ) -> documents_pb2.GetDocCollectionsResponse:
        """Get all collections a document belongs to."""
        logger.info(
            "DocumentCollectionService.GetDocumentCollections called - document_id=%s",
            request.document_id,
        )

        try:
            from src.main.service.document.document_collections import get_document_collections

            with grpc_db_session() as db:
                collections = get_document_collections(
                    db=db,
                    document_id=request.document_id,
                )

                memberships = [
                    documents_pb2.CollectionMembership(
                        collection_id=c["collection_id"],
                        added_at=c.get("added_at", ""),
                    )
                    for c in collections
                ]

                return documents_pb2.GetDocCollectionsResponse(memberships=memberships)

        except Exception as e:
            logger.exception("Error in DocumentCollectionService.GetDocumentCollections: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, "Get document collections failed: %s" % str(e))
