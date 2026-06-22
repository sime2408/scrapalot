"""
Base research provider utilities for common research operations.

This module provides a reusable base class for research providers
that consolidates common validation and content retrieval operations.
"""

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from typing import Any

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class ResearchProviderError(Exception):
    """Custom exception for research provider errors."""

    def __init__(self, message: str, provider_name: str, original_error: Exception = None):
        super().__init__(message)
        self.provider_name = provider_name
        self.original_error = original_error


class BaseResearchProvider(ABC):
    """Base class for research providers with common functionality."""

    def __init__(self, provider_name: str):
        self.provider_name = provider_name

    async def retrieve_content(self, url: str) -> str:
        """
        Retrieve content from a URL.

        Args:
            url: URL to retrieve content from

        Returns:
            Retrieved content as string

        Raises:
            ResearchProviderError: If content retrieval fails
        """
        try:
            # This is a common pattern - subclasses should implement the actual retrieval
            content = await self._do_retrieve_content(url)

            if not content:
                raise ResearchProviderError(f"No content retrieved from URL: {url}", self.provider_name)

            logger.info("Retrieved content from URL: %s (length: %d characters)", url, len(content))
            return content

        except Exception as e:
            logger.error("Error retrieving content from URL %s: %s", url, str(e))
            raise ResearchProviderError(f"Content retrieval failed: {e!s}", self.provider_name, e) from e

    @abstractmethod
    async def _do_retrieve_content(self, url: str) -> str:
        """
        Abstract method for actual content retrieval implementation.

        Args:
            url: URL to retrieve content from

        Returns:
            Retrieved content as string
        """

    async def expand_query(self, query) -> list:
        """
        Expand a query into multiple related queries.

        Args:
            query: Original query to expand

        Returns:
            List of expanded queries
        """
        try:
            # In a real implementation, this would use an LLM to generate related queries
            # For now, we'll create some simple expansions
            expanded_queries = await self._do_expand_query(query)

            logger.info(
                "Expanded query '%s' into %d related queries",
                getattr(query, "query", str(query)),
                len(expanded_queries),
            )
            return expanded_queries

        except Exception as e:
            logger.error("Error expanding query: %s", str(e))
            raise ResearchProviderError(f"Query expansion failed: {e!s}", self.provider_name, e) from e

    @abstractmethod
    async def _do_expand_query(self, query) -> list:
        """
        Abstract method for actual query expansion implementation.

        Args:
            query: Original query to expand

        Returns:
            List of expanded queries
        """

    def validate_source(self, source) -> object:
        """
        Validate and score a research source.

        Args:
            source: Source object to validate

        Returns:
            Validated source with credibility and relevance scores

        Raises:
            ResearchProviderError: If source validation fails
        """
        try:
            # Common validation logic
            credibility_score = self._calculate_credibility_score(source)

            # Set scores on the source
            source.credibility_score = credibility_score
            source.relevance_score = 0.8  # Default relevance score

            logger.info(
                "Validated source: %s (credibility: %.2f, relevance: %.2f)",
                source.url,
                source.credibility_score,
                source.relevance_score,
            )
            return source

        except Exception as e:
            logger.error("Error validating source: %s", str(e))
            raise ResearchProviderError(f"Source validation failed: {e!s}", self.provider_name, e) from e

    @staticmethod
    def _calculate_credibility_score(source) -> float:
        """
        Calculate credibility score for a source.

        Args:
            source: Source object to score

        Returns:
            Credibility score between 0.0 and 1.0
        """
        # Basic credibility scoring based on domain and other factors
        score = 0.5  # Base score

        url = getattr(source, "url", "")

        # Boost score for known reliable domains
        reliable_domains = [
            "wikipedia.org",
            "gov",
            "edu",
            "nature.com",
            "science.org",
            "arxiv.org",
            "pubmed.ncbi.nlm.nih.gov",
            "scholar.google.com",
        ]

        for domain in reliable_domains:
            if domain in url:
                score += 0.3
                break

        # Reduce score for potentially unreliable indicators
        unreliable_indicators = ["blog", "forum", "social", "ad"]
        for indicator in unreliable_indicators:
            if indicator in url.lower():
                score -= 0.2
                break

        # Ensure score is within bounds
        return max(0.0, min(1.0, score))

    @abstractmethod
    async def search(self, query) -> list:
        """
        Abstract method for searching with the provider.

        Args:
            query: Search query

        Returns:
            List of search results
        """


async def retrieve_content_with_error_handling(url: str, provider_name: str, retrieval_func: Callable[[str], Awaitable[str]]) -> str:
    """
    Common wrapper for content retrieval with standardized error handling and logging.

    Args:
        url: URL to retrieve content from
        provider_name: Name of the provider for error reporting
        retrieval_func: Async function that performs the actual content retrieval

    Returns:
        Retrieved content as string

    Raises:
        ResearchProviderError: If content retrieval fails
    """
    try:
        content = await retrieval_func(url)

        if not content:
            raise ResearchProviderError(f"No content retrieved from URL: {url}", provider_name)

        logger.info("Retrieved content from URL: %s (length: %d characters)", url, len(content))
        return content

    except Exception as e:
        logger.error("Error retrieving content from URL %s: %s", url, str(e))
        raise ResearchProviderError(f"Content retrieval failed: {e!s}", provider_name, e) from e


async def validate_source_with_error_handling(source: Any, provider_name: str, validation_func: Callable[[Any], Awaitable[Any]]) -> Any:
    """
    Common wrapper for source validation with standardized error handling and logging.

    Args:
        source: Source to validate
        provider_name: Name of the provider for error reporting
        validation_func: Async function that performs the actual validation

    Returns:
        Validated source with scores

    Raises:
        ResearchProviderError: If validation fails
    """
    try:
        validated_source = await validation_func(source)

        logger.info(
            "Validated source: %s (credibility: %.2f, relevance: %.2f)",
            source.url,
            getattr(validated_source, "credibility_score", 0.0),
            getattr(validated_source, "relevance_score", 0.0),
        )
        return validated_source

    except Exception as e:
        logger.error("Error validating source: %s", str(e))
        raise ResearchProviderError(f"Source validation failed: {e!s}", provider_name, e) from e
