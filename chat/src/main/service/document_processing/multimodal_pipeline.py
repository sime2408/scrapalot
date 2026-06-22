"""
Multimodal element pipeline.

Phase A — extract: walk a Docling document and produce one draft per
non-text element. Implemented in `multimodal_extractor`.

Phase B — persist: write drafts as `multimodal_elements` rows + re-encode
images to disk. Implemented in `multimodal_persister`.

Phase C — describe (vision LLM, sub-entity extraction): future, lives
in this file once the agents under `service/agents/multimodal/` ship.

The worker task calls this pipeline once per ingested document.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING
from uuid import UUID

from src.main.service.document_processing.multimodal_extractor import (
    MultimodalElementDraft,
    extract_multimodal_elements,
)
from src.main.service.document_processing.multimodal_persister import persist_drafts
from src.main.utils.config.loader import resolved_config

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def _multimodal_config() -> dict:
    return (resolved_config or {}).get("multimodal", {}) or {}


def is_multimodal_enabled() -> bool:
    cfg = _multimodal_config()
    return bool(cfg.get("enabled", True))


def run_extract_and_persist(
    db: Session,
    document_id: str | UUID,
    docling_document,
) -> list[UUID]:
    """End-to-end Phase A + B for one document.

    No-op + early return when `multimodal.enabled=false` or the Docling
    document is None. Errors during extract/persist are logged and
    swallowed so they never fail the parent ingest task.
    """

    if not is_multimodal_enabled():
        return []
    if docling_document is None:
        return []

    cfg = _multimodal_config()
    try:
        drafts = extract_multimodal_elements(
            docling_document,
            enable_images=bool(cfg.get("enable_image_processing", True)),
            enable_tables=bool(cfg.get("enable_table_processing", True)),
            enable_equations=bool(cfg.get("enable_equation_processing", True)),
            detect_inline_latex=bool(cfg.get("equation", {}).get("detect_inline_latex", True)),
            skip_dollar_currency=bool(cfg.get("equation", {}).get("skip_dollar_currency", True)),
            max_elements=int(cfg.get("max_elements_per_document", 100)),
        )
    except Exception as ex:
        logger.warning("Multimodal extraction failed for %s: %s", document_id, ex)
        return []

    if not drafts:
        return []

    try:
        return persist_drafts(db, document_id, drafts)
    except Exception as ex:
        logger.warning("Multimodal persistence failed for %s: %s", document_id, ex)
        return []


def collect_drafts(docling_document) -> list[MultimodalElementDraft]:
    """Pure Phase A — useful when the caller wants to handle persistence
    separately (e.g. in tests, or when the Document row doesn't exist yet)."""

    if not is_multimodal_enabled() or docling_document is None:
        return []
    cfg = _multimodal_config()
    return extract_multimodal_elements(
        docling_document,
        enable_images=bool(cfg.get("enable_image_processing", True)),
        enable_tables=bool(cfg.get("enable_table_processing", True)),
        enable_equations=bool(cfg.get("enable_equation_processing", True)),
        detect_inline_latex=bool(cfg.get("equation", {}).get("detect_inline_latex", True)),
        skip_dollar_currency=bool(cfg.get("equation", {}).get("skip_dollar_currency", True)),
        max_elements=int(cfg.get("max_elements_per_document", 100)),
    )


def describe_pending(db: Session, document_id: str | UUID, loop=None) -> dict[str, int]:
    """Synchronous wrapper over describe_pending_for_document for callers
    that already own an event loop (Celery worker tasks) or want to fire
    a quick describe pass inline.

    After description finishes, this function also runs the Neo4j sync
    pass so newly-described elements land in the knowledge graph.

    Returns counters dict; never raises — failures are logged."""

    if not is_multimodal_enabled():
        return {"described": 0, "failed": 0, "skipped": 0}

    import asyncio

    from src.main.service.document_processing.multimodal_describer import (
        describe_pending_for_document,
    )

    try:
        if loop is not None:
            counters = loop.run_until_complete(describe_pending_for_document(db, document_id))
        else:
            counters = asyncio.run(describe_pending_for_document(db, document_id))
    except Exception as ex:
        logger.warning("describe_pending failed for %s: %s", document_id, ex)
        return {"described": 0, "failed": 0, "skipped": 0}

    try:
        from src.main.service.document_processing.multimodal_graph_sync import (
            sync_described_to_neo4j,
        )

        synced = sync_described_to_neo4j(db, document_id)
        counters["graph_synced"] = synced
    except Exception as ex:
        logger.warning("Neo4j sync after describe failed for %s: %s", document_id, ex)

    return counters
