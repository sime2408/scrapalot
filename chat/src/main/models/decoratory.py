import asyncio
import functools

from fastapi import HTTPException

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def handle_endpoint_errors(operation_description):
    """
    Decorator for handling errors in api_base methods consistently.
    Works with both async and sync functions.

    Args:
            operation_description: Description of the operation for error logs

    Returns:
            Decorator function
    """

    def decorator(func):
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            try:
                return await func(*args, **kwargs)
            except HTTPException:
                raise
            except Exception as e:
                logger.exception("Error %s: %s", operation_description, str(e))
                raise HTTPException(status_code=500, detail=f"Failed to {operation_description}: {e!s}") from e

        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except HTTPException:
                raise
            except Exception as e:
                logger.exception("Error %s: %s", operation_description, str(e))
                raise HTTPException(status_code=500, detail=f"Failed to {operation_description}: {e!s}") from e

        # Return the appropriate wrapper based on whether the function is async or not
        return async_wrapper if asyncio.iscoroutinefunction(func) else sync_wrapper

    return decorator
