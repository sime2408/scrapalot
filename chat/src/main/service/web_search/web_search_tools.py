from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel

from src.main.service.web_search.search_provider_factory import SearchProviderFactory
from src.main.service.web_search.search_provider_interface import SearchProviderError, SearchResult
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class WebSearchInput(BaseModel):
    """Input schema for web search tool."""

    query: str


@tool("web_search", args_schema=WebSearchInput)
async def web_search(query: str) -> list[SearchResult]:
    """
    Use this tool to search the web for current information using the configured search provider.

    Args:
        query: The search query string

    Returns:
        List of SearchResult objects with title, source, link, and snippet
    """
    try:
        logger.info("Performing web search for query: %s", query[:100])

        # Get the search provider
        provider = SearchProviderFactory.get_provider()

        # Perform the search
        results = await provider.search(query)

        logger.info("Web search returned %d results using %s", len(results), provider.provider_name)
        return results

    except SearchProviderError as e:
        logger.error("Search provider error: %s", str(e))
        return [SearchResult(title="Search Error", source=e.provider, link="", snippet=f"Search failed: {e.message}")]
    except Exception as e:
        logger.error("Unexpected error in web search: %s", str(e))
        return [SearchResult(title="Error", source="System", link="", snippet=f"An unexpected error occurred: {e!s}")]


@tool
async def final_answer(answer: str, sources_used: list[str]) -> dict[str, Any]:
    """Use this tool to provide a final answer to the user with sources."""
    return {"answer": answer, "sources_used": sources_used, "type": "final_answer"}


# Legacy compatibility function for existing code
async def serpapi_search(query: str) -> list[SearchResult]:
    """
    Legacy compatibility function that uses the new web search system.

    Args:
        query: The search query string

    Returns:
        List of SearchResult objects
    """
    # noinspection PyCallingNonCallable
    return await web_search.ainvoke({"query": query})
