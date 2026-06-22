"""Session utility functions extracted from controllers for use by Python services."""

from datetime import UTC, datetime
import hashlib
from uuid import UUID

from sqlalchemy import text
from sqlmodel import Session as SQLModelSession

from src.main.models.sqlmodel_models import Document
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


async def generate_rag_session_identifier(db: SQLModelSession, collection_id: UUID | None = None, document_ids: list[UUID] | None = None):
    """
    Generate a deterministic identifier for RAG sessions based on collection and document IDs.
    This is used to find existing RAG sessions for the same collection and documents.

    NOTE: This is different from LLM-based title generation used for direct chats.
    This creates deterministic identifiers for RAG flows to enable session continuity.

    Args:
        db: Database session
        collection_id: Optional UUID of the collection (use first if multiple collections)
        document_ids: Optional list of document UUIDs

    Returns:
        A deterministic identifier that can be used to find existing RAG sessions
    """
    try:
        elements = []

        # Add collection name from the collection_workspace_map cache
        if collection_id:
            # noinspection PyTypeChecker,PyDeprecation
            result = db.execute(
                text("SELECT collection_name FROM collection_workspace_map WHERE collection_id = :cid"),
                {"cid": str(collection_id)},
            ).fetchone()
            if result and result.collection_name:
                elements.append(f"col:{result.collection_name}")

        # Add document names (sorted for determinism)
        if document_ids and len(document_ids) > 0:
            # Get document names
            # noinspection PyDeprecation,PyUnresolvedReferences
            docs = db.query(Document).filter(Document.id.in_(document_ids)).all()
            if docs:
                doc_names = sorted([doc.filename for doc in docs], key=lambda x: x.lower())
                # Limit the number of document names to include
                if len(doc_names) > 3:
                    doc_count = len(doc_names)
                    doc_names = doc_names[:3]
                    elements.append(f"docs:{','.join([str(doc_name) for doc_name in doc_names])}+{doc_count - 3}")
                else:
                    elements.append(f"docs:{','.join([str(doc_name) for doc_name in doc_names])}")

        # Create a deterministic name
        conversation_base = "-".join(elements) if elements else "direct-chat"

        # Generate a hash of all document IDs for uniqueness
        if document_ids and len(document_ids) > 0:
            doc_ids_str = ",".join(sorted([str(doc_id) for doc_id in document_ids]))
            hash_suffix = hashlib.md5(doc_ids_str.encode()).hexdigest()[:8]
            conversation_name = f"{conversation_base}-{hash_suffix}"
        else:
            # If no documents, either use just the collection or a default
            conversation_name = conversation_base

        return conversation_name
    except Exception as e:
        logger.error("Error generating session name: %s", str(e))
        # Fallback to a basic name with timestamp
        return f"session-{datetime.now(UTC).strftime('%Y%m%d-%H%M%S')}"
