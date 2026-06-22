"""Auto-Metadata Enrichment Pipeline.

Orchestrates identifier extraction, external API resolution, caching,
and document record updates. Called as a fire-and-forget background task
during document processing so it never blocks chunking/embedding.

Resolution priority (matching Zotero): arXiv -> DOI -> ISBN -> PMID.
"""

import asyncio
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text

from src.main.service.metadata.identifier_extractor import ExtractedIdentifiers, extract_identifiers
from src.main.service.metadata.metadata_resolver import ResolvedMetadata, resolve_from_identifiers
from src.main.service.metadata.resolver_cache import get_cached_metadata, set_cached_metadata
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def _is_enrichment_enabled() -> bool:
    """Check whether auto-enrichment is enabled in config.yaml."""
    # noinspection PyBroadException
    try:
        from src.main.utils.config.loader import resolved_config

        doc_cfg = resolved_config.get("document_processing", {})
        metadata_cfg = doc_cfg.get("metadata_extraction", {})
        return metadata_cfg.get("enabled", True)
    except Exception:
        return True


def _already_enriched(extracted_metadata: dict | None) -> bool:
    """Return True if the document already has resolver-sourced metadata."""
    if not extracted_metadata:
        return False
    status = extracted_metadata.get("enrichment_status")
    return status in ("resolved",)


async def _resolve_with_cache(identifiers: ExtractedIdentifiers) -> ResolvedMetadata | None:
    """
    Attempt resolution using the Redis cache first, then fall back to
    live API calls. Caches successful results.

    Resolution priority: arXiv -> DOI -> ISBN -> PMID (matching Zotero).
    """
    # Build ordered list of (type, value) pairs following Zotero priority
    candidates = []
    if identifiers.arxiv_ids:
        candidates.append(("arxiv", identifiers.arxiv_ids[0]))
    if identifiers.dois:
        candidates.append(("doi", identifiers.dois[0]))
    if identifiers.isbns:
        candidates.append(("isbn", identifiers.isbns[0]))
    if identifiers.pmids:
        candidates.append(("pmid", identifiers.pmids[0]))

    # Try cache first for each candidate
    for id_type, id_value in candidates:
        cached = get_cached_metadata(id_type, id_value)
        if cached is not None:
            logger.info("Using cached metadata for %s:%s", id_type, id_value)
            return cached

    # No cache hit — call live resolvers (priority order handled by resolve_from_identifiers)
    result = await resolve_from_identifiers(
        dois=identifiers.dois,
        isbns=identifiers.isbns,
        pmids=identifiers.pmids,
        arxiv_ids=identifiers.arxiv_ids,
    )

    # Cache the successful result
    if result is not None:
        # Determine the primary identifier that was resolved
        if result.arxiv_id and identifiers.arxiv_ids:
            set_cached_metadata("arxiv", identifiers.arxiv_ids[0], result)
        elif result.doi and identifiers.dois:
            set_cached_metadata("doi", identifiers.dois[0], result)
        elif result.isbn and identifiers.isbns:
            set_cached_metadata("isbn", identifiers.isbns[0], result)
        elif result.pmid and identifiers.pmids:
            set_cached_metadata("pmid", identifiers.pmids[0], result)

    return result


def _check_already_enriched(document_id: str) -> bool:
    """Check if a document is already enriched (sync, meant for asyncio.to_thread)."""
    from src.main.config.database import SessionLocal

    db = SessionLocal()
    try:
        from src.main.models.sqlmodel_models import Document

        # noinspection PyTypeChecker
        doc = db.query(Document).filter(Document.id == UUID(document_id)).first()
        return doc is not None and _already_enriched(doc.extracted_metadata)
    finally:
        db.close()


def _update_document_record(document_id: str, metadata: ResolvedMetadata) -> None:
    """
    Persist resolved metadata into the documents table.

    Updates:
      - documents.extracted_metadata (JSON column) with the full resolved metadata
      - documents.title if the resolved title is more informative than the current one
    """
    from src.main.config.database import SessionLocal

    db = SessionLocal()
    try:
        from src.main.models.sqlmodel_models import Document

        # noinspection PyTypeChecker
        doc = db.query(Document).filter(Document.id == UUID(document_id)).first()
        if doc is None:
            logger.warning("Document %s not found for metadata update", document_id)
            return

        # Build nested structure expected by frontend:
        # { "resolved": {...}, "identifiers": {...}, "enrichment_status": "resolved", "enriched_at": "..." }
        resolved_data = metadata.to_dict()
        # Extract identifier fields into a separate "identifiers" key
        identifier_keys = ("doi", "isbn", "pmid", "arxiv_id", "issn")
        identifiers = {k: resolved_data.pop(k) for k in identifier_keys if k in resolved_data}
        # Remove internal fields from the resolved block
        resolved_data.pop("source", None)
        resolved_data.pop("confidence", None)

        enrichment_data = {
            "resolved": resolved_data,
            "identifiers": identifiers,
            "enrichment_status": "resolved",
            "enrichment_source": metadata.source,
            "enrichment_confidence": metadata.confidence,
            "enriched_at": datetime.now(UTC).isoformat(),
        }

        if doc.extracted_metadata and isinstance(doc.extracted_metadata, dict):
            # Preserve existing keys, overlay enrichment data
            merged = {**doc.extracted_metadata, **enrichment_data}
        else:
            merged = enrichment_data

        doc.extracted_metadata = merged

        # Update title if the resolved title is better than the current one
        if metadata.title and _is_better_title(metadata.title, doc.title, doc.filename):
            old_title = doc.title
            doc.title = metadata.title
            logger.info(
                "Updated document %s title: '%s' -> '%s' (source: %s)",
                document_id,
                old_title,
                metadata.title,
                metadata.source,
            )

        # Auto-rename filename after enrichment
        try:
            from src.main.utils.documents.utils import build_enriched_filename

            # noinspection PyUnresolvedReferences
            original_ext = doc.filename.rsplit(".", 1)[-1] if "." in doc.filename else "pdf"
            new_filename = build_enriched_filename(
                metadata.authors,
                metadata.year,
                metadata.title,
                original_ext,
            )
            if new_filename and new_filename != doc.filename:
                old_filename = doc.filename
                doc.filename = new_filename
                logger.info("Auto-renamed document %s: '%s' -> '%s'", document_id, old_filename, new_filename)
        except Exception as rename_err:
            logger.warning("Auto-rename failed for document %s: %s", document_id, rename_err)

        db.commit()
        logger.info(
            "Stored enriched metadata for document %s (source: %s, confidence: %.2f)",
            document_id,
            metadata.source,
            metadata.confidence,
        )

        # Auto-tag from CrossRef keywords
        if metadata.keywords:
            try:
                from src.main.service.document.tag_service import auto_tag_from_keywords

                # Get workspace_id from collection_workspace_map
                ws_row = db.execute(
                    text("SELECT workspace_id, owner_user_id FROM collection_workspace_map WHERE collection_id = :cid LIMIT 1"),
                    {"cid": str(doc.collection_id)},
                ).fetchone()
                if ws_row:
                    ws_id = str(ws_row[0])
                    owner_id = str(ws_row[1])
                    count = auto_tag_from_keywords(db, document_id, owner_id, ws_id, metadata.keywords)
                    if count > 0:
                        logger.info("Auto-tagged document %s with %d keywords from %s", document_id, count, metadata.source)
            except Exception as tag_err:
                logger.warning("Auto-tagging failed for document %s: %s", document_id, tag_err)
    except Exception as e:
        db.rollback()
        logger.error("Failed to update document %s with enriched metadata: %s", document_id, e)
    finally:
        db.close()


def _is_better_title(_resolved_title: str, current_title: str | None, filename: str | None) -> bool:
    """
    Decide whether the resolver-provided title should replace the current one.

    A resolved title is considered better when the current title is:
      - missing or empty
      - identical to the filename (minus extension)
      - a generic placeholder (e.g., 'Document', 'Untitled', 'N/A')
    """
    if not current_title or not current_title.strip():
        return True

    current_lower = current_title.strip().lower()

    # Generic/placeholder titles
    generic = {"document", "untitled", "n/a", "unknown", "no title"}
    if current_lower in generic:
        return True

    # Title is just the filename (with or without extension)
    if filename:
        import os

        stem = os.path.splitext(filename)[0].lower().replace("_", " ").replace("-", " ")
        if current_lower == stem or current_lower == filename.lower():
            return True

    return False


async def enrich_document_metadata(document_id: str, extracted_text: str, force_refresh: bool = False) -> None:
    """
    Main entry point for the auto-metadata enrichment pipeline.

    1. Check if enrichment is enabled and not already done (unless force_refresh).
    2. Extract identifiers (DOI, ISBN, PMID, arXiv) from the first pages.
    3. Resolve identifiers via cached or live external APIs.
    4. Update the document record with enriched metadata and improved title.

    This function is designed to be called via asyncio.create_task() so it
    runs in the background without blocking document processing.

    Args:
        document_id: UUID string of the document to enrich.
        extracted_text: Full text extracted from the document.
        force_refresh: If True, re-enrich even if metadata already exists.
    """
    try:
        if not _is_enrichment_enabled():
            logger.debug("Metadata enrichment is disabled via config")
            return

        # Check if already enriched (skip unless forced)
        if not force_refresh:
            already = await asyncio.to_thread(_check_already_enriched, document_id)
            if already:
                logger.debug("Document %s already enriched, skipping", document_id)
                return

        # Step 1: Extract identifiers from text
        identifiers = extract_identifiers(extracted_text)
        if not identifiers.has_any:
            logger.debug("No academic identifiers found in document %s", document_id)
            return

        logger.info(
            "Enriching document %s: DOI=%s, ISBN=%s, arXiv=%s, PMID=%s",
            document_id,
            identifiers.primary_doi,
            identifiers.primary_isbn,
            identifiers.arxiv_ids[:1] or None,
            identifiers.pmids[:1] or None,
        )

        # Step 2: Resolve identifiers to full metadata (cache-aware)
        metadata = await _resolve_with_cache(identifiers)
        if metadata is None:
            logger.info("No metadata resolved for identifiers in document %s", document_id)
            return

        # Step 3: Update the document record (sync DB call, run in thread)
        await asyncio.to_thread(_update_document_record, document_id, metadata)

    except Exception as e:
        # Never let enrichment errors propagate — this is a background enhancement
        logger.exception("Metadata enrichment failed for document %s: %s", document_id, e)
