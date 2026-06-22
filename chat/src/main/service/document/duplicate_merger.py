"""Duplicate document merge service.

Merges a duplicate document into a canonical document:
1. Copies tags (skip existing)
2. Copies relations (re-point source/target)
3. Copies collection memberships
4. Preserves file if canonical has none
5. Merges extracted_metadata (canonical wins, fill gaps)
6. Deletes duplicate record

Annotations are NOT merged because they live in the Kotlin DB (scrapalot_backend).
"""

import json

from sqlalchemy import text
from sqlalchemy.orm import Session

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def merge_documents(
    db: Session,
    canonical_id: str,
    duplicate_id: str,
) -> tuple[bool, str]:
    """
    Merge a duplicate document into the canonical document.

    Copies tags, relations, collection memberships, and metadata from
    the duplicate into the canonical, then deletes the duplicate.

    Args:
        db: SQLAlchemy session
        canonical_id: UUID of the document to keep
        duplicate_id: UUID of the document to merge and delete

    Returns:
        Tuple of (success, message)
    """
    # Verify both documents exist
    canonical = db.execute(
        text("SELECT id, file_stored, file_path, extracted_metadata FROM documents WHERE id = CAST(:did AS uuid)"),
        {"did": canonical_id},
    ).fetchone()
    if not canonical:
        return False, "Canonical document %s not found" % canonical_id[:8]

    duplicate = db.execute(
        text("SELECT id, file_stored, file_path, extracted_metadata FROM documents WHERE id = CAST(:did AS uuid)"),
        {"did": duplicate_id},
    ).fetchone()
    if not duplicate:
        return False, "Duplicate document %s not found" % duplicate_id[:8]

    try:
        # Step 1: Copy tags from duplicate to canonical (skip existing)
        tags_copied = _copy_tags(db, canonical_id, duplicate_id)

        # Step 2: Copy relations from duplicate to canonical (re-point source/target)
        relations_copied = _copy_relations(db, canonical_id, duplicate_id)

        # Step 3: Copy collection memberships from duplicate to canonical
        collections_copied = _copy_collection_memberships(db, canonical_id, duplicate_id)

        # Step 4: Annotations skipped — they live in the Kotlin DB (scrapalot_backend)

        # Step 5: If canonical has no file stored but duplicate does, keep duplicate's file
        _preserve_file_if_needed(db, canonical_id, canonical, duplicate)

        # Step 6: Merge extracted_metadata (canonical wins, fill gaps from duplicate)
        _merge_extracted_metadata(db, canonical_id, canonical, duplicate)

        # Step 7: Delete duplicate's child records, then the duplicate document itself
        _delete_duplicate(db, duplicate_id)

        db.commit()

        message = "Merged document %s into %s: %d tags, %d relations, %d collections copied" % (
            duplicate_id[:8],
            canonical_id[:8],
            tags_copied,
            relations_copied,
            collections_copied,
        )
        logger.info(message)
        return True, message

    except Exception as e:
        db.rollback()
        logger.error("Failed to merge documents %s -> %s: %s", duplicate_id[:8], canonical_id[:8], str(e))
        return False, "Merge failed: %s" % str(e)


def _copy_tags(db: Session, canonical_id: str, duplicate_id: str) -> int:
    """Copy tags from duplicate to canonical, skipping duplicates."""
    result = db.execute(
        text("""
            INSERT INTO document_tags (document_id, tag_id)
            SELECT CAST(:canonical AS uuid), dt.tag_id
            FROM document_tags dt
            WHERE dt.document_id = CAST(:duplicate AS uuid)
            ON CONFLICT DO NOTHING
        """),
        {"canonical": canonical_id, "duplicate": duplicate_id},
    )
    # noinspection PyUnresolvedReferences
    count = result.rowcount
    if count > 0:
        logger.debug("Copied %d tags from %s to %s", count, duplicate_id[:8], canonical_id[:8])
    return count


def _copy_relations(db: Session, canonical_id: str, duplicate_id: str) -> int:
    """Copy relations from duplicate to canonical, re-pointing source/target."""
    count = 0

    # Re-point outgoing relations (duplicate as source -> canonical as source)
    result = db.execute(
        text("""
            UPDATE document_relations
            SET source_document_id = CAST(:canonical AS uuid)
            WHERE source_document_id = CAST(:duplicate AS uuid)
            AND target_document_id != CAST(:canonical AS uuid)
            AND NOT EXISTS (
                SELECT 1 FROM document_relations dr2
                WHERE dr2.source_document_id = CAST(:canonical AS uuid)
                AND dr2.target_document_id = document_relations.target_document_id
                AND dr2.relationship_type = document_relations.relationship_type
            )
        """),
        {"canonical": canonical_id, "duplicate": duplicate_id},
    )
    # noinspection PyUnresolvedReferences
    count += result.rowcount

    # Re-point incoming relations (duplicate as target -> canonical as target)
    result = db.execute(
        text("""
            UPDATE document_relations
            SET target_document_id = CAST(:canonical AS uuid)
            WHERE target_document_id = CAST(:duplicate AS uuid)
            AND source_document_id != CAST(:canonical AS uuid)
            AND NOT EXISTS (
                SELECT 1 FROM document_relations dr2
                WHERE dr2.target_document_id = CAST(:canonical AS uuid)
                AND dr2.source_document_id = document_relations.source_document_id
                AND dr2.relationship_type = document_relations.relationship_type
            )
        """),
        {"canonical": canonical_id, "duplicate": duplicate_id},
    )
    # noinspection PyUnresolvedReferences
    count += result.rowcount

    # Delete any remaining relations involving the duplicate (self-referencing or conflicting)
    db.execute(
        text("""
            DELETE FROM document_relations
            WHERE source_document_id = CAST(:duplicate AS uuid)
            OR target_document_id = CAST(:duplicate AS uuid)
        """),
        {"duplicate": duplicate_id},
    )

    if count > 0:
        logger.debug("Copied %d relations from %s to %s", count, duplicate_id[:8], canonical_id[:8])
    return count


def _copy_collection_memberships(db: Session, canonical_id: str, duplicate_id: str) -> int:
    """Copy collection memberships from duplicate to canonical."""
    result = db.execute(
        text("""
            INSERT INTO document_collections (document_id, collection_id)
            SELECT CAST(:canonical AS uuid), dc.collection_id
            FROM document_collections dc
            WHERE dc.document_id = CAST(:duplicate AS uuid)
            ON CONFLICT (document_id, collection_id) DO NOTHING
        """),
        {"canonical": canonical_id, "duplicate": duplicate_id},
    )
    # noinspection PyUnresolvedReferences
    count = result.rowcount
    if count > 0:
        logger.debug("Copied %d collection memberships from %s to %s", count, duplicate_id[:8], canonical_id[:8])
    return count


def _preserve_file_if_needed(db: Session, canonical_id: str, canonical, duplicate) -> None:
    """If canonical has no file stored but duplicate does, transfer the file reference."""
    canonical_stored = canonical[1]  # file_stored
    duplicate_stored = duplicate[1]

    if not canonical_stored and duplicate_stored:
        duplicate_path = duplicate[2]  # file_path
        db.execute(
            text("""
                UPDATE documents
                SET file_stored = TRUE, file_path = :path
                WHERE id = CAST(:did AS uuid)
            """),
            {"did": canonical_id, "path": duplicate_path},
        )
        logger.info("Transferred file from duplicate %s to canonical %s", canonical_id[:8], canonical_id[:8])


def _merge_extracted_metadata(db: Session, canonical_id: str, canonical, duplicate) -> None:
    """Merge extracted_metadata: canonical values win, fill gaps from duplicate."""
    canonical_meta = canonical[3] or {}
    duplicate_meta = duplicate[3] or {}

    if isinstance(canonical_meta, str):
        canonical_meta = json.loads(canonical_meta) if canonical_meta else {}
    if isinstance(duplicate_meta, str):
        duplicate_meta = json.loads(duplicate_meta) if duplicate_meta else {}

    if not duplicate_meta:
        return

    merged = dict(duplicate_meta)
    # Canonical wins — overwrite duplicate values with canonical values
    for key, value in canonical_meta.items():
        if value is not None:
            merged[key] = value

    # Deep merge for nested dicts like 'identifiers'
    for key in ("identifiers", "authors_detail", "references"):
        canonical_nested = canonical_meta.get(key) if isinstance(canonical_meta.get(key), dict) else {}
        duplicate_nested = duplicate_meta.get(key) if isinstance(duplicate_meta.get(key), dict) else {}
        if duplicate_nested:
            combined = dict(duplicate_nested)
            # noinspection PyUnresolvedReferences
            combined.update({k: v for k, v in canonical_nested.items() if v is not None})
            merged[key] = combined

    if merged != canonical_meta:
        db.execute(
            text("UPDATE documents SET extracted_metadata = CAST(:meta AS jsonb) WHERE id = CAST(:did AS uuid)"),
            {"did": canonical_id, "meta": json.dumps(merged)},
        )
        logger.debug("Merged extracted_metadata for document %s", canonical_id[:8])


def _delete_duplicate(db: Session, duplicate_id: str) -> None:
    """Delete the duplicate document and all its child records."""
    # Delete child records first (FK constraints)
    db.execute(
        text("DELETE FROM document_tags WHERE document_id = CAST(:did AS uuid)"),
        {"did": duplicate_id},
    )
    db.execute(
        text("DELETE FROM document_collections WHERE document_id = CAST(:did AS uuid)"),
        {"did": duplicate_id},
    )
    db.execute(
        text("DELETE FROM document_relations WHERE source_document_id = CAST(:did AS uuid) OR target_document_id = CAST(:did AS uuid)"),
        {"did": duplicate_id},
    )
    db.execute(
        text("DELETE FROM document_summaries WHERE document_id = CAST(:did AS uuid)"),
        {"did": duplicate_id},
    )

    # Delete embeddings
    db.execute(
        text("DELETE FROM langchain_pg_embedding WHERE cmetadata->>'document_id' = :did"),
        {"did": duplicate_id},
    )

    # Delete the document record
    result = db.execute(
        text("DELETE FROM documents WHERE id = CAST(:did AS uuid)"),
        {"did": duplicate_id},
    )
    # noinspection PyUnresolvedReferences
    if result.rowcount > 0:
        logger.info("Deleted duplicate document %s", duplicate_id[:8])
