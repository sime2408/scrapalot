"""
DocumentProcessingService gRPC Implementation

Implements the DocumentProcessingService defined in documents.proto.
Handles document processing (chunking, embedding, indexing).
"""

from collections.abc import AsyncIterator

import grpc

from src.main.grpc import documents_pb2, documents_pb2_grpc
from src.main.grpc.grpc_utils import build_grpc_user, grpc_db_session
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class DocumentProcessingServiceServicer(documents_pb2_grpc.DocumentProcessingServiceServicer):
    """DocumentProcessingService gRPC implementation."""

    async def ProcessDocument(
        self,
        request: documents_pb2.ProcessDocumentRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[documents_pb2.ProcessingStatusChunk]:
        """Process a single document (chunking, embedding, indexing)."""
        logger.info(
            "DocumentProcessingService.ProcessDocument called - document_id=%s, user_id=%s",
            request.document_id,
            request.user_id,
        )

        try:
            from src.main.service.document_processing.documents import process_single_document

            with grpc_db_session() as db:
                current_user = build_grpc_user(request.user_id)

                response = await process_single_document(
                    document_id=request.document_id,
                    current_user=current_user,
                    db=db,
                )

                job_id = response.get("job_id", "")
                message = response.get("message", "")

                yield documents_pb2.ProcessingStatusChunk(
                    job_id=job_id,
                    status="processing",
                    progress=0.0,
                    message=message,
                )

                yield documents_pb2.ProcessingStatusChunk(
                    job_id=job_id,
                    status="completed",
                    progress=100.0,
                    message="Processing started",
                )

        except Exception as e:
            from fastapi import HTTPException as _HTTPException

            if isinstance(e, _HTTPException) and e.status_code == 400:
                logger.warning("ProcessDocument validation error for %s: %s", request.document_id, e.detail)
                yield documents_pb2.ProcessingStatusChunk(
                    job_id="",
                    status="failed",
                    progress=0.0,
                    message=e.detail,
                )
            else:
                logger.exception("Error in DocumentProcessingService.ProcessDocument: %s", str(e))
                await context.abort(grpc.StatusCode.INTERNAL, "Document processing failed: %s" % str(e))

    async def ProcessPendingDocuments(
        self,
        request: documents_pb2.ProcessPendingRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[documents_pb2.ProcessingStatusChunk]:
        """Process all pending documents in a collection."""
        logger.info(
            "DocumentProcessingService.ProcessPendingDocuments called - collection_id=%s, user_id=%s",
            request.collection_id,
            request.user_id,
        )

        try:
            from src.main.service.document_processing.documents import process_pending_documents

            with grpc_db_session() as db:
                current_user = build_grpc_user(request.user_id)

                response = await process_pending_documents(
                    collection_id=request.collection_id,
                    current_user=current_user,
                    db=db,
                )

                message = response.get("message", "")
                documents_processed = response.get("documents_processed", 0)

                yield documents_pb2.ProcessingStatusChunk(
                    job_id="batch",
                    status="processing",
                    progress=float(documents_processed),
                    message=message,
                )

        except Exception as e:
            logger.exception("Error in DocumentProcessingService.ProcessPendingDocuments: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, "Batch processing failed: %s" % str(e))

    async def CancelProcessing(
        self,
        request: documents_pb2.CancelProcessingRequest,
        context: grpc.aio.ServicerContext,
    ) -> documents_pb2.CancelProcessingResponse:
        """Cancel a processing job."""
        logger.info(
            "DocumentProcessingService.CancelProcessing called - job_id=%s, user_id=%s",
            request.job_id,
            request.user_id,
        )

        try:
            from src.main.service.document_processing.documents import cancel_document_processing

            with grpc_db_session() as db:
                current_user = build_grpc_user(request.user_id)

                response = await cancel_document_processing(
                    job_id=request.job_id,
                    current_user=current_user,
                    db=db,
                )

                return documents_pb2.CancelProcessingResponse(
                    success=True,
                    message=response.get("message", "Processing cancelled"),
                )

        except Exception as e:
            logger.exception("Error in DocumentProcessingService.CancelProcessing: %s", str(e))
            return documents_pb2.CancelProcessingResponse(
                success=False,
                message="Cancellation failed: %s" % str(e),
            )

    async def GetProcessingStatus(
        self,
        request: documents_pb2.ProcessingStatusRequest,
        context: grpc.aio.ServicerContext,
    ) -> documents_pb2.ProcessingStatusResponse:
        """Get processing status for a job."""
        logger.info(
            "DocumentProcessingService.GetProcessingStatus called - job_id=%s, user_id=%s",
            request.job_id,
            request.user_id,
        )

        try:
            # The real function is `get_processing_status` — the earlier
            # `get_document_processing_status` symbol never existed and
            # every poll was bouncing off an ImportError → the empty
            # response plus a handler exception ate the 15 s deadline
            # and Kotlin BE reported DEADLINE_EXCEEDED for every status
            # poll during an upload. It's also a synchronous function
            # that hits Postgres; run it on the thread pool so the
            # chat event loop stays responsive under polling load.
            import asyncio as _aio

            from src.main.service.document_processing.documents import get_processing_status

            def _sync_probe(job_id: str, user_id: str) -> dict:
                # Fresh session inside the worker thread — can't share
                # the async-path grpc_db_session across threads.
                from src.main.config.database import SessionLocal

                with SessionLocal() as _db:
                    return get_processing_status(
                        job_id=job_id,
                        current_user=build_grpc_user(user_id),
                        db=_db,
                    )

            response = await _aio.to_thread(_sync_probe, request.job_id, request.user_id)

            return documents_pb2.ProcessingStatusResponse(
                job_id=response.get("job_id", request.job_id),
                status=response.get("status", "unknown"),
                progress=response.get("progress", 0.0),
                message=response.get("message", ""),
                error=response.get("error") if response.get("error") else None,
            )

        except Exception as e:
            logger.exception("Error in DocumentProcessingService.GetProcessingStatus: %s", str(e))
            return documents_pb2.ProcessingStatusResponse(
                job_id=request.job_id,
                status="failed",
                progress=0.0,
                message="Status query failed: %s" % str(e),
            )

    async def ReprocessDocument(
        self,
        request: documents_pb2.ReprocessDocumentRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[documents_pb2.ProcessingStatusChunk]:
        """Reprocess a document (re-chunk, re-embed, re-index)."""
        logger.info(
            "DocumentProcessingService.ReprocessDocument called - document_id=%s, user_id=%s",
            request.document_id,
            request.user_id,
        )

        try:
            from src.main.service.document_processing.documents import reprocess_failed_document

            with grpc_db_session() as db:
                current_user = build_grpc_user(request.user_id)

                response = await reprocess_failed_document(
                    document_id=request.document_id,
                    current_user=current_user,
                    db=db,
                )

                # response is a JSONResponse, extract content
                response_data = {}
                if hasattr(response, "body"):
                    import json as _json

                    response_data = _json.loads(response.body)

                job_id = response_data.get("job_id", "")
                message = response_data.get("message", "")

                yield documents_pb2.ProcessingStatusChunk(
                    job_id=job_id,
                    status="processing",
                    progress=0.0,
                    message=message,
                )

        except Exception as e:
            logger.exception("Error in DocumentProcessingService.ReprocessDocument: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, "Reprocessing failed: %s" % str(e))

    async def CleanupEmbeddings(
        self,
        request: documents_pb2.CleanupEmbeddingsRequest,
        context: grpc.aio.ServicerContext,
    ) -> documents_pb2.CleanupEmbeddingsResponse:
        """Cleanup embeddings for a collection."""
        logger.info(
            "DocumentProcessingService.CleanupEmbeddings called - collection_id=%s, user_id=%s",
            request.collection_id,
            request.user_id,
        )

        try:
            # noinspection PyUnresolvedReferences
            from src.main.service.document_processing.documents import cleanup_collection_embeddings

            with grpc_db_session() as db:
                current_user = build_grpc_user(request.user_id)

                response = await cleanup_collection_embeddings(
                    collection_id=request.collection_id,
                    current_user=current_user,
                    db=db,
                )

                return documents_pb2.CleanupEmbeddingsResponse(
                    success=True,
                    message=response.get("message", "Cleanup completed"),
                    deleted_count=response.get("deleted_count", 0),
                )

        except Exception as e:
            logger.exception("Error in DocumentProcessingService.CleanupEmbeddings: %s", str(e))
            return documents_pb2.CleanupEmbeddingsResponse(
                success=False,
                message="Cleanup failed: %s" % str(e),
                deleted_count=0,
            )
