"""
OCR escalation gate: Docling/RapidOCR is the default; when it produces weak OCR
on a scanned PDF and an LLMWhisperer key is configured (within its daily page
budget), escalate that document to LLMWhisperer for a cleaner layout-preserving
extraction.

INERT without a key — :func:`maybe_escalate_ocr` returns ``None`` so the caller
keeps the Docling/RapidOCR output and nothing changes.
"""

from __future__ import annotations

from datetime import UTC, datetime

from src.main.service.document.ocr import llm_whisperer_client as lw
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_BUDGET_KEY_PREFIX = "scrapalot:llmwhisperer:budget:"


def _cfg() -> dict:
    return resolved_config.get("document_processing", {}).get("ocr_escalation", {}) or {}


def _as_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _reserve_budget(pages: int) -> bool:
    """Atomically reserve ``pages`` against today's LLMWhisperer page budget.
    Best-effort via Redis (shared across workers); on Redis failure, allow (the
    key gate + the provider's own limit still bound usage)."""
    budget = int(_cfg().get("daily_page_budget", 100))
    if pages > budget:
        return False
    try:
        from src.main.utils.redis.client import get_redis_client

        redis = get_redis_client()
        day = datetime.now(UTC).strftime("%Y-%m-%d")
        key = f"{_BUDGET_KEY_PREFIX}{day}"
        used = redis.incrby(key, pages)
        redis.expire(key, 60 * 60 * 48)
        if used > budget:
            redis.decrby(key, pages)  # roll back the over-reservation
            return False
        return True
    except Exception as e:
        logger.debug("LLMWhisperer budget check unavailable (%s) — allowing", e)
        return True


def maybe_escalate_ocr(
    file_path: str,
    current_docs: list,
    page_count: int,
    db=None,
    user_id: str | None = None,
    metadata_file_path: str | None = None,
    job_id: str | None = None,
    progress_callback=None,
) -> list | None:
    """Escalate to LLMWhisperer when the default OCR is weak and a key is set.

    Returns chunked LangChain documents built from the LLMWhisperer extraction, or
    ``None`` to keep ``current_docs`` (the default OCR output). Never raises.
    """
    if not lw.is_configured():
        return None
    try:
        # Only escalate when the default OCR genuinely under-extracted.
        min_cpp = int(_cfg().get("min_chars_per_page", 80))
        cur_chars = sum(len(d.page_content or "") for d in (current_docs or []))
        if page_count > 0 and (cur_chars / page_count) >= min_cpp:
            return None  # default OCR is good enough

        if not _reserve_budget(page_count):
            logger.info("LLMWhisperer daily budget exhausted — keeping default OCR for %s", file_path)
            return None

        pages = lw.extract_pages(file_path)
        if not pages:
            return None

        # Drop empty/whitespace segments first: layout_preserving output can emit
        # leading/trailing/blank separators, so the raw split count overshoots the
        # real page count. Renumber sequentially over the non-empty pages.
        clean = [t for t in pages if t and t.strip()]
        if not clean:
            return None

        from langchain_core.documents import Document as LangchainDocument

        # Return PAGE-LEVEL documents (one per page), exactly like the RapidOCR
        # fallback — downstream chunks them. Metadata mirrors
        # `_process_pdf_with_rapidocr` so the Neo4j strict-metadata validator
        # accepts the doc (single implicit chapter, one section per page).
        meta_path = metadata_file_path or file_path
        total = len(clean)
        page_docs = [
            LangchainDocument(
                page_content=txt,
                metadata={
                    "source": meta_path,
                    "file_path": meta_path,
                    "page_number": i,
                    "page": i,
                    "total_pages": total,
                    "extraction_method": "llmwhisperer",
                    "chapter_number": 1,
                    "chapter_title": "Document",
                    "section_title": f"Page {i}",
                    "section_id": f"page_{i}",
                },
            )
            for i, txt in enumerate(clean, start=1)
        ]
        chars = sum(len(d.page_content or "") for d in page_docs)
        logger.info("Escalated scanned PDF '%s' to LLMWhisperer: %d pages, %d chars", file_path, total, chars)
        return page_docs
    except Exception as e:  # never break the OCR path
        logger.warning("OCR escalation failed for %s: %s — keeping default OCR", file_path, e)
        return None
