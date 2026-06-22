"""Annotation context provider for RAG pipeline.

Fetches user annotations from Kotlin backend via gRPC and creates
boosted context chunks for inclusion in RAG responses.

Annotations are owned by Kotlin backend. Python reads them via gRPC
(AnnotationService) for RAG enrichment, replacing the previous cross-DB read.

Color -> RAG boost mapping:
  #ff6666 (red)     = 1.5x — critical/important
  #ffd400 (yellow)  = 1.2x — general highlight
  #5fb236 (green)   = 1.1x — methodology
  #2ea8e5 (blue)    = 1.1x — definition/concept
  #a28ae5 (purple)  = 1.0x — question
  #e56eee (magenta) = 1.0x — interesting
  #f19837 (orange)  = 1.0x — revisit
  #aaaaaa (gray)    = 0.8x — low priority
"""

from dataclasses import dataclass

from src.main.grpc.clients.annotation_grpc_client import (
    get_collection_annotations,
    get_document_annotations,
)
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Color -> boost score mapping
ANNOTATION_BOOST = {
    "#ff6666": 1.5,  # red = critical
    "#ffd400": 1.2,  # yellow = important
    "#5fb236": 1.1,  # green = methodology
    "#2ea8e5": 1.1,  # blue = definition
    "#a28ae5": 1.0,  # purple = question
    "#e56eee": 1.0,  # magenta = interesting
    "#f19837": 1.0,  # orange = revisit
    "#aaaaaa": 0.8,  # gray = low priority
}


@dataclass
class AnnotationChunk:
    """A chunk derived from a user annotation, with boost score."""

    text: str
    document_id: str
    boost: float
    color: str
    page_label: str | None
    comment: str | None
    annotation_id: str


def get_annotation_chunks(
    document_ids: list[str],
    user_id: str,
    max_annotations: int = 50,
    collection_id: str | None = None,
) -> list[AnnotationChunk]:
    """
    Fetch annotations for given documents from Kotlin backend via gRPC
    and return as boosted chunks.

    Args:
        document_ids: List of document UUIDs to fetch annotations for
        user_id: User UUID (annotations are per-user)
        max_annotations: Maximum number of annotations to return
        collection_id: If provided, fetch all collection annotations in one
            gRPC call instead of per-document N+1 calls.

    Returns:
        List of AnnotationChunk with text, boost score, and metadata
    """
    if not document_ids or not user_id:
        return []

    try:
        doc_id_set = set(document_ids)

        if collection_id:
            # Single gRPC call for the whole collection, then filter client-side
            raw = get_collection_annotations(
                collection_id=collection_id,
                user_id=user_id,
                max_results=max_annotations,
            )
            all_annotations = [a for a in raw if a.get("document_id") in doc_id_set]
        else:
            # Fallback: per-document calls when collection_id is unknown
            all_annotations = []
            for doc_id in document_ids:
                annotations = get_document_annotations(
                    document_id=doc_id,
                    user_id=user_id,
                    max_results=max_annotations,
                )
                all_annotations.extend(annotations)

        # Sort by color priority (red first, then yellow, etc.) and limit
        color_priority = {
            "#ff6666": 1,
            "#ffd400": 2,
            "#5fb236": 3,
            "#2ea8e5": 4,
            "#a28ae5": 5,
            "#e56eee": 5,
            "#f19837": 5,
            "#aaaaaa": 6,
        }
        all_annotations.sort(key=lambda a: color_priority.get(a.get("color", ""), 5))
        all_annotations = all_annotations[:max_annotations]

        # Convert to AnnotationChunk objects
        chunks = []
        for ann in all_annotations:
            selected_text = ann.get("selected_text", "")
            if not selected_text or len(selected_text) <= 10:
                continue

            comment = ann.get("comment") or None
            color = ann.get("color") or "#ffd400"

            # Combine selected text with user comment
            full_text = selected_text
            if comment:
                full_text = f"{selected_text}\n[User note: {comment}]"

            boost = ANNOTATION_BOOST.get(color, 1.0)

            chunks.append(
                AnnotationChunk(
                    text=full_text,
                    document_id=str(ann.get("document_id", "")),
                    boost=boost,
                    color=color,
                    page_label=ann.get("page_label") or None,
                    comment=comment,
                    annotation_id=str(ann.get("id", "")),
                )
            )

        if chunks:
            logger.info(
                "Fetched %d annotation chunks for user %s across %d documents",
                len(chunks),
                user_id[:8],
                len(document_ids),
            )

        return chunks

    except Exception as e:
        logger.warning("Failed to fetch annotation chunks: %s", str(e))
        return []


def format_annotation_context(chunks: list[AnnotationChunk]) -> str:
    """Format annotation chunks as context text for LLM prompt injection."""
    if not chunks:
        return ""

    lines = ["[User Annotations — highlighted sections from your documents:]"]
    for chunk in chunks:
        page_info = f" (p.{chunk.page_label})" if chunk.page_label else ""
        lines.append(f"- {chunk.text}{page_info}")

    return "\n".join(lines)
