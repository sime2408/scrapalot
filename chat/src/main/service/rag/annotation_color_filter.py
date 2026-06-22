"""Annotation-color filtering and re-scoring for retrieved RAG chunks.

Companion to ``annotation_context.py``. Where that module *adds* annotation
text into the prompt, this module *filters and reweights* the pgvector
results so the LLM only sees chunks on pages the user highlighted with the
selected colors.

Inputs:
- A list of selected hex colors (e.g. ``["#ffd400", "#ff6666"]``)
- The document / collection scope of the request
- The user id (annotations are per-user)

Output:
- A ``ColorPageIndex`` mapping ``(document_id, page_index)`` -> max boost
  derived from the user's annotations of the selected colors.
- A helper that filters a ``list[Document]`` to chunks that fall on a
  page in the index and multiplies their ``score`` metadata by the
  per-color boost (highest boost wins when a page has annotations of
  several colors).

The boost table mirrors ``annotation_context.ANNOTATION_BOOST`` so the
two enrichment modes stay consistent.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
import json

from langchain_core.documents import Document

from src.main.grpc.clients.annotation_grpc_client import (
    get_collection_annotations,
    get_document_annotations,
)
from src.main.service.rag.annotation_context import ANNOTATION_BOOST
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


@dataclass
class ColorFilterResult:
    """Result of building the (doc_id, page_index) -> boost index.

    `index` is empty when no annotations match the filter — callers must
    treat an empty index as "drop everything", consistent with how a
    user-supplied filter that selects zero annotations should behave.
    """

    index: dict[tuple[str, int], float]
    matched_colors: set[str]
    matched_annotations: int


def _selected_text_page_index(annotation: dict) -> int | None:
    """Extract the (zero-based) page_index from an annotation's position_json."""
    raw = annotation.get("position_json")
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None
    page_index = parsed.get("page_index")
    if isinstance(page_index, int):
        return page_index
    if isinstance(page_index, str) and page_index.isdigit():
        return int(page_index)
    return None


def build_color_page_index(
    *,
    user_id: str,
    color_filter: Iterable[str],
    document_ids: list[str] | None,
    collection_id: str | None = None,
    max_annotations: int = 500,
) -> ColorFilterResult:
    """Fetch the user's annotations once and build the boost index.

    Annotations whose color is not in ``color_filter`` are skipped. When
    a page carries annotations of several matching colors we keep the
    highest boost — this rewards the most strongly weighted color
    without double-counting.
    """

    selected = {c.lower() for c in color_filter if c}
    if not selected or not user_id:
        return ColorFilterResult(index={}, matched_colors=set(), matched_annotations=0)

    annotations: list[dict] = []
    try:
        if collection_id:
            annotations = get_collection_annotations(
                collection_id=collection_id,
                user_id=user_id,
                max_results=max_annotations,
            )
            if document_ids:
                doc_set = set(document_ids)
                annotations = [a for a in annotations if a.get("document_id") in doc_set]
        elif document_ids:
            for doc_id in document_ids:
                annotations.extend(
                    get_document_annotations(
                        document_id=doc_id,
                        user_id=user_id,
                        max_results=max_annotations,
                    )
                )
    except Exception as exc:
        logger.warning("Color filter: failed to fetch annotations (%s); falling back to no-op", exc)
        return ColorFilterResult(index={}, matched_colors=set(), matched_annotations=0)

    index: dict[tuple[str, int], float] = {}
    matched_colors: set[str] = set()
    matched_count = 0
    for ann in annotations:
        color = (ann.get("color") or "").lower()
        if color not in selected:
            continue
        document_id = str(ann.get("document_id") or "")
        if not document_id:
            continue
        page_index = _selected_text_page_index(ann)
        if page_index is None:
            continue
        boost = ANNOTATION_BOOST.get(color, 1.0)
        key = (document_id, page_index)
        if boost > index.get(key, 0.0):
            index[key] = boost
        matched_colors.add(color)
        matched_count += 1

    return ColorFilterResult(index=index, matched_colors=matched_colors, matched_annotations=matched_count)


def _document_page(doc: Document) -> int | None:
    """Resolve the chunk's page index from common metadata shapes."""
    meta = doc.metadata or {}
    pos = meta.get("position_json")
    if isinstance(pos, dict):
        page = pos.get("page")
        if isinstance(page, int):
            return page - 1 if page > 0 else page
    page = meta.get("page")
    if isinstance(page, int):
        return page - 1 if page > 0 else page
    page_label = meta.get("page_label")
    if isinstance(page_label, str) and page_label.isdigit():
        return max(int(page_label) - 1, 0)
    return None


def _document_id(doc: Document) -> str | None:
    meta = doc.metadata or {}
    for key in ("document_id", "doc_id", "source_document_id"):
        value = meta.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def filter_and_rescore_documents(
    documents: list[Document],
    color_index: dict[tuple[str, int], float],
) -> list[Document]:
    """Drop documents whose (doc_id, page) is not in the index; multiply
    surviving scores by the page's boost.

    When ``color_index`` is empty, returns ``documents`` unchanged — this
    lets callers treat "no filter" and "filter built nothing" symmetrically
    by checking the index size before invoking us.
    """

    if not color_index:
        return documents

    out: list[Document] = []
    for doc in documents:
        doc_id = _document_id(doc)
        page = _document_page(doc)
        if doc_id is None or page is None:
            continue
        boost = color_index.get((doc_id, page))
        if boost is None:
            continue
        existing_score = float(doc.metadata.get("score") or 0.0)
        boosted = existing_score * boost if existing_score else boost
        new_meta = dict(doc.metadata)
        new_meta["score"] = boosted
        new_meta["annotation_color_boost"] = boost
        out.append(Document(page_content=doc.page_content, metadata=new_meta))

    out.sort(key=lambda d: float(d.metadata.get("score") or 0.0), reverse=True)
    return out
