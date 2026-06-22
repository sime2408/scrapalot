"""
Redis client utility for scrapalot-chat.
Provides a unified interface to get Redis client instances.
"""

import os
from typing import Any

import redis
from redis.backoff import ExponentialBackoff
from redis.exceptions import BusyLoadingError
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError
from redis.retry import Retry

from src.main.config.redis_embedded import get_truly_embedded_redis_client
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Global Redis client instance
_redis_client: redis.Redis | Any | None = None

# README_BACKGROUND_JOBS.md "Quick-wins" row in Phase table — error classes that should trigger a
# transparent retry rather than surfacing to the caller.
#
# `BusyLoadingError` fires while Redis is loading its RDB snapshot after a
# `docker restart redis` or a failover — the default redis-py policy only
# covers `ConnectionError`, so without listing it explicitly it bubbles up
# and our stream subscribers / gRPC layer cascade-503 until manual restart.
# Verified live during deep research runs.
_REDIS_RETRYABLE_ERRORS = (BusyLoadingError, RedisConnectionError, RedisTimeoutError)

# `cap=2.0 base=0.1` → waits 0.1, 0.2, 0.4, 0.8, 1.6, 2.0 s (capped). With
# `retries=3` total wait before raising is ~0.7 s — short enough to fit
# inside any reasonable caller's request budget while letting Redis finish
# RDB load (typical ~300 ms on our 16 GB / 8 vCPU host).
_REDIS_RETRY_POLICY = Retry(ExponentialBackoff(cap=2.0, base=0.1), retries=3)

# Per § 2.15: 64 connections covers Scrapalot's worst-case (gRPC + Celery
# documents + Celery fast + Celery beat + occasional admin script) at the
# single-user single-host scale. `BlockingConnectionPool` waits for an
# available connection instead of raising `ConnectionError("max connections
# reached")` — deterministic backpressure during recovery storms.
_REDIS_MAX_CONNECTIONS = 64

# socket_keepalive lets the kernel detect a dead Redis between operations
# instead of after the next command times out. health_check_interval=60s
# fires `PING` on idle connections so we never grab a dead one from the
# pool.
_REDIS_CONNECTION_KWARGS = {
    "socket_keepalive": True,
    "health_check_interval": 60,
}


def get_redis_client() -> redis.Redis | Any:
    """
    Get a Redis client instance.

    This function returns a singleton Redis client that can be used throughout the application.
    It automatically handles both regular Redis and embedded Redis (redislite/fakeredis).

    Returns:
        Redis client instance

    Raises:
        RuntimeError: If Redis client cannot be created
    """
    global _redis_client

    if _redis_client is not None:
        # Return existing client
        return _redis_client

    # Get Redis URL from environment
    redis_port = os.getenv("REDIS_PORT", "6379")
    redis_url = os.getenv("REDIS_URL", f"redis://localhost:{redis_port}")

    # Check if we should use embedded Redis
    use_embedded = os.getenv("USE_EMBEDDED_REDIS", "false").lower() == "true"

    try:
        if use_embedded or redis_url.startswith(("redislite://", "fakeredis://")):
            # Use embedded Redis
            logger.info("Creating embedded Redis client")

            # Extract database file from URL if it's a redislite URL
            db_file = None
            if redis_url.startswith("redislite://"):
                db_file = redis_url.replace("redislite://", "")

            embedded_client = get_truly_embedded_redis_client(db_file)
            if embedded_client:
                _redis_client = embedded_client
                logger.info("Successfully created embedded Redis client")
                return _redis_client
            else:
                raise RuntimeError("Failed to create embedded Redis client")

        else:
            # Use regular Redis with a BlockingConnectionPool + retry policy.
            # See module-level docstrings on _REDIS_RETRYABLE_ERRORS and
            # _REDIS_MAX_CONNECTIONS for rationale. Migrating away from
            # `redis.from_url` because the default ConnectionPool is unbounded
            # (max_connections=2**31) and has no retry policy — both surfaced
            # as recovery-storm failures. See README_BACKGROUND_JOBS.md
            # "Quick-wins" row in the Phase numbering table.
            logger.info("Creating regular Redis client from URL: %s", redis_url)

            redis_password = os.getenv("REDIS_PASSWORD")

            pool_kwargs: dict[str, Any] = {
                "max_connections": _REDIS_MAX_CONNECTIONS,
                "timeout": None,  # wait for available connection rather than ConnectionError
                "socket_connect_timeout": 5,
                "decode_responses": False,
                **_REDIS_CONNECTION_KWARGS,
            }
            if redis_password:
                pool_kwargs["password"] = redis_password

            pool = redis.BlockingConnectionPool.from_url(redis_url, **pool_kwargs)
            _redis_client = redis.Redis(
                connection_pool=pool,
                retry=_REDIS_RETRY_POLICY,
                retry_on_error=list(_REDIS_RETRYABLE_ERRORS),
            )

            # Test the connection
            _redis_client.ping()
            logger.info("Successfully created regular Redis client (BlockingConnectionPool, max_connections=%d)", _REDIS_MAX_CONNECTIONS)
            return _redis_client

    except Exception as e:
        logger.error("Failed to create Redis client: %s", str(e))
        logger.info("Attempting to fall back to embedded Redis")

        # Try embedded Redis as fallback
        try:
            embedded_client = get_truly_embedded_redis_client()
            if embedded_client:
                _redis_client = embedded_client
                logger.info("Successfully created embedded Redis client as fallback")
                return _redis_client
        except Exception as fallback_error:
            logger.error("Failed to create embedded Redis client as fallback: %s", str(fallback_error))

        raise RuntimeError(f"Failed to create Redis client: {e!s}") from e


def reset_redis_client() -> None:
    """
    Reset the global Redis client instance.

    This is useful for testing or when Redis configuration changes.
    """
    global _redis_client

    if _redis_client is not None:
        try:
            # Try to close the connection gracefully
            if hasattr(_redis_client, "close"):
                _redis_client.close()
        except Exception as e:
            logger.warning("Error closing Redis client: %s", str(e))
        finally:
            _redis_client = None
            logger.info("Redis client reset")


def test_redis_connection() -> bool:
    """
    Test if Redis connection is working.

    Returns:
        bool: True if connection is successful, False otherwise
    """
    try:
        client = get_redis_client()
        client.ping()
        return True
    except Exception as e:
        logger.error("Redis connection test failed: %s", str(e))
        return False
