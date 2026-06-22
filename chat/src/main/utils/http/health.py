"""Endpoint health-check utilities for verifying provider availability."""

from __future__ import annotations

import asyncio
from urllib.parse import urljoin, urlparse

import aiohttp

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def _get_health_endpoints(base_url: str) -> list[tuple[str, list[int]]]:
    """Return service-specific (url, expected_status_codes) probes."""
    lowered = base_url.lower()
    if "ollama" in lowered or ":11434" in base_url:
        return [
            (urljoin(base_url, "/api/tags"), [200]),
            (urljoin(base_url, "/"), [200, 404]),
        ]
    if "vllm" in lowered or "/v1" in base_url:
        return [
            (urljoin(base_url, "/health"), [200]),
            (urljoin(base_url, "/v1/models"), [200]),
            (urljoin(base_url, "/"), [200, 404]),
        ]
    return [
        (urljoin(base_url, "/health"), [200]),
        (urljoin(base_url, "/api/health"), [200]),
        (urljoin(base_url, "/"), [200, 404]),
    ]


async def check_endpoint_health(
    base_url: str,
    timeout: int = 5,
    api_key: str | None = None,
) -> tuple[bool, str | None]:
    """Verify ``base_url`` is reachable. Returns ``(is_healthy, error_message)``."""
    if not base_url:
        return False, "No base URL provided"

    try:
        parsed = urlparse(base_url)
        if not parsed.scheme or not parsed.netloc:
            return False, f"Invalid URL format: {base_url}"

        headers: dict[str, str] = {}
        if api_key and "ollama.com" in base_url.lower():
            headers["Authorization"] = f"Bearer {api_key}"

        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
            for endpoint_url, expected_status in _get_health_endpoints(base_url):
                try:
                    async with session.get(endpoint_url, headers=headers) as response:
                        if response.status in expected_status:
                            logger.debug("Health check passed for %s via %s", base_url, endpoint_url)
                            return True, None
                        logger.debug("Health check failed for %s: HTTP %s", endpoint_url, response.status)
                except Exception as e:
                    logger.debug("Health check failed for %s: %s", endpoint_url, str(e))
                    continue

            try:
                async with session.get(base_url) as response:
                    if response.status < 500:
                        logger.debug("Basic connectivity check passed for %s", base_url)
                        return True, None
            except Exception as e:
                logger.debug("Basic connectivity check failed for %s: %s", base_url, str(e))

        return False, f"No response from {base_url}"

    except Exception as e:
        error_msg = f"Health check error for {base_url}: {e!s}"
        logger.debug(error_msg)
        return False, error_msg


async def check_provider_health(
    provider_type: str,
    api_base: str,
    timeout: int = 5,
    api_key: str | None = None,
) -> tuple[bool, str | None]:
    """Health-check a single provider, logging ``provider_type`` for context."""
    if not api_base:
        return False, f"No API base URL configured for {provider_type} provider"

    logger.info("Checking health for %s provider at %s", provider_type, api_base)
    is_healthy, error = await check_endpoint_health(api_base, timeout, api_key=api_key)
    if is_healthy:
        logger.info("%s provider is healthy at %s", provider_type, api_base)
    else:
        logger.warning("%s provider is unhealthy at %s: %s", provider_type, api_base, error)
    return is_healthy, error


async def check_multiple_providers(
    providers: dict[str, str],
    timeout: int = 5,
) -> dict[str, tuple[bool, str | None]]:
    """Run ``check_provider_health`` concurrently against ``{provider_type: api_base}``."""
    if not providers:
        return {}
    logger.info("Checking health for %s providers", len(providers))

    items = list(providers.items())
    tasks = [check_provider_health(ptype, api_base, timeout) for ptype, api_base in items]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    health_status: dict[str, tuple[bool, str | None]] = {}
    for (ptype, _), result in zip(items, results, strict=True):
        if isinstance(result, Exception):
            health_status[ptype] = (False, f"Health check exception: {result!s}")
        else:
            health_status[ptype] = result  # type: ignore[assignment]
    return health_status
