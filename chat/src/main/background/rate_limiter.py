"""
Rate Limiter

Implements rate limiting for tasks using Redis.
"""

from functools import wraps
import time

from src.main.config.background_workers import get_rate_limit_for_connector
from src.main.utils.core.logger import get_logger
from src.main.utils.redis.client import get_redis_client

logger = get_logger(__name__)


class RateLimiter:
    """
    Token bucket rate limiter using Redis.
    """

    def __init__(self, key: str, rate: float, burst: int | None = None):
        """
        Initialize rate limiter.

        Args:
            key: Redis key for this rate limiter
            rate: Requests per second
            burst: Maximum burst size (defaults to rate * 2)
        """
        self.key = f"rate_limit:{key}"
        self.rate = rate
        self.burst = burst or int(rate * 2)
        self.redis_client = get_redis_client()

    def acquire(self, tokens: int = 1, block: bool = True, timeout: float | None = None) -> bool:
        """
        Acquire tokens from the bucket.

        Args:
            tokens: Number of tokens to acquire
            block: Whether to block until tokens are available
            timeout: Maximum time to block (seconds)

        Returns:
            True if tokens are acquired, False otherwise
        """
        start_time = time.time()

        while True:
            if self._try_acquire(tokens):
                return True

            if not block:
                return False

            if timeout and (time.time() - start_time) >= timeout:
                return False

            # Wait before retrying
            time.sleep(1.0 / self.rate if self.rate > 0 else 1.0)

    def _try_acquire(self, tokens: int) -> bool:
        """Try to acquire tokens without blocking."""
        try:
            now = time.time()

            # Get current bucket state
            bucket_data: bytes | None = self.redis_client.get(self.key)  # type: ignore[assignment]

            if bucket_data:
                bucket_tokens, last_update = map(float, bucket_data.decode().split(":"))
            else:
                bucket_tokens = float(self.burst)
                last_update = now

            # Calculate tokens to add based on time elapsed
            elapsed = now - last_update
            tokens_to_add = elapsed * self.rate
            bucket_tokens = min(self.burst, bucket_tokens + tokens_to_add)

            # Check if we have enough tokens
            if bucket_tokens >= tokens:
                bucket_tokens -= tokens

                # Update bucket state
                self.redis_client.setex(self.key, int(self.burst / self.rate) + 60, f"{bucket_tokens}:{now}")  # TTL with buffer
                return True

            return False

        except Exception as e:
            logger.error("Rate limiter error: %s", e)
            # On error, allow the request (fail open)
            return True

    def reset(self):
        """Reset the rate limiter."""
        try:
            self.redis_client.delete(self.key)
        except Exception as e:
            logger.error("Failed to reset rate limiter: %s", e)


def rate_limit(key: str, rate: float, burst: int | None = None):
    """
    Decorator to rate limit a function.

    Args:
        key: Rate limiter key
        rate: Requests per second
        burst: Maximum burst size

    Usage:
        @rate_limit("api_calls", rate=10)
        def make_api_call():
            pass
    """

    def decorator(func):
        limiter = RateLimiter(key, rate, burst)

        @wraps(func)
        def wrapper(*args, **kwargs):
            if not limiter.acquire():
                raise Exception(f"Rate limit exceeded for {key}")
            return func(*args, **kwargs)

        return wrapper

    return decorator


class ConnectorRateLimiter:
    """
    Rate limiter specifically for connectors.
    """

    @staticmethod
    def get_limiter(connector_type: str) -> RateLimiter | None:
        """
        Get rate limiter for a connector type.

        Args:
            connector_type: Type of connector (google_drive, dropbox, etc.)

        Returns:
            RateLimiter instance or None if no limit is configured
        """
        rate = get_rate_limit_for_connector(connector_type)

        if rate is None or rate <= 0:
            return None

        return RateLimiter(key=f"connector:{connector_type}", rate=rate, burst=int(rate * 2))

    @staticmethod
    def acquire_for_connector(connector_type: str, tokens: int = 1, block: bool = True, timeout: float | None = None) -> bool:
        """
        Acquire rate limit tokens for a connector.

        Args:
            connector_type: Type of connector
            tokens: Number of tokens to acquire
            block: Whether to block until tokens-available
            timeout: Maximum time to block

        Returns:
            True if tokens are acquired, False otherwise
        """
        limiter = ConnectorRateLimiter.get_limiter(connector_type)

        if not limiter:
            # No rate limit configured
            return True

        return limiter.acquire(tokens, block, timeout)


def with_connector_rate_limit(connector_type_arg: str = "connector_type"):
    """
    Decorator to apply connector rate limiting.

    Args:
        connector_type_arg: Name of the argument containing the connector type

    Usage:
        @with_connector_rate_limit("connector_type")
        def fetch_documents(connector_type: str, ...):
            pass
    """

    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            # Get connector type from arguments
            connector_type = kwargs.get(connector_type_arg)

            if not connector_type and args:
                # Try to get from positional args
                import inspect

                sig = inspect.signature(func)
                param_names = list(sig.parameters.keys())
                if connector_type_arg in param_names:
                    idx = param_names.index(connector_type_arg)
                    if idx < len(args):
                        connector_type = args[idx]

            if connector_type:
                if not ConnectorRateLimiter.acquire_for_connector(str(connector_type)):
                    raise Exception(f"Rate limit exceeded for connector: {connector_type}")

            return func(*args, **kwargs)

        return wrapper

    return decorator


class TaskRateLimiter:
    """
    Rate limiter for background tasks.
    """

    @staticmethod
    def apply_rate_limit(task_name: str, rate: float, burst: int | None = None):
        """
        Apply rate limiting to a task.

        Args:
            task_name: Name of the task
            rate: Requests per second
            burst: Maximum burst size
        """
        limiter = RateLimiter(f"task:{task_name}", rate, burst)

        def rate_limit_decorator(func):
            @wraps(func)
            def wrapper(*args, **kwargs):
                if not limiter.acquire():
                    raise Exception(f"Rate limit exceeded for task: {task_name}")
                return func(*args, **kwargs)

            return wrapper

        return rate_limit_decorator
