"""
Truly embedded Redis server utility for scrapalot-chat.
Uses redislite to provide a self-contained Redis server with no external dependencies.
"""

import os
import tempfile

import redis

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Try to import redislite and fakeredis
# Note: These are optional dependencies for embedded Redis fallback
# Workers with external Redis don't need these
try:
    # noinspection PyPackageRequirements
    import redislite

    REDISLITE_AVAILABLE = True
    logger.info("Using redislite for truly embedded Redis")
except ImportError:
    redislite = None  # type: ignore[assignment]
    try:
        import fakeredis

        REDISLITE_AVAILABLE = False
        logger.info("redislite not available, using fakeredis as fallback")
    except ImportError:
        fakeredis = None  # type: ignore[assignment]
        # Don't raise error - external Redis may be available
        REDISLITE_AVAILABLE = None
        logger.debug("Neither redislite nor fakeredis available - will use external Redis if configured")


class TrulyEmbeddedRedisServer:
    """
    Truly embedded Redis server using redislite (preferred) or fakeredis (fallback).
    No external Redis installation is required.
    """

    def __init__(self, db_file: str | None = None, port: int | None = None):
        """
        Initialize a truly embedded Redis server.

        Args:
            db_file: Path to Redis database file (only used with redislite)
            port: Port number (ignored for redislite, used for fakeredis compatibility)
        """
        self.db_file = db_file or os.path.join(tempfile.gettempdir(), "scrapalot_redis.db")
        self.port = port or 6380
        self._redis_client: redis.Redis | None = None
        self._running = False

    def start(self) -> bool:
        """
        Start the embedded Redis server.

        Returns:
            bool: True if started successfully, False otherwise
        """
        if REDISLITE_AVAILABLE is None:
            logger.error("Cannot start embedded Redis - no implementation available (redislite or fakeredis not installed)")
            return False

        try:
            if REDISLITE_AVAILABLE:
                # Use redislite - truly embedded with actual Redis binary
                logger.info("Starting redislite embedded Redis server with db file: %s", self.db_file)
                _client = redislite.Redis(self.db_file)  # type: ignore[union-attr]
                _client.ping()
                self._redis_client = _client
                logger.info("redislite Redis server started successfully")

            else:
                # Use fakeredis as fallback
                logger.info("Starting fakeredis embedded Redis server")
                import fakeredis

                _client = fakeredis.FakeRedis(decode_responses=True)
                _client.ping()
                self._redis_client = _client
                logger.info("fakeredis Redis server started successfully")

            self._running = True
            return True

        except Exception as e:
            logger.error("Failed to start embedded Redis server: %s", str(e))
            self._redis_client = None
            self._running = False
            return False

    def stop(self) -> None:
        """Stop the embedded Redis server."""
        if self._redis_client and self._running:
            try:
                if REDISLITE_AVAILABLE and hasattr(self._redis_client, "shutdown"):
                    # Redislite cleanup
                    logger.info("Shutting down redislite Redis server")
                    self._redis_client.shutdown()
                else:
                    # Fakeredis cleanup (minimal)
                    logger.info("Cleaning up fakeredis Redis server")
                    if hasattr(self._redis_client, "flushall"):
                        self._redis_client.flushall()

            except Exception as e:
                logger.warning("Error during Redis server shutdown: %s", str(e))
            finally:
                self._redis_client = None
                self._running = False
                logger.info("Embedded Redis server stopped")

    def get_redis_client(self) -> redis.Redis | None:
        """
        Get the Redis client instance.

        Returns:
            Redis client instance or None if not started
        """
        return self._redis_client

    def get_connection_url(self) -> str:
        """
        Get Redis connection URL.

        Returns:
            str: Redis connection URL with a special prefix for embedded Redis handling
        """
        if REDISLITE_AVAILABLE:
            return f"redislite://{self.db_file}"
        else:
            return f"fakeredis://localhost:{self.port}"

    def is_running(self) -> bool:
        """
        Check if the Redis server is running.

        Returns:
            bool: True if running, False otherwise
        """
        if not self._running or not self._redis_client:
            return False

        # noinspection PyBroadException
        try:
            self._redis_client.ping()
            return True
        except Exception:
            return False

    def get_info(self) -> dict:
        """
        Get Redis server information.

        Returns:
            dict: Server information
        """
        if not self._redis_client:
            return {}

        try:
            info = {
                "type": "redislite" if REDISLITE_AVAILABLE else "fakeredis",
                "running": self.is_running(),
                "db_file": self.db_file if REDISLITE_AVAILABLE else None,
                "port": self.port,
            }

            # Add Redis info if available
            if hasattr(self._redis_client, "info"):
                redis_info: dict = self._redis_client.info()  # type: ignore[assignment]
                info.update(
                    {
                        "redis_version": redis_info.get("redis_version", "embedded"),
                        "used_memory": redis_info.get("used_memory", 0),
                        "connected_clients": redis_info.get("connected_clients", 1),
                    }
                )

            return info
        except Exception as e:
            logger.warning("Failed to get Redis info: %s", str(e))
            return {"error": str(e)}


# Global truly embedded Redis instance
_truly_embedded_redis: TrulyEmbeddedRedisServer | None = None


def get_truly_embedded_redis_client(
    db_file: str | None = None,
) -> redis.Redis | None:
    """
    Get a truly embedded Redis client with automatic server management.

    Args:
        db_file: Path to Redis database file (only used with redislite)

    Returns:
        Redis client instance or None if failed to start
    """
    global _truly_embedded_redis

    if _truly_embedded_redis is None:
        _truly_embedded_redis = TrulyEmbeddedRedisServer(db_file=db_file)

    server = _truly_embedded_redis
    assert server is not None
    if not server.is_running():
        if not server.start():
            logger.error("Failed to start truly embedded Redis server")
            return None

    return server.get_redis_client()


def test_redis_connection_embedded(client) -> bool:
    """
    Test if the embedded Redis connection is working.

    Args:
        client: Redis client instance

    Returns:
        bool: True if the connection is successful, False otherwise
    """
    try:
        if client:
            client.ping()
            return True
        return False
    except Exception as e:
        logger.warning("Embedded Redis connection test failed: %s", str(e))
        return False


def get_redis_config_with_truly_embedded_fallback(primary_redis_url: str, db_file: str | None = None) -> tuple[str | object, bool]:
    """
    Get Redis configuration with a truly embedded fallback.

    Args:
        primary_redis_url: Primary Redis URL to try first
        db_file: Database file for embedded Redis (redislite only)

    Returns:
        tuple[str | object, bool]: (redis_client_or_url, is_embedded)
    """
    # First, try to connect to primary Redis
    try:
        primary_client = redis.from_url(primary_redis_url, socket_connect_timeout=5)
        primary_client.ping()
        logger.info("Primary Redis server is available at %s", primary_redis_url)
        return primary_redis_url, False

    except Exception as e:
        logger.warning("Primary Redis server not available (%s), falling back to truly embedded Redis", str(e))

        # Fall back to truly embedded Redis
        embedded_client = get_truly_embedded_redis_client(db_file)
        if embedded_client:
            logger.info("Using truly embedded Redis server")
            return embedded_client, True
        else:
            logger.error("Failed to start truly embedded Redis server")
            raise RuntimeError("No Redis server available (primary or embedded)") from e


def cleanup_truly_embedded_redis() -> None:
    """Clean up a truly embedded Redis server on application shutdown."""
    global _truly_embedded_redis

    if _truly_embedded_redis:
        logger.info("Cleaning up truly embedded Redis server")
        _truly_embedded_redis.stop()
        _truly_embedded_redis = None
