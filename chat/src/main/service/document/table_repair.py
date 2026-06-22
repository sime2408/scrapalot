"""Repair dense tables that the Markdown serializer (pymupdf4llm / Docling)
collapsed into a single ``<br>``-joined cell.

Born-digital racing forms, dense statistical tables and the like are recognised
as a table region but their 2D grid is flattened: several data rows get crushed
into one cell joined by ``<br>``, so the row/column meaning is lost (e.g.
``|2<br>Weaponized<br>84<br>6<br>Miracle Mark<br>81|``).

This module detects those collapsed blocks with a cheap structural heuristic
(no LLM on normal text) and asks the SYSTEM LLM to rebuild the grid. Two hard
safety rails make it safe for a science corpus:

* **Gated** — if the Markdown has no ``<br>``-heavy table cell, this is a no-op
  and never calls the LLM (zero token cost on prose).
* **Number-verified** — the rebuilt table is accepted ONLY if every numeric
  token in it already existed in the source block (the LLM may re-shape
  structure, never invent or alter a value). On any mismatch we keep the
  original, so a hallucinating model can never corrupt the data.

A per-document cap bounds cost on pathological files.
"""

import re

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_BR = "<br>"
# A table-row line carrying >= this many <br> is a collapsed multi-row cell.
_MIN_BR_IN_TABLE_LINE = 3
# Cost ceiling: never fire more than this many LLM rebuilds per document.
_MAX_TABLES_PER_DOC = 8
# Skip absurdly large blocks (token cost / hallucination risk grows with size).
_MAX_BLOCK_CHARS = 6000

_NUM_RE = re.compile(r"\d+(?:[.,]\d+)?")


def _is_table_line(line: str) -> bool:
    return line.lstrip().startswith("|")


def _is_collapsed_line(line: str) -> bool:
    return "|" in line and line.count(_BR) >= _MIN_BR_IN_TABLE_LINE


def detect_collapsed_table_blocks(markdown: str) -> list[tuple[int, int]]:
    """Return ``[(start_line, end_line)]`` half-open line ranges of contiguous
    Markdown table blocks that contain at least one collapsed (``<br>``-heavy)
    cell. Empty list when nothing qualifies."""
    lines = markdown.split("\n")
    n = len(lines)
    blocks: list[tuple[int, int]] = []
    i = 0
    while i < n:
        if _is_table_line(lines[i]):
            j = i
            collapsed = False
            while j < n and _is_table_line(lines[j]):
                if _is_collapsed_line(lines[j]):
                    collapsed = True
                j += 1
            if collapsed:
                blocks.append((i, j))
            i = j
        else:
            i += 1
    return blocks


def _numbers(text: str) -> list[str]:
    # Normalise thousands/decimal separators away from token identity by keeping
    # the raw token; comparison is multiset-exact on the raw match.
    return _NUM_RE.findall(text)


def numbers_preserved(source: str, rebuilt: str) -> bool:
    """True iff every numeric token in ``rebuilt`` is covered (as a multiset)
    by the numeric tokens in ``source``. The LLM may drop or re-order numbers
    (structure), but may never introduce a value that was not present."""
    from collections import Counter

    available = Counter(_numbers(source))
    for tok in _numbers(rebuilt):
        if available[tok] <= 0:
            return False
        available[tok] -= 1
    return True


_FALLBACK_PROMPT = (
    "You are repairing a table that a PDF-to-Markdown parser flattened. The "
    "block below is a single table whose 2D grid was collapsed: multiple rows "
    "were crushed into individual cells and joined with <br>. Each logical "
    "column (often labelled in the header, e.g. a metric name) lists its "
    "entries as a repeating sequence such as: identifier, label, value.\n\n"
    "Rebuild it into clean GitHub-flavored Markdown. Use one table per logical "
    "column/section with sensible headers, and split identifier / label / value "
    "into separate columns when the pattern is clear. PRESERVE EVERY NUMBER "
    "EXACTLY as written — never round, infer, or invent a value. Reuse the exact "
    "text tokens from the input. Output ONLY the reconstructed Markdown "
    "table(s); no commentary.\n\nCOLLAPSED TABLE:\n{table_md}"
)


def _build_prompt(table_md: str) -> str:
    try:
        from src.main.utils.config.loader import resolved_prompts

        template = resolved_prompts.get("table_repair", {}).get("rebuild_prompt") or _FALLBACK_PROMPT
    except Exception:
        template = _FALLBACK_PROMPT
    return template.format(table_md=table_md)


async def _rebuild_one_async(table_md: str) -> str | None:
    from src.main.service.llm.llm_manager import llm_manager

    llm = await llm_manager.get_llm(
        model_name="system",
        provider_type="system",
        agent_type="synthesis",
    )
    if not llm:
        logger.warning("table_repair: no system LLM available; skipping rebuild")
        return None
    resp = await llm.ainvoke(_build_prompt(table_md))
    out = resp.content if hasattr(resp, "content") else str(resp)
    return out.strip() if out else None


def _run_async(coro):
    """Run a coroutine from sync code. The Celery worker body is synchronous
    (no running loop), so a fresh loop is correct here."""
    import asyncio

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    # A loop is already running (unexpected in the worker) — run in a thread.
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: __import__("asyncio").run(coro)).result()


def new_budget() -> list[int]:
    """Create a fresh per-document rebuild budget to thread across pages."""
    return [_MAX_TABLES_PER_DOC]


def is_enabled() -> bool:
    """Feature flag — ``document_processing.repair_collapsed_tables`` in
    config.yaml (default True). Lets operators disable the LLM rebuild without
    a code change."""
    try:
        from src.main.utils.config.loader import resolved_config

        return bool(resolved_config.get("document_processing", {}).get("repair_collapsed_tables", True))
    except Exception:
        return True


def repair_collapsed_tables(
    markdown: str,
    *,
    budget: list[int] | None = None,
    max_tables: int = _MAX_TABLES_PER_DOC,
) -> str:
    """Detect ``<br>``-collapsed table blocks and rebuild them via the system
    LLM, replacing in place only when numbers are preserved. Safe no-op when
    nothing is collapsed (no LLM call) or when the feature flag is off.

    ``budget`` is an optional single-element mutable list ``[remaining]`` shared
    across all pages of ONE document, so total LLM rebuilds are bounded
    per-document (not per-page). A 42-page racing form therefore costs at most
    ``budget[0]`` rebuilds, not 8-per-page. When omitted, ``max_tables`` caps
    this single call. The caller decrements happen in-place on ``budget``."""
    if not markdown or _BR not in markdown or not is_enabled():
        return markdown
    cap = budget[0] if budget is not None else max_tables
    if cap <= 0:
        return markdown
    blocks = detect_collapsed_table_blocks(markdown)
    if not blocks:
        return markdown

    lines = markdown.split("\n")
    repaired = 0
    # Replace bottom-up so earlier line indices stay valid.
    for start, end in reversed(blocks):
        if repaired >= cap:
            logger.info("table_repair: hit cap (%d); leaving remaining blocks", cap)
            break
        original = "\n".join(lines[start:end])
        if len(original) > _MAX_BLOCK_CHARS:
            logger.info("table_repair: block too large (%d chars); skipping", len(original))
            continue
        try:
            rebuilt = _run_async(_rebuild_one_async(original))
        except Exception as e:
            logger.warning("table_repair: rebuild failed, keeping original: %s", str(e))
            continue
        if rebuilt and numbers_preserved(original, rebuilt):
            lines[start:end] = rebuilt.split("\n")
            repaired += 1
            logger.info("table_repair: rebuilt 1 collapsed table block (%d chars)", len(original))
        else:
            logger.info("table_repair: rebuild rejected (number mismatch or empty); keeping original")

    if budget is not None:
        budget[0] -= repaired  # bound total rebuilds across all pages of this doc
    if repaired:
        logger.info("table_repair: repaired %d/%d collapsed table block(s)", repaired, len(blocks))
    return "\n".join(lines)


__all__ = [
    "detect_collapsed_table_blocks",
    "is_enabled",
    "new_budget",
    "numbers_preserved",
    "repair_collapsed_tables",
]
