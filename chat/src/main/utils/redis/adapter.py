"""
Redis adapter for truly embedded Redis integration with LangChain.
Provides compatibility between embedded Redis clients and LangChain's Redis expectations.
"""

import os
import tempfile
from typing import Any

import redis

from src.main.config.redis_embedded import REDISLITE_AVAILABLE, get_truly_embedded_redis_client
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Try to import redislite and fakeredis
try:
    import redislite
except ImportError:
    redislite = None

try:
    import fakeredis
except ImportError:
    fakeredis = None


class RedisAdapter:
    """
    Adapter to make truly embedded Redis clients work with LangChain's Redis expectations.
    """

    def __init__(self, client: Any):
        self.client = client
        # noinspection PyUnresolvedReferences
        self._is_embedded = isinstance(client, (redislite.Redis if redislite else type(None), fakeredis.FakeRedis if fakeredis else type(None)))

    def __getattr__(self, name: str) -> Any:
        """Delegate all attribute access to the underlying Redis client."""
        return getattr(self.client, name)

    def is_embedded(self) -> bool:
        """Check if this is an embedded Redis client."""
        return self._is_embedded


def create_redis_client_from_config(redis_config: dict) -> redis.Redis | RedisAdapter:
    """
    Create a Redis client from configuration, handling both regular and embedded Redis.

    Args:
        redis_config: Redis configuration dictionary with 'url', 'password', and 'is_embedded' keys

    Returns:
        Redis client instance (regular Redis or embedded via adapter)
    """
    redis_url = redis_config.get("url")
    # `password` previously consumed here for the bare `redis.from_url(...)`
    # path; that path now defers to `get_redis_client()` which reads
    # REDIS_PASSWORD from the environment itself, so the arg is unused.
    is_embedded = redis_config.get("is_embedded", False)

    if is_embedded:
        logger.info("Creating truly embedded Redis client")

        # Extract database file from URL if it's a redislite URL
        # noinspection PyUnresolvedReferences
        if redis_url and redis_url.startswith("redislite://"):
            # noinspection PyUnresolvedReferences
            db_file = redis_url.replace("redislite://", "")
        # noinspection PyUnresolvedReferences
        elif redis_url and redis_url.startswith("fakeredis://"):
            # fakeredis doesn't use files
            db_file = None
        else:
            # Default database file location
            db_file = os.path.join(tempfile.gettempdir(), "scrapalot_redis.db")

        embedded_client = get_truly_embedded_redis_client(db_file)
        if embedded_client:
            return RedisAdapter(embedded_client)
        else:
            logger.error("Failed to create embedded Redis client")
            raise RuntimeError("Failed to create embedded Redis client")

    else:
        logger.info("Creating regular Redis client from URL: %s", redis_url)
        # Defer to the canonical client factory so this adapter gets the
        # same BlockingConnectionPool + retry-on-BusyLoadingError treatment.
        # Previously created a bare `redis.from_url(...)` with no retry
        # policy — failed under recovery storm. Return the raw client to
        # preserve the original return type for callers that pass directly
        # to libraries expecting `redis.Redis` (LangChain Redis components).
        # See README_BACKGROUND_JOBS.md "Quick-wins" row in the Phase
        # numbering table for rationale.
        from src.main.utils.redis.client import get_redis_client

        return get_redis_client()


def get_redis_url_for_langchain(redis_config: dict) -> str:
    """
    Get Redis URL for LangChain components that require URL strings.
    For embedded Redis, this creates a special URL that can be handled by custom components.

    Args:
        redis_config: Redis configuration dictionary

    Returns:
        str: Redis URL suitable for LangChain components
    """
    redis_url = redis_config.get("url")
    is_embedded = redis_config.get("is_embedded", False)

    if is_embedded:
        # For embedded Redis, we need to provide a URL that our custom components can handle
        if REDISLITE_AVAILABLE:
            # Use the actual database file path
            # noinspection PyUnresolvedReferences
            if redis_url and redis_url.startswith("redislite://"):
                return str(redis_url)
            else:
                db_file = os.path.join(tempfile.gettempdir(), "scrapalot_redis.db")
                return f"redislite://{db_file}"
        else:
            # fakeredis fallback
            return "fakeredis://localhost:6380"
    else:
        # Regular Redis URL
        return str(redis_url) if redis_url else ""


class EmbeddedRedisChatMessageHistory:
    """
    Custom chat message history that works with truly embedded Redis.
    Drop-in replacement for LangChain's RedisChatMessageHistory when using embedded Redis.
    """

    def __init__(self, session_id: str, url: str, ttl: int | None = None, **kwargs):
        """
        Initialize embedded Redis chat message history.

        Args:
            session_id: Session identifier
            url: Redis URL (can be redislite:// or fakeredis:// for embedded)
            ttl: Time to live for messages
            **kwargs: Additional arguments (for compatibility)
        """
        self.session_id = session_id
        self.ttl = ttl
        self.key_prefix = kwargs.get("key_prefix", "message_store:")

        # Determine if this is an embedded Redis URL
        if url.startswith("redislite://") or url.startswith("fakeredis://"):
            logger.info("Using embedded Redis for chat history: %s", session_id)

            # Extract database file for redislite
            db_file = None
            if url.startswith("redislite://"):
                db_file = url.replace("redislite://", "")

            # Get embedded Redis client
            self.redis_client = get_truly_embedded_redis_client(db_file)
            if not self.redis_client:
                raise RuntimeError("Failed to create embedded Redis client for chat history")

            self._is_embedded = True

        else:
            logger.info("Using regular Redis for chat history: %s", session_id)
            # Regular Redis client
            self.redis_client = redis.from_url(url, socket_connect_timeout=5)
            self._is_embedded = False

    @property
    def key(self) -> str:
        """Get the Redis key for this session."""
        return f"{self.key_prefix}{self.session_id}"

    @property
    def messages(self):
        """Get messages from Redis."""
        # Import here to avoid circular imports
        from langchain_core.messages import messages_from_dict

        try:
            # noinspection PyTypeChecker,PyUnresolvedReferences
            items: list = self.redis_client.lrange(self.key, 0, -1)
            messages = []
            for item in items:
                # Handle both string and bytes
                if isinstance(item, bytes):
                    item = item.decode("utf-8")

                # Parse JSON
                import json

                message_data = json.loads(item)
                messages.extend(messages_from_dict([message_data]))
            return messages
        except Exception as e:
            logger.warning("Failed to load messages for session %s: %s", self.session_id, str(e))
            return []

    def add_message(self, message) -> None:
        """Add a message to Redis."""
        # Import here to avoid circular imports
        from langchain_core.messages import message_to_dict

        try:
            import json

            message_dict = message_to_dict(message)
            message_json = json.dumps(message_dict)

            # Add to Redis list
            # noinspection PyUnresolvedReferences
            self.redis_client.lpush(self.key, message_json)

            # Set TTL if specified
            if self.ttl:
                # noinspection PyUnresolvedReferences
                self.redis_client.expire(self.key, self.ttl)

        except Exception as e:
            logger.error("Failed to add message for session %s: %s", self.session_id, str(e))

    def clear(self) -> None:
        """Clear all messages for this session."""
        try:
            # noinspection PyUnresolvedReferences
            self.redis_client.delete(self.key)
        except Exception as e:
            logger.error("Failed to clear messages for session %s: %s", self.session_id, str(e))


def patch_langchain_redis_for_embedded():
    """
    Monkey patch LangChain's RedisChatMessageHistory to work with embedded Redis.
    This allows existing code to work without modifications.
    """
    try:
        from langchain_community.chat_message_histories import redis as langchain_redis_module

        # Store original class
        original_redis_chat_history = langchain_redis_module.RedisChatMessageHistory

        def patched_redis_chat_history_init(
            self,
            session_id: str,
            url: str | None = None,
            key_prefix: str = "message_store:",
            ttl: int | None = None,
            **kwargs,
        ):
            """Patched init that handles embedded Redis URLs."""

            # Use environment variable for port if URL not provided
            if url is None:
                redis_port = os.getenv("REDIS_PORT", "6379")
                url = f"redis://localhost:{redis_port}"

            # noinspection PyUnresolvedReferences
            if url.startswith("redislite://") or url.startswith("fakeredis://"):
                # Use our embedded Redis implementation
                logger.info("Redirecting to embedded Redis chat history for session: %s", session_id)
                # noinspection PyArgumentList,PyTypeChecker
                embedded_history = EmbeddedRedisChatMessageHistory(session_id=session_id, url=url, ttl=ttl, key_prefix=key_prefix, **kwargs)

                # Copy attributes to self
                self.__dict__.update(embedded_history.__dict__)

            else:
                # Use original implementation
                # noinspection PyArgumentList
                original_redis_chat_history.__init__(self, session_id, url, key_prefix, ttl, **kwargs)

        # Apply the patch
        langchain_redis_module.RedisChatMessageHistory.__init__ = patched_redis_chat_history_init
        logger.info("Successfully patched LangChain RedisChatMessageHistory for embedded Redis support")

    except ImportError as e:
        logger.warning("Could not patch LangChain Redis components: %s", str(e))
    except Exception as e:
        logger.error("Error patching LangChain Redis components: %s", str(e))
