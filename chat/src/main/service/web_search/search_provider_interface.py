from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel


class SearchResult(BaseModel):
    """Model for search result data structure."""

    title: str
    source: str
    link: str
    snippet: str

    def __str__(self) -> str:
        return f"Title: {self.title}\nSource: {self.source}\nLink: {self.link}\nSnippet: {self.snippet}"


class SearchProvider(ABC):
    """Abstract base class for web search providers."""

    def __init__(self, config: dict[str, Any]):
        """Initialize the search provider with configuration."""
        self.config = config
        self.timeout = int(config.get("timeout_seconds", 30))
        self.max_results = int(config.get("max_results", 5))

    @abstractmethod
    async def search(self, query: str) -> list[SearchResult]:
        """
        Perform a web search and return results.

        Args:
            query: The search query string

        Returns:
            List of SearchResult objects

        Raises:
            SearchProviderError: If the search fails
        """

    @abstractmethod
    def is_available(self) -> bool:
        """
        Check if the search provider is available and properly configured.

        Returns:
            True if the provider is available, False otherwise
        """

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Return the name of the search provider."""


class SearchProviderError(Exception):
    """Exception raised when a search provider encounters an error."""

    def __init__(self, message: str, provider: str, original_error: Exception | None = None):
        self.message = message
        self.provider = provider
        self.original_error = original_error
        super().__init__(f"{provider}: {message}")
