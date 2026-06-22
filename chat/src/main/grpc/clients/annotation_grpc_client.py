"""gRPC client for fetching annotations from Kotlin backend.

Connects to the Kotlin backend gRPC server (port 9090) to retrieve
document and collection annotations. Replaces cross-DB SQL queries
with proper service boundary via gRPC.

Kotlin is the owner of annotation data (scrapalot_backend DB).
Python reads annotations for RAG context enrichment.
"""

import threading

import grpc

from src.main.grpc import annotations_pb2, annotations_pb2_grpc
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Module-level channel (lazy-initialized, reused across calls)
_channel: grpc.Channel | None = None
_stub: annotations_pb2_grpc.AnnotationServiceStub | None = None
_stub_lock = threading.Lock()


def _get_backend_address() -> str:
    """Build the Kotlin backend gRPC address from config."""
    grpc_config = resolved_config.get("grpc", {}).get("client", {})
    host = grpc_config.get("backend_host", "scrapalot-backend")
    port = grpc_config.get("backend_port", 9090)
    return f"{host}:{port}"


def _get_timeout() -> int:
    """Get gRPC call timeout from config."""
    grpc_config = resolved_config.get("grpc", {}).get("client", {})
    return grpc_config.get("timeout", 30)


def _get_stub() -> annotations_pb2_grpc.AnnotationServiceStub:
    """Get or create the gRPC stub (lazy singleton, thread-safe)."""
    global _channel, _stub

    if _stub is not None:
        return _stub

    with _stub_lock:
        # Double-check after acquiring the lock
        if _stub is not None:
            stub = _stub
            # noinspection PyTypeChecker
            return stub

        address = _get_backend_address()
        _channel = grpc.insecure_channel(address)
        _stub = annotations_pb2_grpc.AnnotationServiceStub(_channel)
        logger.info("Annotation gRPC client connected to %s", address)
        stub = _stub
        # noinspection PyTypeChecker
        return stub


def _annotation_to_dict(ann) -> dict:
    """Convert a protobuf AnnotationMessage to a plain dict."""
    return {
        "id": ann.id,
        "document_id": ann.document_id,
        "user_id": ann.user_id,
        "collection_id": ann.collection_id,
        "annotation_type": ann.annotation_type,
        "selected_text": ann.selected_text,
        "comment": ann.comment,
        "color": ann.color,
        "page_label": ann.page_label,
        "position_json": ann.position_json,
        "viewer_type": ann.viewer_type,
        "is_pinned": ann.is_pinned,
        "created_at": ann.created_at,
        "updated_at": ann.updated_at,
        "session_id": ann.session_id,
        "sort_index": ann.sort_index,
    }


def get_document_annotations(
    document_id: str,
    user_id: str,
    max_results: int = 50,
) -> list[dict]:
    """
    Fetch annotations for a specific document from Kotlin backend via gRPC.

    Args:
        document_id: UUID of the document
        user_id: UUID of the user
        max_results: Maximum annotations to return (0 = server default)

    Returns:
        List of annotation dicts
    """
    try:
        stub = _get_stub()
        # noinspection PyUnresolvedReferences
        request = annotations_pb2.GetDocumentAnnotationsRequest(
            document_id=document_id,
            user_id=user_id,
            max_results=max_results,
        )
        response = stub.GetDocumentAnnotations(request, timeout=_get_timeout())

        annotations = [_annotation_to_dict(ann) for ann in response.annotations]
        if annotations:
            logger.info(
                "Fetched %d annotations for document %s via gRPC",
                len(annotations),
                document_id[:8],
            )
        return annotations

    except grpc.RpcError as e:
        logger.warning(
            "gRPC error fetching document annotations: %s (code=%s)",
            e.details() if hasattr(e, "details") else str(e),
            e.code() if hasattr(e, "code") else "UNKNOWN",
        )
        return []
    except Exception as e:
        logger.warning("Failed to fetch document annotations via gRPC: %s", str(e))
        return []


def get_collection_annotations(
    collection_id: str,
    user_id: str,
    max_results: int = 50,
) -> list[dict]:
    """
    Fetch annotations for all documents in a collection from Kotlin backend via gRPC.

    Args:
        collection_id: UUID of the collection
        user_id: UUID of the user
        max_results: Maximum annotations to return (0 = server default)

    Returns:
        List of annotation dicts
    """
    try:
        stub = _get_stub()
        # noinspection PyUnresolvedReferences
        request = annotations_pb2.GetCollectionAnnotationsRequest(
            collection_id=collection_id,
            user_id=user_id,
            max_results=max_results,
        )
        response = stub.GetCollectionAnnotations(request, timeout=_get_timeout())

        annotations = [_annotation_to_dict(ann) for ann in response.annotations]
        if annotations:
            logger.info(
                "Fetched %d annotations for collection %s via gRPC",
                len(annotations),
                collection_id[:8],
            )
        return annotations

    except grpc.RpcError as e:
        logger.warning(
            "gRPC error fetching collection annotations: %s (code=%s)",
            e.details() if hasattr(e, "details") else str(e),
            e.code() if hasattr(e, "code") else "UNKNOWN",
        )
        return []
    except Exception as e:
        logger.warning("Failed to fetch collection annotations via gRPC: %s", str(e))
        return []


def close() -> None:
    """Close the gRPC channel. Call during application shutdown."""
    global _channel, _stub
    with _stub_lock:
        if _channel is not None:
            _channel.close()
            _channel = None
            _stub = None
            logger.info("Annotation gRPC client channel closed")
