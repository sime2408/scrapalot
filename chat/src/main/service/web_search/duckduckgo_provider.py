import asyncio
import json
from typing import Any

from langchain_community.tools import DuckDuckGoSearchResults
from langchain_community.utilities import DuckDuckGoSearchAPIWrapper

from src.main.service.web_search.search_provider_interface import SearchProvider, SearchProviderError, SearchResult
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class DuckDuckGoProvider(SearchProvider):
    """DuckDuckGo search provider implementation using LangChain."""

    def __init__(self, config: dict[str, Any]):
        """Initialize DuckDuckGo search provider."""
        super().__init__(config)

        # Get DuckDuckGo specific configuration
        ddg_config = config.get("duckduckgo", {})

        # Default to en-us, not wt-wt: on the Hetzner host worldwide search
        # returns German/Chinese results. config.yaml already resolves to
        # en-us; this fallback only matters if the key is ever absent.
        self.region = ddg_config.get("region", "en-us")
        self.safesearch = ddg_config.get("safesearch", "moderate")
        self.time = ddg_config.get("time", None)
        self.ddg_max_results = int(ddg_config.get("max_results", 10))

        # Initialize DuckDuckGo API wrapper
        self.api_wrapper = DuckDuckGoSearchAPIWrapper(
            region=self.region, safesearch=self.safesearch, time=self.time, max_results=self.ddg_max_results
        )

        # Initialize DuckDuckGo search tool
        self.search_tool = DuckDuckGoSearchResults(api_wrapper=self.api_wrapper, num_results=min(self.max_results, self.ddg_max_results))

        logger.info("Initialized DuckDuckGo search provider with region=%s, safesearch=%s", self.region, self.safesearch)

    async def search(self, query: str) -> list[SearchResult]:
        """
        Perform a DuckDuckGo search and return formatted results.

        Args:
            query: The search query string

        Returns:
            List of SearchResult objects

        Raises:
            SearchProviderError: If the search fails
        """
        try:
            logger.info("Performing DuckDuckGo search for query: %s", query[:100])

            # Use api_wrapper.results() directly for structured data (List[Dict])
            # instead of search_tool.invoke() which returns a lossy text format
            # that loses individual result URLs
            loop = asyncio.get_event_loop()
            # noinspection PyTypeChecker,PyUnresolvedReferences
            raw_results = await loop.run_in_executor(None, self.api_wrapper.results, query, self.ddg_max_results)

            search_results = []
            for result in raw_results[: self.max_results]:
                search_result = self._create_search_result(result)
                if search_result:
                    search_results.append(search_result)

            logger.info("DuckDuckGo search returned %d results", len(search_results))
            return search_results

        except Exception as e:
            logger.error("Error in DuckDuckGo search: %s", str(e))
            raise SearchProviderError(message=f"Search failed: {e!s}", provider="DuckDuckGo", original_error=e) from e

    def _parse_results(self, raw_results: str) -> list[SearchResult]:
        """
        Parse raw DuckDuckGo results into SearchResult objects.

        Args:
            raw_results: Raw results from DuckDuckGo API

        Returns:
            List of SearchResult objects
        """
        try:
            # DuckDuckGoSearchResults returns a JSON string
            if isinstance(raw_results, str):
                results_data = json.loads(raw_results)
            else:
                results_data = raw_results

            search_results = []

            # Handle different result formats
            if isinstance(results_data, list):
                # List of result dictionaries
                for result in results_data[: self.max_results]:
                    search_result = self._create_search_result(result)
                    if search_result:
                        search_results.append(search_result)
            elif isinstance(results_data, dict):
                # Single result or wrapped results
                if "results" in results_data:
                    for result in results_data["results"][: self.max_results]:
                        search_result = self._create_search_result(result)
                        if search_result:
                            search_results.append(search_result)
                else:
                    # Single result
                    search_result = self._create_search_result(results_data)
                    if search_result:
                        search_results.append(search_result)

            return search_results

        except json.JSONDecodeError as e:
            logger.warning("Failed to parse DuckDuckGo results as JSON: %s", str(e))
            # Fallback: treat as plain text
            return [
                SearchResult(
                    title="Search Results",
                    source="DuckDuckGo",
                    link="",
                    snippet=str(raw_results)[:500],  # Truncate to reasonable length
                )
            ]
        except Exception as e:
            logger.error("Error parsing DuckDuckGo results: %s", str(e))
            return [SearchResult(title="Error", source="DuckDuckGo", link="", snippet=f"Failed to parse search results: {e!s}")]

    @staticmethod
    def _create_search_result(result_data: dict[str, Any]) -> SearchResult | None:
        """
        Create a SearchResult from a single result dictionary.

        Args:
            result_data: Dictionary containing result data

        Returns:
            SearchResult object or None if parsing fails
        """
        # noinspection PyBroadException
        try:
            # Handle different field names that DuckDuckGo might use
            title = result_data.get("title") or result_data.get("Title") or result_data.get("name") or "No Title"

            link = result_data.get("link") or result_data.get("url") or result_data.get("href") or ""

            snippet = result_data.get("snippet") or result_data.get("body") or result_data.get("description") or result_data.get("content") or ""

            # Extract source from link if not provided
            source = result_data.get("source")
            if not source and link:
                # noinspection PyBroadException
                try:
                    from urllib.parse import urlparse

                    parsed_url = urlparse(link)
                    source = parsed_url.netloc or "Unknown"
                except Exception:
                    source = "Unknown"

            return SearchResult(title=str(title), source=str(source or "DuckDuckGo"), link=str(link), snippet=str(snippet))

        except Exception as e:
            logger.warning("Failed to create SearchResult from data: %s", str(e))
            return None

    def is_available(self) -> bool:
        """
        Check if DuckDuckGo search is available.

        Returns:
            True (DuckDuckGo doesn't require API keys)
        """
        try:
            # DuckDuckGo doesn't require API keys, so it's always available
            # We could do a test search here, but that might be too expensive
            return True
        except Exception as e:
            logger.error("Error checking DuckDuckGo availability: %s", str(e))
            return False

    @property
    def provider_name(self) -> str:
        """Return the name of the search provider."""
        return "DuckDuckGo"
