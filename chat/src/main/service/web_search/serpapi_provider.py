from typing import Any

import aiohttp

from src.main.service.web_search.search_provider_interface import SearchProvider, SearchProviderError, SearchResult
from src.main.utils.config.loader import resolved_secrets
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class SerpAPIProvider(SearchProvider):
    """SerpAPI search provider implementation."""

    def __init__(self, config: dict[str, Any]):
        """Initialize SerpAPI search provider."""
        super().__init__(config)

        # Get SerpAPI specific configuration
        serpapi_config = config.get("serpapi", {})

        self.engine = serpapi_config.get("engine", "google")
        self.location = serpapi_config.get("location", "")
        self.language = serpapi_config.get("language", "en")
        self.safe_search = serpapi_config.get("safe_search", "moderate")

        # Get API key from secrets
        self.api_key = resolved_secrets.get("serpapi_key")

        logger.info("Initialized SerpAPI search provider with engine=%s, language=%s", self.engine, self.language)

    async def search(self, query: str) -> list[SearchResult]:
        """
        Perform a SerpAPI search and return formatted results.

        Args:
            query: The search query string

        Returns:
            List of SearchResult objects

        Raises:
            SearchProviderError: If the search fails
        """
        if not self.api_key:
            raise SearchProviderError(message="SerpAPI key not found in secrets.yaml", provider="SerpAPI")

        try:
            logger.info("Performing SerpAPI search for query: %s", query[:100])

            params = {
                "api_key": self.api_key,
                "engine": self.engine,
                "q": query,
                "num": self.max_results,
            }

            # Add optional parameters if configured
            if self.location:
                params["location"] = self.location
            if self.language:
                params["hl"] = self.language
            if self.safe_search:
                params["safe"] = self.safe_search

            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=self.timeout)) as session:
                async with session.get("https://serpapi.com/search", params=params) as response:
                    if response.status != 200:
                        raise SearchProviderError(message=f"API returned status {response.status}", provider="SerpAPI")

                    results = await response.json()

            # Parse organic results
            organic_results = results.get("organic_results", [])
            if not organic_results:
                return [
                    SearchResult(
                        title="No Results",
                        source="SerpAPI",
                        link="",
                        snippet="No search results found for the given query.",
                    )
                ]

            search_results = []
            for result in organic_results[: self.max_results]:
                search_result = SearchResult(
                    title=result.get("title", ""),
                    source=result.get("source", ""),
                    link=result.get("link", ""),
                    snippet=result.get("snippet", ""),
                )
                search_results.append(search_result)

            logger.info("SerpAPI search returned %d results", len(search_results))
            return search_results

        except TimeoutError:
            raise SearchProviderError(message="Search request timed out", provider="SerpAPI") from None
        except Exception as e:
            logger.error("Error in SerpAPI search: %s", str(e))
            raise SearchProviderError(message=f"Search failed: {e!s}", provider="SerpAPI", original_error=e) from e

    def is_available(self) -> bool:
        """
        Check if SerpAPI is available and properly configured.

        Returns:
            True if API key is available, False otherwise
        """
        return bool(self.api_key)

    @property
    def provider_name(self) -> str:
        """Return the name of the search provider."""
        return "SerpAPI"
