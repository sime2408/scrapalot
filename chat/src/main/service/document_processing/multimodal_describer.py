"""
Drive the vision / table / equation description agents over all pending
rows of one document.

For each `multimodal_elements` row in `processing_status='pending'`:
- pick the appropriate Pydantic AI agent
- run it (vision agent gets binary content from disk; text agents get
  table markdown / LaTeX)
- write description, entity_name, entity_subtype, symbol_map back to
  the row, mark `processing_status='indexed'` (or 'failed' on agent
  failure).

Concurrency is bounded by `multimodal.concurrency` from config.yaml.
Failures on any single element never abort the document — the row is
marked `failed` and the next element runs.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import text as sa_text

from src.main.service.document_processing.multimodal_context_extractor import (
    extract_context,
)
from src.main.utils.config.loader import resolved_config

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def _multimodal_config() -> dict:
    return (resolved_config or {}).get("multimodal", {}) or {}


def _concurrency() -> int:
    return int(_multimodal_config().get("concurrency", 4))


def _images_enabled() -> bool:
    return bool(_multimodal_config().get("enable_image_processing", True))


def _tables_enabled() -> bool:
    return bool(_multimodal_config().get("enable_table_processing", True))


def _equations_enabled() -> bool:
    return bool(_multimodal_config().get("enable_equation_processing", True))


def _llm_timeout() -> float:
    return float(_multimodal_config().get("llm_call_timeout_seconds", 30))


async def describe_pending_for_document(
    db: Session,
    document_id: str | UUID,
) -> dict[str, int]:
    """Drive description for every pending row of one document.

    Returns a counters dict {described, failed, skipped} for callers
    that want to surface progress.
    """

    counters = {"described": 0, "failed": 0, "skipped": 0}

    rows = db.execute(
        sa_text(
            """
            SELECT id, element_type, page_idx, storage_path, content_text,
                   caption, footnotes, structured_data
            FROM multimodal_elements
            WHERE document_id = :doc_id AND processing_status = 'pending'
            ORDER BY element_type, element_index
            """
        ),
        {"doc_id": str(document_id)},
    ).fetchall()

    if not rows:
        return counters

    # Cache page context per page to avoid N redundant DB reads when
    # multiple elements share a page (very common for figure-heavy pages).
    page_context_cache: dict[int | None, str | None] = {}

    def _context_for_row(row) -> str | None:
        page_idx = row[2]
        if page_idx in page_context_cache:
            return page_context_cache[page_idx]
        ctx = extract_context(db, document_id=str(document_id), page_idx=page_idx)
        page_context_cache[page_idx] = ctx
        return ctx

    semaphore = asyncio.Semaphore(_concurrency())

    async def _bound(row) -> None:
        context = _context_for_row(row)
        async with semaphore:
            await _describe_one(db, row, counters, context=context)

    await asyncio.gather(*(_bound(r) for r in rows), return_exceptions=False)

    db.commit()
    logger.info(
        "Multimodal describer finished for %s: described=%d failed=%d skipped=%d",
        document_id,
        counters["described"],
        counters["failed"],
        counters["skipped"],
    )
    return counters


async def _describe_one(
    db: Session,
    row,
    counters: dict[str, int],
    *,
    context: str | None = None,
) -> None:
    element_id = row[0]
    element_type = row[1]
    storage_path = row[3]
    content_text = row[4]
    caption = row[5]
    footnotes = _json_loads(row[6])
    structured = _json_loads(row[7])

    db.execute(
        sa_text(
            """
            UPDATE multimodal_elements
               SET processing_status = 'describing',
                   updated_at = NOW()
             WHERE id = :id
            """
        ),
        {"id": element_id},
    )
    db.commit()

    info_payload: dict[str, Any] | None = None
    error_message: str | None = None

    try:
        if element_type == "image":
            if not _images_enabled() or not storage_path:
                counters["skipped"] += 1
                _mark_status(db, element_id, "indexed")
                return
            info = await asyncio.wait_for(
                _run_image_agent(storage_path, caption, footnotes, context=context),
                timeout=_llm_timeout(),
            )
            if info is None:
                counters["skipped"] += 1
                _mark_status(db, element_id, "indexed")
                return
            info_payload = info.model_dump()
        elif element_type == "table":
            if not _tables_enabled():
                counters["skipped"] += 1
                _mark_status(db, element_id, "indexed")
                return
            markdown = content_text or _table_struct_to_markdown(structured)
            info = await asyncio.wait_for(
                _run_table_agent(markdown, caption, footnotes, context=context),
                timeout=_llm_timeout(),
            )
            if info is None:
                counters["skipped"] += 1
                _mark_status(db, element_id, "indexed")
                return
            info_payload = info.model_dump()
        elif element_type == "equation":
            if not _equations_enabled() or not content_text:
                counters["skipped"] += 1
                _mark_status(db, element_id, "indexed")
                return
            info = await asyncio.wait_for(
                _run_equation_agent(content_text, context=context),
                timeout=_llm_timeout(),
            )
            if info is None:
                counters["skipped"] += 1
                _mark_status(db, element_id, "indexed")
                return
            info_payload = info.model_dump()
        else:
            counters["skipped"] += 1
            _mark_status(db, element_id, "failed", error="unknown element type")
            return
    except TimeoutError:
        error_message = f"timeout after {_llm_timeout()}s"
    except Exception as ex:  # pragma: no cover — agent libs throw varied
        error_message = f"{type(ex).__name__}: {ex}"

    if error_message is not None:
        counters["failed"] += 1
        _mark_status(db, element_id, "failed", error=error_message)
        return

    _persist_description(db, element_id, element_type, info_payload or {})
    counters["described"] += 1


async def _run_image_agent(storage_path: str, caption, footnotes, *, context: str | None = None):
    # Community Edition: advanced multimodal description agents are not bundled.
    return None


async def _run_table_agent(markdown: str, caption, footnotes, *, context: str | None = None):
    # Community Edition: advanced multimodal description agents are not bundled.
    return None


async def _run_equation_agent(latex: str, *, context: str | None = None):
    # Community Edition: advanced multimodal description agents are not bundled.
    return None


def _persist_description(db: Session, element_id, element_type: str, payload: dict) -> None:
    description = _build_description_text(element_type, payload)
    entity_name = payload.get("entity_name")
    entity_subtype = payload.get("entity_subtype")
    symbol_map = payload.get("symbol_map") if element_type == "equation" else None

    db.execute(
        sa_text(
            """
            UPDATE multimodal_elements
               SET description = :description,
                   entity_name = :entity_name,
                   entity_subtype = :entity_subtype,
                   symbol_map = CAST(:symbol_map AS JSONB),
                   structured_data = COALESCE(structured_data, '{}'::jsonb) || CAST(:agent_output AS JSONB),
                   processing_status = 'indexed',
                   processing_error = NULL,
                   described_at = NOW(),
                   updated_at = NOW()
             WHERE id = :id
            """
        ),
        {
            "id": element_id,
            "description": description,
            "entity_name": entity_name,
            "entity_subtype": entity_subtype,
            "symbol_map": json.dumps(symbol_map) if symbol_map else None,
            "agent_output": json.dumps(payload, default=str),
        },
    )
    db.commit()


def _mark_status(db: Session, element_id, status: str, *, error: str | None = None) -> None:
    db.execute(
        sa_text(
            """
            UPDATE multimodal_elements
               SET processing_status = :status,
                   processing_error = :error,
                   updated_at = NOW()
             WHERE id = :id
            """
        ),
        {"id": element_id, "status": status, "error": error},
    )
    db.commit()


def _build_description_text(element_type: str, payload: dict) -> str:
    parts: list[str] = []
    summary = payload.get("summary") or ""
    detail = payload.get("detailed_description") or ""
    parts.extend(p for p in (summary, detail) if p)

    if element_type == "table":
        trends = payload.get("trends") or []
        if trends:
            parts.append("Trends: " + " | ".join(trends))
        cols = payload.get("col_descriptions") or []
        col_summaries = [c.get("summary", "") for c in cols if c.get("summary")]
        if col_summaries:
            parts.append("Columns: " + " | ".join(col_summaries))
    elif element_type == "equation":
        domain = payload.get("application_domain")
        if domain:
            parts.append(f"Domain: {domain}.")
        symbol_map = payload.get("symbol_map") or {}
        if symbol_map:
            mapped = ", ".join(f"{k}={v}" for k, v in symbol_map.items())
            parts.append(f"Symbols: {mapped}.")

    return "\n\n".join(p for p in parts if p)


def _table_struct_to_markdown(structured: dict | None) -> str | None:
    if not structured:
        return None
    headers = structured.get("headers") or []
    rows = structured.get("rows") or []
    if not headers and not rows:
        return None
    lines = []
    if headers:
        lines.append("| " + " | ".join(headers) + " |")
        lines.append("| " + " | ".join(["---"] * len(headers)) + " |")
    for row in rows:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def _json_loads(value):
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None
