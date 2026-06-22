"""
Shared utilities for research operations to avoid code duplication.
"""

import json
from typing import Any


def convert_results_to_dict_list(results) -> list[dict[str, Any]]:
    """Convert search results to dictionary format."""
    results_dict = []
    for result in results:
        results_dict.append(
            {
                "title": result.title,
                "url": result.url,
                "content_snippet": result.content_snippet,
                "relevance_score": result.relevance_score,
                "credibility_score": result.credibility_score,
            }
        )
    return results_dict


def convert_results_to_json_string(results, query: str, provider_name: str) -> str:
    """Convert search results to dictionary format and return as JSON string."""
    results_dict = convert_results_to_dict_list(results)
    return json.dumps({"query": query, "provider": provider_name, "results": results_dict})
