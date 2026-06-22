"""Unpaywall API client for finding open-access PDFs.

Uses the Unpaywall API to find freely available PDFs for documents with DOIs.
Results are cached in Redis for 30 days.
"""

from dataclasses import dataclass

import httpx

from src.main.utils.connectors.academic_contact import get_academic_contact_email
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_TIMEOUT = 15.0


@dataclass
class OpenAccessResult:
    """Result from Unpaywall API lookup."""

    doi: str
    is_oa: bool = False
    pdf_url: str | None = None
    oa_status: str | None = None  # gold, green, hybrid, bronze
    host_type: str | None = None  # publisher, repository
    version: str | None = None  # publishedVersion, acceptedVersion, submittedVersion


def _get_cache_key(doi: str) -> str:
    return f"scrapalot:unpaywall:{doi}"


def _get_cached(doi: str) -> OpenAccessResult | None:
    """Check Redis cache for a previous lookup."""
    try:
        import json

        from src.main.utils.redis.client import get_redis_client

        r = get_redis_client()
        # noinspection PyUnresolvedReferences,PyTypeChecker
        cached = r.get(_get_cache_key(doi))
        if cached:
            # noinspection PyTypeChecker
            data = json.loads(cached)
            return OpenAccessResult(**data)
    except Exception as e:
        logger.debug("Suppressed exception: %s", e)
    return None


def _set_cached(result: OpenAccessResult) -> None:
    """Cache result in Redis with 30-day TTL."""
    try:
        from dataclasses import asdict
        import json

        from src.main.utils.redis.client import get_redis_client

        r = get_redis_client()
        r.set(_get_cache_key(result.doi), json.dumps(asdict(result)), ex=30 * 86400)
    except Exception as e:
        logger.debug("Suppressed exception: %s", e)


async def find_open_access_pdf(doi: str) -> OpenAccessResult:
    """Look up a DOI on Unpaywall to find open-access PDF URLs."""
    # Check cache first
    cached = _get_cached(doi)
    if cached is not None:
        return cached

    result = OpenAccessResult(doi=doi)

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            response = await client.get(
                f"https://api.unpaywall.org/v2/{doi}",
                params={"email": get_academic_contact_email()},
            )
            if response.status_code != 200:
                logger.debug("Unpaywall returned %s for DOI %s", response.status_code, doi)
                _set_cached(result)
                return result

            data = response.json()
            result.is_oa = data.get("is_oa", False)
            result.oa_status = data.get("oa_status")

            # Get best OA location
            best_loc = data.get("best_oa_location")
            if best_loc:
                result.pdf_url = best_loc.get("url_for_pdf") or best_loc.get("url")
                result.host_type = best_loc.get("host_type")
                result.version = best_loc.get("version")

            # If no best location, check all OA locations
            if not result.pdf_url:
                for loc in data.get("oa_locations", []):
                    pdf_url = loc.get("url_for_pdf")
                    if pdf_url:
                        result.pdf_url = pdf_url
                        result.host_type = loc.get("host_type")
                        result.version = loc.get("version")
                        break

    except Exception as e:
        logger.warning("Unpaywall lookup failed for DOI %s: %s", doi, str(e))

    _set_cached(result)

    if result.pdf_url:
        logger.info("Found open-access PDF for DOI %s: %s (%s)", doi, result.pdf_url, result.oa_status)

    return result
