"""
Retriever Extensions for Enhanced Tri-Modal Orchestrator.

This module provides additional retriever methods needed for fuzzy matching
and pattern-based fallback strategies.
"""

from uuid import UUID

from langchain_core.documents import Document
from sqlalchemy import text

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


async def get_all_documents_for_retriever(
    retriever, collection_ids: list[UUID] | None = None, document_ids: list[UUID] | None = None, limit: int = 1000
) -> list[Document]:
    """
    Get all documents (or a sample) for fuzzy/pattern matching.

    This is an extension method for the Retriever class to support
    the enhanced tri-modal orchestrator's fallback strategies.

    Args:
        retriever: The retriever instance
        collection_ids: Optional collection filter
        document_ids: Optional document filter
        limit: Maximum number of documents to retrieve

    Returns:
        List of Document objects
    """
    try:
        # Access the database session through the retriever
        db = retriever.db if hasattr(retriever, "db") else None

        if not db:
            logger.error("No database session available in retriever")
            return []

        # Build the query using langchain_pg_embedding table
        query = """
        SELECT
            e.id,
            e.document as content,
            e.cmetadata,
            d.title as document_title,
            d.id as document_id,
            cwm.collection_id as collection_id,
            cwm.collection_name as collection_name
        FROM langchain_pg_embedding e
        JOIN documents d ON (e.cmetadata->>'document_id')::uuid = d.id
        JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id
        WHERE 1=1
        """

        params = {}

        # Add collection filter if provided
        if collection_ids:
            query += " AND cwm.collection_id = ANY(:collection_ids)"
            params["collection_ids"] = [str(cid) for cid in collection_ids]

        # Add document filter if provided
        if document_ids:
            query += " AND d.id = ANY(:document_ids)"
            params["document_ids"] = [str(did) for did in document_ids]

        # Add limit
        query += " LIMIT :limit"
        params["limit"] = limit

        # Execute query
        # noinspection PyUnresolvedReferences
        result = db.execute(text(query), params)

        # Convert to Document objects
        documents = []
        for row in result:
            metadata = {
                "chunk_id": str(row.id),
                "document_id": str(row.document_id),
                "collection_id": str(row.collection_id),
                "title": row.document_title,
                "collection_name": row.collection_name,
            }

            # Add chunk metadata if available
            if row.cmetadata:
                metadata.update(row.cmetadata)

            doc = Document(page_content=row.content, metadata=metadata)
            documents.append(doc)

        logger.info("Retrieved %d documents for fuzzy/pattern matching", len(documents))
        return documents

    except Exception as e:
        logger.error("Error retrieving documents for fuzzy matching: %s", str(e))
        return []


def extend_retriever_with_fallback_methods(retriever_class):
    """
    Monkey-patch the retriever class to add fallback methods.

    This should be called during initialization to add the necessary
    methods to support the enhanced tri-modal orchestrator.

    Args:
        retriever_class: The Retriever class to extend
    """

    # Add the get_all_documents method
    async def get_all_documents(
        self, collection_ids: list[UUID] | None = None, document_ids: list[UUID] | None = None, limit: int = 1000
    ) -> list[Document]:
        """Get all documents for fuzzy/pattern matching."""
        return await get_all_documents_for_retriever(self, collection_ids, document_ids, limit)

    # Attach the method to the class
    retriever_class.get_all_documents = get_all_documents

    logger.info("Extended Retriever class with fallback methods")
