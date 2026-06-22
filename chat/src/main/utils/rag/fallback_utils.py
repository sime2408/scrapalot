"""
RAG Fallback Utilities

Shared utility functions for RAG strategy fallback behavior.
This module provides common fallback logic used across multiple RAG strategies
to avoid code duplication.
"""

from uuid import UUID

from langchain_core.documents import Document

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


async def fallback_to_standard_search(
    retriever,
    query: str,
    collection_ids: list[UUID] | None = None,
    document_ids: list[UUID] | None = None,
) -> list[Document]:
    """
    Fallback to standard similarity search when advanced RAG strategies fail.

    This function provides a common fallback mechanism used across multiple RAG strategies
    (MultiQuery, HyDE, StepBack, HybridSelfQuery, etc.) when their advanced retrieval
    methods encounter errors or return no results.

    Args:
        retriever: The retriever instance to use for fallback search
        query: The original query string to search for
        collection_ids: Optional list of collection IDs to filter by
        document_ids: Optional list of document IDs to filter by

    Returns:
        List of retrieved documents from the fallback search
    """
    try:
        if document_ids:
            return await retriever.process(prompt=query, collection_ids=None, document_ids=document_ids)
        else:
            return await retriever.process(prompt=query, collection_ids=collection_ids)
    except Exception as e:
        logger.error(
            "Fallback to standard search also failed: %s. Returning empty results.",
            str(e),
        )
        return []
