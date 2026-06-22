"""
Stand-alone API fetchers for external model providers.

These helpers live in a thin module to avoid circular import issues
between provider services. Each function performs a single HTTP request
and returns either parsed data or an empty list / ``None`` on any error
(callers should not need a try/except wrapper around them).
"""

from __future__ import annotations

import aiohttp

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def _bearer_headers_for(base_url: str, api_key: str | None) -> dict[str, str]:
    """Add a bearer ``Authorization`` header only for Ollama Cloud endpoints."""
    if api_key and "ollama.com" in base_url.lower():
        return {"Authorization": f"Bearer {api_key}"}
    return {}


async def fetch_ollama_models_api(base_url: str, api_key: str | None = None) -> list[dict[str, str]]:
    """Fetch available models from an Ollama-compatible server.

    For Ollama Cloud (``ollama.com``) the ``api_key`` is sent as a bearer
    token. On any error (network, non-200, JSON parse) returns ``[]``.
    """
    headers = _bearer_headers_for(base_url, api_key)
    async with aiohttp.ClientSession() as client:
        try:
            response = await client.get(f"{base_url}/api/tags", headers=headers)
            if response.status != 200:
                return []
            data = await response.json()
            models = [{"id": model["name"], "name": model["name"], "provider": "ollama"} for model in data.get("models", [])]
            if not models:
                logger.warning("Ollama endpoint returned no models")
            return models
        except Exception as e:
            if str(e).strip():
                logger.error("Error fetching models from ollama endpoint: %s", str(e))
            return []


async def fetch_ollama_version(base_url: str, api_key: str | None = None) -> str | None:
    """Return the Ollama server version (e.g. ``"0.5.7"``) or ``None`` on failure.

    Used by the structured-output router to gate the native
    ``format=<schema>`` enforcement (Ollama >= 0.5).
    """
    headers = _bearer_headers_for(base_url, api_key)
    async with aiohttp.ClientSession() as client:
        try:
            response = await client.get(
                f"{base_url}/api/version",
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=5),
            )
            if response.status != 200:
                return None
            data = await response.json()
            version = data.get("version")
            return str(version) if version else None
        except Exception as e:
            if str(e).strip():
                logger.warning("Error fetching Ollama version from %s: %s", base_url, str(e))
            return None


async def fetch_vllm_models_api(base_url: str | dict[str, str]) -> list[dict[str, str]]:
    """Fetch available models from a VLLM server (uses the ``chat`` URL when a dict)."""
    url = base_url["chat"] if isinstance(base_url, dict) else base_url

    async with aiohttp.ClientSession() as client:
        try:
            response = await client.get(f"{url}/models")
            if response.status != 200:
                return []
            data = await response.json()
            models = [
                {
                    "id": f"vllm_{model['id']}",
                    "name": model["id"].replace("vllm_", ""),
                    "provider": "vllm",
                }
                for model in data.get("data", [])
            ]
            if not models:
                logger.warning("VLLM endpoint returned no models")
            return models
        except Exception as e:
            if str(e).strip():
                logger.error("Error fetching models from vllm endpoint: %s", str(e))
            return []
