"""
Shadow parser-comparison harness.

For a document, parse it with every available backend, score each
deterministically (book-first), pick a winner, and record one row per parser in
``parser_comparisons``. Production still chunks the pymupdf4llm output — this
only *observes*. Once enough rows accumulate, a statistical query decides whether
to flip the production parser.

Best-effort: never raises into the ingestion pipeline. Gated by config so it
can be enabled gradually and bounded by page count / sample rate (it re-parses,
which for a large PDF re-pays the pymupdf cost).
"""

from __future__ import annotations

import hashlib
import re
import threading
from uuid import UUID

from sqlalchemy import delete
from sqlalchemy.orm import Session

from src.main.models.sqlmodel_parser_comparison import ParserComparison
from src.main.service.document.parsers.parser_registry import available_parsers
from src.main.service.document.parsers.parser_scorer import score_all
from src.main.service.document.parsers.pdf_parser_base import ParsedDocument
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Below this non-whitespace chars/page, every text parser is effectively empty —
# a scanned/image PDF that belongs to the OCR path, not this comparison.
_MIN_NONWS_PER_PAGE = 80

# Reuse stash: production parses the PDF with pymupdf4llm once anyway; it stashes
# the resulting ParsedDocument here so the shadow comparison can reuse it instead
# of re-paying the ~90s pymupdf parse. Keyed by file path, popped by the hook that
# runs in the same task. Module-global + lock (NOT contextvars) per project async
# guidance; concurrent workers process distinct file paths so keys don't collide.
_PRODUCTION_STASH: dict[str, ParsedDocument] = {}
_STASH_LOCK = threading.Lock()


def stash_production_parse(file_path: str, parsed: ParsedDocument) -> None:
    """Production calls this (only when shadow is enabled) with its already-parsed
    pymupdf output so the comparison can reuse it. Bounded to avoid leaks."""
    with _STASH_LOCK:
        if len(_PRODUCTION_STASH) > 64:
            _PRODUCTION_STASH.clear()
        _PRODUCTION_STASH[file_path] = parsed


def _pop_production_parse(file_path: str) -> dict[str, ParsedDocument]:
    with _STASH_LOCK:
        parsed = _PRODUCTION_STASH.pop(file_path, None)
    return {parsed.parser_name: parsed} if parsed is not None and parsed.ok else {}


def _cfg() -> dict:
    return resolved_config.get("document_processing", {}).get("parser_comparison", {}) or {}


def _as_bool(value: object, default: bool = False) -> bool:
    """Robustly coerce a config value to bool. Env-substituted YAML values arrive
    as STRINGS (``${VAR:-false}`` -> ``"false"``), so plain ``bool()`` would treat
    ``"false"`` as truthy."""
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def is_enabled() -> bool:
    """Feature flag ``document_processing.parser_comparison.enabled`` (default off)."""
    return _as_bool(_cfg().get("enabled"), default=False)


def should_compare(file_path: str, page_count: int | None) -> bool:
    """Cost gate: enabled + within the page cap + selected by the sample rate.

    Sampling is deterministic per file path (hash) so re-runs of the same doc are
    stable and the sample is reproducible.
    """
    if not is_enabled():
        return False
    cfg = _cfg()
    max_pages = int(cfg.get("max_pages", 600))
    if page_count is not None and page_count > max_pages:
        return False
    sample_rate = float(cfg.get("sample_rate", 1.0))
    if sample_rate >= 1.0:
        return True
    bucket = int(hashlib.sha256(file_path.encode()).hexdigest(), 16) % 1000
    return bucket < int(sample_rate * 1000)


def _expected_chapters(file_path: str) -> int:
    """Parser-independent chapter count from the raw PDF (the structure ground truth).

    Uses only the DETERMINISTIC tiers (PDF bookmarks, then font-size analysis) and
    deliberately skips the LLM tier of ``detect_chapters`` — the ground truth must
    be reproducible (a deterministic scorer can't depend on an LLM), and it keeps
    each shadow comparison cheap (no per-doc LLM call)."""
    try:
        from src.main.service.document.pdf_chapter_detector import PDFChapterDetector

        chapters = PDFChapterDetector._detect_from_toc(file_path) or PDFChapterDetector._detect_from_font_size(file_path)
        return len(chapters or [])
    except Exception as e:
        logger.debug("expected_chapters detection failed for %s: %s", file_path, e)
        return 0


def run_comparison(document_id: UUID, file_path: str, db: Session) -> str | None:
    """Parse with all backends, score, persist, return the winning parser name.

    Returns ``None`` and records nothing if no backend produced usable output.
    """
    parsers = available_parsers()
    if len(parsers) < 2:
        logger.info("parser comparison skipped — only %d backend(s) available", len(parsers))
        return None

    # Reuse the production parse (pymupdf4llm) if it was stashed this task — that's
    # the expensive one; only the remaining backends (liteparse, ~1s) parse fresh.
    parsed = _pop_production_parse(file_path)
    reused = set(parsed.keys())
    for p in parsers:
        if p.name not in parsed:
            parsed[p.name] = p.parse(file_path)
    if reused:
        logger.debug("parser comparison reused production parse for %s: %s", document_id, reused)

    # Scanned/image-only PDFs yield ~0 extractable text from every text parser —
    # that's an OCR (Docling/RapidOCR) job, not a text-parser comparison. Skip so
    # such docs don't pollute the stats with degenerate near-empty ties.
    def _nonws_per_page(doc) -> float:
        return len(re.sub(r"\s+", "", doc.full_text)) / max(doc.page_count, 1)

    if max((_nonws_per_page(d) for d in parsed.values()), default=0.0) < _MIN_NONWS_PER_PAGE:
        logger.info("parser comparison skipped for %s — scanned/empty PDF (route to OCR)", document_id)
        return None

    expected = _expected_chapters(file_path)
    scores = score_all(parsed, expected)
    if not scores:
        return None

    winner = max(scores, key=lambda s: s.total)
    winner_name = winner.parser_name if winner.total > 0 else None

    # Replace any prior comparison for this doc (reprocess-safe).
    db.execute(delete(ParserComparison).where(ParserComparison.document_id == document_id))
    for s in scores:
        m = s.metrics
        db.add(
            ParserComparison(
                document_id=document_id,
                parser_name=s.parser_name,
                is_winner=(s.parser_name == winner_name),
                expected_chapters=expected,
                total_score=s.total,
                structure_score=s.structure,
                completeness_score=s.completeness,
                cleanliness_score=s.cleanliness,
                page_count=m.get("page_count"),
                char_count=m.get("char_count"),
                header_count=m.get("header_count"),
                br_count=m.get("br_count"),
                parse_ms=m.get("parse_ms"),
                metrics_json=m,
                error=m.get("error"),
            )
        )
    db.commit()
    logger.info(
        "parser comparison for %s: winner=%s scores=%s",
        document_id,
        winner_name,
        {s.parser_name: s.total for s in scores},
    )
    return winner_name
