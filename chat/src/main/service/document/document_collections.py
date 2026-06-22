"""Multi-collection membership service for documents.

Manages the document_collections junction table. A single document can
belong to multiple collections without duplicating embeddings.

The original documents.collection_id FK is preserved as the "primary"
collection for backward compatibility with existing queries.
"""

from sqlalchemy import text
from sqlalchemy.orm import Session

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def add_to_collection(db: Session, document_id: str, collection_id: str) -> bool:
    """Add a document to a collection (idempotent — ignores if already exists)."""
    try:
        db.execute(
            text("""
                INSERT INTO document_collections (document_id, collection_id)
                VALUES (CAST(:doc_id AS uuid), CAST(:col_id AS uuid))
                ON CONFLICT (document_id, collection_id) DO NOTHING
            """),
            {"doc_id": document_id, "col_id": collection_id},
        )
        db.commit()
        logger.info("Added document %s to collection %s", document_id[:8], collection_id[:8])
        return True
    except Exception as e:
        db.rollback()
        logger.error("Failed to add document to collection: %s", str(e))
        return False


def remove_from_collection(db: Session, document_id: str, collection_id: str) -> bool:
    """Remove a document from a collection. Does NOT delete the document itself."""
    try:
        result = db.execute(
            text("""
                DELETE FROM document_collections
                WHERE document_id = CAST(:doc_id AS uuid)
                AND collection_id = CAST(:col_id AS uuid)
            """),
            {"doc_id": document_id, "col_id": collection_id},
        )
        db.commit()
        # noinspection PyUnresolvedReferences
        deleted = result.rowcount > 0
        if deleted:
            logger.info("Removed document %s from collection %s", document_id[:8], collection_id[:8])
        return deleted
    except Exception as e:
        db.rollback()
        logger.error("Failed to remove document from collection: %s", str(e))
        return False


def get_document_collections(db: Session, document_id: str) -> list[dict]:
    """Get all collections a document belongs to."""
    result = db.execute(
        text("""
            SELECT dc.collection_id, cwm.collection_name, dc.added_at
            FROM document_collections dc
            LEFT JOIN collection_workspace_map cwm ON cwm.collection_id = dc.collection_id
            WHERE dc.document_id = CAST(:doc_id AS uuid)
            ORDER BY dc.added_at
        """),
        {"doc_id": document_id},
    )
    return [
        {
            "collection_id": str(row[0]),
            "collection_name": row[1] or "Unknown",
            "added_at": row[2].isoformat() if row[2] else "",
        }
        for row in result
    ]
