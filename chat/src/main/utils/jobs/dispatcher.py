"""
Background Task Dispatcher — asyncio-based execution.

Dispatches background tasks via ``asyncio.create_task()`` within the
running event loop. The historical Celery-based worker layer was removed
(see ``get_worker_health``); these helpers are now the single entry point
for fire-and-forget work inside the chat process.

Usage::

    from src.main.utils.jobs import dispatch_background_task

    dispatch_background_task(
        task_name="entity_extraction",
        task_func=extract_entities_async,
        task_args=(document_id, user_id),
        task_kwargs={"job_id": job_id},
    )
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def dispatch_background_task(
    task_name: str,
    task_func: Callable,
    task_args: tuple = (),
    task_kwargs: dict[str, Any] | None = None,
    _queue: str = "default",
) -> bool:
    """Dispatch ``task_func`` as a background ``asyncio.Task``.

    Returns ``True`` if the task was scheduled successfully. Logs the
    completion result (success / failure / soft-failure dict) via the
    standard done-callback.
    """
    kwargs: dict[str, Any] = task_kwargs or {}

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        logger.error("Cannot dispatch %s: no event loop running.", task_name)
        return False

    try:
        task = asyncio.create_task(task_func(*task_args, **kwargs), name=task_name)
    except Exception:
        logger.exception("Failed to dispatch %s", task_name)
        return False

    def _on_done(future: asyncio.Future) -> None:
        try:
            exc = future.exception()
        except asyncio.CancelledError:
            logger.info("Background task '%s' was cancelled", task_name)
            return
        if exc is not None:
            logger.error("Background task '%s' failed: %s", task_name, exc, exc_info=exc)
            return
        result = future.result()
        if isinstance(result, dict) and result.get("success") is False:
            error_msg = result.get("error", result.get("message", "Unknown error"))
            logger.error("Background task '%s' failed: %s", task_name, error_msg)
        else:
            logger.info("Background task '%s' completed successfully", task_name)

    task.add_done_callback(_on_done)
    logger.info("Dispatched %s to asyncio background task", task_name)
    return True


async def run_background_task_async(
    task_func: Callable,
    task_args: tuple = (),
    task_kwargs: dict[str, Any] | None = None,
) -> Any:
    """Run ``task_func`` inline and return its result. Re-raises on error."""
    kwargs: dict[str, Any] = task_kwargs or {}
    try:
        return await task_func(*task_args, **kwargs)
    except Exception:
        logger.exception("Background task execution failed")
        raise


def get_worker_health() -> dict[str, Any]:
    """Legacy worker-health probe. Celery workers no longer run in-process."""
    return {
        "enabled": False,
        "available": False,
        "worker_count": 0,
        "status": "disabled",
        "message": "Background workers removed; tasks run via asyncio.create_task()",
    }
