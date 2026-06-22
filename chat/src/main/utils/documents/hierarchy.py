"""
Hierarchy Utilities - Helper functions for document hierarchy storage and retrieval.

This module provides utilities for working with document hierarchy extracted during
the chunking process, part of the Context Expansion feature.
"""

import json
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlmodel import Session

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def store_document_hierarchy(db: Session, document_id: UUID, hierarchy: dict[str, Any]) -> bool:
    """
    Store document hierarchy in the documents table.

    Args:
        db: Database session
        document_id: UUID of the document
        hierarchy: Hierarchy tree structure

    Returns:
        True if storage was successful, False otherwise
    """
    if not hierarchy:
        logger.debug("Empty hierarchy for document %s, skipping storage", document_id)
        return True

    try:
        # Store hierarchy as JSONB in PostgreSQL or JSON in SQLite
        query = text("""
            UPDATE documents
            SET document_hierarchy = :hierarchy
            WHERE id = :document_id
        """)

        # noinspection PyDeprecation,PyTypeChecker
        db.execute(query, {"document_id": str(document_id), "hierarchy": json.dumps(hierarchy)})
        db.commit()

        logger.info("Stored hierarchy for document %s (%d top-level sections)", document_id, len(hierarchy))
        return True

    except Exception as e:
        logger.exception("Error storing hierarchy for document %s: %s", document_id, str(e))
        db.rollback()
        return False


def rebuild_hierarchy_from_chunk_metadata(db: Session, document_id: UUID) -> dict[str, Any] | None:
    """Rebuild a `document_hierarchy` JSONB tree from chunk metadata in
    `langchain_pg_embedding`.

    Used for the historical-fix path when a doc was processed by an older
    pipeline that wrote chunks but never stored a hierarchy tree on the
    `documents` row. Chunk metadata produced by the current chunker
    already carries everything needed:

      - ``chunk_index``         — numeric position
      - ``chapter_title``       — H1 grouping
      - ``section_heading``     — H2 grouping (under the chapter)
      - ``header_level``        — fallback when chapter/section missing

    The rebuilt format matches the one written by
    ``node_factory.create_detailed_hierarchy``:

        {
          "<chapter title>": {
            "chunk_range": [s, e],
            "heading_level": 1,
            "children": {
              "<section heading>": {"chunk_range": [s, e], "heading_level": 2}
            }
          }
        }

    Returns the tree if at least one chapter or section title was found,
    or None when the doc has no chunks at all (nothing to rebuild from).
    A doc with chunks but no usable chapter/section metadata gets a
    single synthetic top-level "Document" entry covering the whole
    chunk_range — that still lets the summary service find chunks and
    is strictly more useful than a NULL hierarchy.
    """
    # Two pipeline versions need to coexist here:
    #
    #  - Modern chunkers stamp `cmetadata.chunk_index` as a plain integer
    #    string and we use it directly.
    #  - An older PDF-layout path emitted chunks with `chunk_index = NULL`
    #    (only `chunk_index_in_section`) and they would otherwise be
    #    excluded by a `chunk_index ~ '^[0-9]+$'` filter, leaving the doc
    #    permanently NULL-hierarchy. Synthesize an order from
    #    `ROW_NUMBER() OVER (ORDER BY id)` so those rows still produce
    #    a usable tree. The synthetic indices are 0-based so they
    #    match the modern format.
    rows = db.execute(
        text("""
            SELECT
              COALESCE(
                NULLIF(cmetadata->>'chunk_index', '')::int,
                ROW_NUMBER() OVER (
                  PARTITION BY cmetadata->>'document_id'
                  ORDER BY id
                )::int - 1
              ) AS chunk_index,
              cmetadata->>'chapter_title'   AS chapter_title,
              cmetadata->>'section_heading' AS section_heading
            FROM langchain_pg_embedding
            WHERE cmetadata->>'document_id' = :doc_id
            ORDER BY 1
        """),
        {"doc_id": str(document_id)},
    ).fetchall()

    if not rows:
        return None

    # OCR-placeholder / single-chunk guard. A doc with `processing_status =
    # 'deferred'` (errorScannedPdfOcrDeferred) typically carries one
    # placeholder row in `langchain_pg_embedding` describing the deferred
    # state — the rebuild walk would still emit
    # `{"Introduction": {"children": {"Section 1": {"chunk_range": [0, 0]}}}}`
    # which is meaningless and actively confuses the summary service.
    # The same applies to a `failed` doc whose chunks were wiped during
    # cleanup but whose row count is incidentally 1. Below the realistic
    # threshold of 2 distinct chunks there is no useful hierarchy to
    # rebuild — bail and let the caller leave `document_hierarchy = NULL`.
    distinct_indices = {row[0] for row in rows}
    if len(distinct_indices) < 2:
        return None

    # Walk chunks in order, accumulating chapter + section ranges.
    # `chapter_title` may be repeated across many chunks; first
    # occurrence wins for `chunk_start`, last occurrence for `chunk_end`.
    chapters: dict[str, dict[str, Any]] = {}
    for chunk_index, chapter_title, section_heading in rows:
        ch_key = (chapter_title or "").strip()
        if not ch_key:
            ch_key = "Document"  # fallback synthetic root

        ch_entry = chapters.setdefault(
            ch_key,
            {
                "chunk_range": [chunk_index, chunk_index],
                "heading_level": 1,
                "children": {},
            },
        )
        ch_entry["chunk_range"][1] = chunk_index

        sec_key = (section_heading or "").strip()
        if sec_key and sec_key != ch_key:
            sec_entry = ch_entry["children"].setdefault(
                sec_key,
                {"chunk_range": [chunk_index, chunk_index], "heading_level": 2},
            )
            sec_entry["chunk_range"][1] = chunk_index

    return chapters


def get_document_hierarchy(db: Session, document_id: UUID) -> dict[str, Any] | None:
    """
    Retrieve document hierarchy from the documents table.

    Args:
        db: Database session
        document_id: UUID of the document

    Returns:
        Hierarchy tree if found, None otherwise
    """
    try:
        query = text("""
            SELECT document_hierarchy
            FROM documents
            WHERE id = :document_id
        """)

        # noinspection PyDeprecation,PyTypeChecker
        result = db.execute(query, {"document_id": str(document_id)}).fetchone()

        if result and result[0]:
            # Parse JSON if it's a string
            hierarchy = result[0]
            if isinstance(hierarchy, str):
                hierarchy = json.loads(hierarchy)
            return hierarchy

        return None

    except Exception as e:
        logger.exception("Error retrieving hierarchy for document %s: %s", document_id, str(e))
        return None


def get_section_chunks(db: Session, document_id: UUID, section_heading: str) -> list[dict[str, Any]]:
    """
    Retrieve all chunks in a specific section.

    This is the core function for : Section-Based Context Expansion.

    Args:
        db: Database session
        document_id: UUID of the document
        section_heading: Section heading to match

    Returns:
        List of chunk dictionaries with metadata
    """
    try:
        query = text("""
            SELECT id, (cmetadata->>'chunk_index')::int as chunk_index, document, cmetadata
            FROM langchain_pg_embedding
            WHERE cmetadata->>'document_id' = :document_id
            AND cmetadata->>'section_heading' = :section_heading
            ORDER BY (cmetadata->>'chunk_index')::int
        """)

        # noinspection PyDeprecation,PyTypeChecker
        result = db.execute(query, {"document_id": str(document_id), "section_heading": section_heading}).fetchall()

        chunks = []
        for row in result:
            chunk_metadata = row[3]
            if isinstance(chunk_metadata, str):
                chunk_metadata = json.loads(chunk_metadata)

            chunks.append({"id": row[0], "chunk_index": row[1], "text": row[2], "metadata": chunk_metadata})

        logger.debug("Retrieved %d chunks for section '%s' in document %s", len(chunks), section_heading, document_id)
        return chunks

    except Exception as e:
        logger.exception("Error retrieving section chunks for document %s, section '%s': %s", document_id, section_heading, str(e))
        return []


def get_chunks_by_range(db: Session, document_id: UUID, start_index: int, end_index: int) -> list[dict[str, Any]]:
    """
    Retrieve chunks within a specific index range.

    Used for parent/section expansion based on chunk ranges from hierarchy.

    Args:
        db: Database session
        document_id: UUID of the document
        start_index: Starting chunk index (inclusive)
        end_index: Ending chunk index (inclusive)

    Returns:
        List of chunk dictionaries with metadata
    """
    try:
        query = text("""
            SELECT id, (cmetadata->>'chunk_index')::int as chunk_index, document, cmetadata
            FROM langchain_pg_embedding
            WHERE cmetadata->>'document_id' = :document_id
            AND (cmetadata->>'chunk_index')::int >= :start_index
            AND (cmetadata->>'chunk_index')::int <= :end_index
            ORDER BY (cmetadata->>'chunk_index')::int
        """)

        # noinspection PyDeprecation,PyTypeChecker
        result = db.execute(query, {"document_id": str(document_id), "start_index": start_index, "end_index": end_index}).fetchall()

        chunks = []
        for row in result:
            chunk_metadata = row[3]
            if isinstance(chunk_metadata, str):
                chunk_metadata = json.loads(chunk_metadata)

            chunks.append({"id": row[0], "chunk_index": row[1], "text": row[2], "metadata": chunk_metadata})

        logger.debug("Retrieved %d chunks in range [%d, %d] for document %s", len(chunks), start_index, end_index, document_id)
        return chunks

    except Exception as e:
        logger.exception("Error retrieving chunks by range for document %s: %s", document_id, str(e))
        return []


def get_cross_collection_chunks(
    db: Session,
    document_ids: list[str],
    keywords: list[str] | None = None,
    exclude_document_id: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """
    Retrieve chunks from pgvector for cross-book context expansion.

    Used for cross-book intelligence: Neo4j graph traversal identifies related document IDs
    that share entities, then this function fetches the most relevant chunks from those
    documents using keyword matching.

    Args:
        db: Database session
        document_ids: List of target document IDs to fetch chunks from
        keywords: Optional keywords to filter chunks by content relevance
        exclude_document_id: Document ID to exclude (the source document)
        limit: Maximum number of chunks to return

    Returns:
        List of chunk dictionaries with text and metadata
    """
    if not document_ids:
        return []

    try:
        # Build parameterized IN clause for document_ids
        doc_placeholders = ", ".join(f":did_{i}" for i in range(len(document_ids[:20])))
        params: dict[str, Any] = {f"did_{i}": did for i, did in enumerate(document_ids[:20])}
        params["limit"] = limit

        # Base filter: documents in the target list
        where_clauses = [f"cmetadata->>'document_id' IN ({doc_placeholders})"]

        # Exclude source document
        if exclude_document_id:
            where_clauses.append("cmetadata->>'document_id' != :exclude_doc")
            params["exclude_doc"] = exclude_document_id

        # Optional keyword filtering for relevance
        if keywords:
            kw_conditions = []
            for i, kw in enumerate(keywords[:5]):
                kw_param = f"kw_{i}"
                kw_conditions.append(f"document ILIKE :{kw_param}")
                params[kw_param] = f"%{kw}%"
            where_clauses.append(f"({' OR '.join(kw_conditions)})")

        where_sql = " AND ".join(where_clauses)

        query = text(f"""
            SELECT id, document, cmetadata, (cmetadata->>'chunk_index')::int as chunk_index
            FROM langchain_pg_embedding
            WHERE {where_sql}
            ORDER BY (cmetadata->>'chunk_index')::int
            LIMIT :limit
        """)

        # noinspection PyDeprecation,PyTypeChecker
        result = db.execute(query, params).fetchall()

        chunks = []
        for row in result:
            chunk_metadata = row[2]
            if isinstance(chunk_metadata, str):
                chunk_metadata = json.loads(chunk_metadata)

            chunks.append(
                {
                    "id": row[0],
                    "chunk_index": row[3],
                    "text": row[1],
                    "metadata": chunk_metadata,
                }
            )

        logger.debug(
            "Retrieved %d cross-collection chunks from %d target documents",
            len(chunks),
            len(document_ids),
        )
        return chunks

    except Exception as e:
        logger.exception("Error retrieving cross-collection chunks: %s", str(e))
        return []


def extract_hierarchy_statistics(hierarchy: dict[str, Any]) -> dict[str, Any]:
    """
    Extract statistics from a hierarchy tree for logging/monitoring.

    Args:
        hierarchy: Hierarchy tree structure

    Returns:
        Dictionary with statistics (total_sections, max_depth, etc.)
    """

    def count_nodes_and_depth(tree: dict[str, Any], current_depth: int = 0) -> tuple:
        """Recursively count nodes and find max depth"""
        if not tree:
            return 0, current_depth

        total_nodes = len(tree)
        local_max_depth = current_depth

        for node in tree.values():
            children = node.get("children", {})
            if children:
                child_nodes, child_depth = count_nodes_and_depth(children, current_depth + 1)
                total_nodes += child_nodes
                local_max_depth = max(local_max_depth, child_depth)

        return total_nodes, local_max_depth

    total_sections, max_depth = count_nodes_and_depth(hierarchy)

    # +1 because root is depth 0
    return {"total_sections": total_sections, "top_level_sections": len(hierarchy), "max_depth": max_depth + 1}
