"""
Helpers that compute per-chunk position metadata for citation highlighting.

A chunk's `position_json` carries:
    {
      "page": int,
      "char_offset_start": int,   # offset of the chunk inside the page text
      "char_offset_end": int,
      "bbox": [x0, y0, x1, y1] | None,  # page-level union (best effort)
    }

The chunk's text rarely lines up with a single bounding box (it spans
multiple spans / paragraphs), so we ship the page-level union and
char-offsets — enough for the PDF viewer to (a) jump to the page and
(b) text-search the chunk inside the page to draw a precise highlight.
"""

from __future__ import annotations

from typing import Any


def page_bbox_from_docling_page(page: Any) -> list[float] | None:
    """Return [x0, y0, x1, y1] for a Docling `PageItem` if available."""
    size = getattr(page, "size", None)
    if size is None:
        return None
    width = getattr(size, "width", None)
    height = getattr(size, "height", None)
    if width is None or height is None:
        return None
    return [0.0, 0.0, float(width), float(height)]


def page_bbox_from_pymupdf_metadata(page_metadata: dict[str, Any]) -> list[float] | None:
    """PyMuPDF4LLM page metadata may carry width/height — return a page bbox."""
    width = page_metadata.get("width") or page_metadata.get("page_width")
    height = page_metadata.get("height") or page_metadata.get("page_height")
    if width is None or height is None:
        return None
    try:
        return [0.0, 0.0, float(width), float(height)]
    except (TypeError, ValueError):
        return None


def chunk_position_json(
    *,
    page: int | None,
    page_text: str,
    chunk_text: str,
    page_bbox: list[float] | None,
    fallback_offset: int = 0,
) -> dict[str, Any]:
    """Compute the position_json payload for one chunk.

    `fallback_offset` is the offset of the chunk's first character within
    the page text in case `text.find` returns -1 (which happens when the
    chunker normalizes whitespace or strips formatting). The caller can
    pass the running cumulative-offset estimate so the value is monotone.
    """

    if not chunk_text:
        char_start = fallback_offset
        char_end = fallback_offset
    else:
        # Most chunkers leave the chunk text contiguous in the source.
        # Start the search at `fallback_offset` so duplicated snippets
        # (e.g. pull-quotes that appear once as an epigraph in the front
        # matter AND again as the body's actual citation, or repeated
        # boilerplate like "The Book of Aquarius By Anonymous" headers)
        # don't snap every later chunk back to the FIRST occurrence —
        # which is what a bare `.find(snippet)` does. Without this gate
        # a chunk whose body lives at char 282k can be stamped with
        # char_start=35k and the downstream position-based chapter
        # assigner attributes it to the wrong chapter. Canonical case:
        # The Book of Aquarius (b86fd27e) — Bacon's "New Atlantis" quote
        # ("Wherein we find many strange effects…") appears at char
        # 35273 (epigraph), 282083 (ch=32 Takwin body) and 354562
        # (ch=41 Francis Bacon body); chunks 74 and 75 belong to ch=32
        # but `.find()` returned the epigraph offset, misattributing
        # them to ch=5. Falling back to a full-text search only when
        # the monotone search misses keeps behaviour identical for the
        # common no-duplicate case.
        snippet = chunk_text[: min(len(chunk_text), 80)]
        idx = -1
        if snippet:
            search_from = fallback_offset if 0 <= fallback_offset <= len(page_text) else 0
            idx = page_text.find(snippet, search_from)
            if idx < 0 and search_from > 0:
                # Monotone search miss: fall back to a full-text scan.
                # page_text whitespace normalisation or chunker stripping
                # can cause the snippet to land slightly before
                # fallback_offset; preserving the original `.find` as
                # fallback keeps non-duplicate cases unchanged.
                idx = page_text.find(snippet)
        if idx < 0:
            char_start = fallback_offset
            char_end = fallback_offset + len(chunk_text)
        else:
            char_start = idx
            char_end = idx + len(chunk_text)

    return {
        "page": page,
        "char_offset_start": char_start,
        "char_offset_end": char_end,
        "bbox": page_bbox,
    }
