"""
Per-page context extraction for the multimodal describer.

Fetches the surrounding-page chunk text from `langchain_pg_embedding`
so the vision / table / equation agents see why the figure exists, not
just what it looks like.

The window defaults to ±1 page around the element's `page_idx` and is
configured under `multimodal.context.window_pages`. The output text is
truncated to `multimodal.context.max_context_tokens * 4` characters
(rough chars-per-token estimate) so we never blow the LLM context.

Soft-fail design: any DB error returns `None` so the describer
falls back to "no context" mode and the agent uses its
`*_no_context` prompt.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from sqlalchemy import text as sa_text

from src.main.utils.config.loader import resolved_config

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def _context_config() -> dict:
    return ((resolved_config or {}).get("multimodal", {}) or {}).get("context", {}) or {}


def _window_pages() -> int:
    return max(0, int(_context_config().get("window_pages", 1)))


def _max_chars() -> int:
    # ~4 chars per token (English average). Cap at 8 KB so even a large
    # context window doesn't push the prompt past the 16 K-token mark.
    tokens = int(_context_config().get("max_context_tokens", 1500))
    return max(200, min(tokens * 4, 8000))


def extract_context(
    db: Session,
    *,
    document_id: str,
    page_idx: int | None,
) -> str | None:
    """Return the concatenated chunk text for pages [page-w, page+w].

    `page_idx` follows our internal 0-based convention (matches Docling's
    `prov[0].page_no - 1`); the chunk metadata stores 1-based `page`, so
    we convert at the SQL boundary.
    """

    if page_idx is None:
        return None

    window = _window_pages()
    if window <= 0:
        return None

    page_one_based = page_idx + 1
    pages = list(range(page_one_based - window, page_one_based + window + 1))
    pages = [p for p in pages if p >= 1]
    if not pages:
        return None

    try:
        rows = db.execute(
            sa_text(
                """
                SELECT (cmetadata->>'page')::int AS page,
                       (cmetadata->>'chunk_index')::int AS chunk_index,
                       document AS chunk_text
                FROM langchain_pg_embedding
                WHERE cmetadata->>'document_id' = :doc_id
                  AND (cmetadata->>'page')::int = ANY(:pages)
                ORDER BY page, chunk_index NULLS LAST
                """
            ),
            {"doc_id": str(document_id), "pages": pages},
        ).fetchall()
    except Exception as exc:
        logger.debug("Context extractor: DB read failed for %s: %s", document_id, exc)
        return None

    if not rows:
        return None

    cap = _max_chars()
    parts: list[str] = []
    used = 0
    for row in rows:
        page = row[0]
        body = (row[2] or "").strip()
        if not body:
            continue
        header = f"[page {page}]\n"
        chunk_text = header + body
        if used + len(chunk_text) > cap:
            remaining = cap - used
            if remaining > len(header) + 40:
                parts.append(chunk_text[:remaining])
            break
        parts.append(chunk_text)
        used += len(chunk_text)

    return "\n\n".join(parts) if parts else None
