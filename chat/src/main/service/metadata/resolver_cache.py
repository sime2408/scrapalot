"""Redis-based cache for metadata resolver API responses.

Caches ResolvedMetadata results to avoid redundant external API calls.
Key format: scrapalot:metadata:{type}:{identifier}
TTL: 30 days (configurable via config.yaml).
Uses Redis DB 0 (Python's DB).
"""

import json

from src.main.service.metadata.metadata_resolver import ResolvedMetadata
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_CACHE_PREFIX = "scrapalot:metadata"
_DEFAULT_TTL_DAYS = 30


def _get_ttl_seconds() -> int:
    """Get cache TTL in seconds from config.yaml, defaulting to 30 days."""
    # noinspection PyBroadException
    try:
        from src.main.utils.config.loader import resolved_config

        doc_cfg = resolved_config.get("document_processing", {})
        metadata_cfg = doc_cfg.get("metadata_extraction", {})
        ttl_days = metadata_cfg.get("resolver_cache_ttl_days", _DEFAULT_TTL_DAYS)
        return int(ttl_days) * 86400
    except Exception:
        return _DEFAULT_TTL_DAYS * 86400


def _get_redis():
    """Get Redis client instance."""
    from src.main.utils.redis.client import get_redis_client

    return get_redis_client()


def _cache_key(identifier_type: str, identifier_value: str) -> str:
    """Build the Redis cache key."""
    return f"{_CACHE_PREFIX}:{identifier_type}:{identifier_value}"


def get_cached_metadata(identifier_type: str, identifier_value: str) -> ResolvedMetadata | None:
    """
    Retrieve cached ResolvedMetadata for a given identifier.

    Args:
        identifier_type: One of 'doi', 'isbn', 'arxiv', 'pmid'.
        identifier_value: The identifier string.

    Returns:
        ResolvedMetadata if found in cache, None otherwise.
    """
    try:
        redis_client = _get_redis()
        key = _cache_key(identifier_type, identifier_value)
        # noinspection PyUnresolvedReferences,PyTypeChecker
        raw = redis_client.get(key)
        if raw is None:
            return None

        # noinspection PyTypeChecker
        data = json.loads(raw)
        logger.debug("Cache hit for %s:%s", identifier_type, identifier_value)
        return ResolvedMetadata(**data)
    except Exception as e:
        logger.warning("Failed to read metadata cache for %s:%s: %s", identifier_type, identifier_value, e)
        return None


def set_cached_metadata(identifier_type: str, identifier_value: str, metadata: ResolvedMetadata) -> None:
    """
    Store ResolvedMetadata in Redis cache.

    Args:
        identifier_type: One of 'doi', 'isbn', 'arxiv', 'pmid'.
        identifier_value: The identifier string.
        metadata: The resolved metadata to cache.
    """
    try:
        redis_client = _get_redis()
        key = _cache_key(identifier_type, identifier_value)
        data = metadata.to_dict()
        ttl = _get_ttl_seconds()
        redis_client.setex(key, ttl, json.dumps(data))
        logger.debug("Cached metadata for %s:%s (TTL=%ds)", identifier_type, identifier_value, ttl)
    except Exception as e:
        logger.warning("Failed to cache metadata for %s:%s: %s", identifier_type, identifier_value, e)
