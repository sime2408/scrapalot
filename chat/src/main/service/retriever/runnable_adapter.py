"""
Adapter module to make custom retrievers compatible with LangChain's Runnable interface.
"""

from typing import Any

from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever
from pydantic import Field

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class RunnableRetrieverAdapter(BaseRetriever):
    """
    Adapter class that wraps a custom retriever to make it compatible with LangChain's Runnable interface.
    Implements the BaseRetriever methods required by LangChain's EnsembleRetriever.
    """

    # Properly define custom_retriever as a model field for Pydantic validation
    custom_retriever: Any = Field(description="The custom retriever to adapt")

    def __init__(self, custom_retriever):
        """
        Initialize the adapter with a custom retriever.

        Args:
                custom_retriever: The custom retriever to adapt to the Runnable interface
        """
        super().__init__(custom_retriever=custom_retriever)
        self.custom_retriever = custom_retriever

    def _get_relevant_documents(self, query: str, *, run_manager=None) -> list[Document]:
        """
        Synchronous method to get relevant documents for a query.

        Args:
                query: The query string
                run_manager: Optional run manager

        Returns:
                List of relevant Document objects
        """
        logger.info("RunnableRetrieverAdapter: Getting relevant documents for query: %s...", query[:50])

        # If custom_retriever has a non-async get_relevant_documents method, use it directly
        if hasattr(self.custom_retriever, "get_relevant_documents"):
            logger.debug("Using custom retriever's get_relevant_documents method")
            return self.custom_retriever.get_relevant_documents(query)

        # Otherwise, use a more generic approach by creating empty documents - note this is a fallback
        # and should be improved based on your specific retriever implementation
        logger.warning("Custom retriever doesn't have get_relevant_documents method, returning empty list")
        return []

    async def _aget_relevant_documents(self, query: str, *, run_manager=None) -> list[Document]:
        """
        Asynchronous method to get relevant documents for a query.

        Args:
                query: The query string
                run_manager: Optional run manager

        Returns:
                List of relevant Document objects
        """
        logger.info("RunnableRetrieverAdapter: Async getting relevant documents for query: %s...", query[:50])

        # If the custom retriever has an async method, use it
        if hasattr(self.custom_retriever, "aget_relevant_documents"):
            logger.debug("Using custom retriever's aget_relevant_documents method")
            return await self.custom_retriever.aget_relevant_documents(query)

        # If it has a process method (common in your custom retrievers), use that
        if hasattr(self.custom_retriever, "process"):
            logger.debug("Using custom retriever's process method")
            try:
                return await self.custom_retriever.process(query)
            except Exception as e:
                logger.error("Error using process method: %s", str(e))
                return []

        # If neither exists, fall back to the synchronous method
        logger.warning("No async methods found, falling back to synchronous get_relevant_documents")
        return self._get_relevant_documents(query)
