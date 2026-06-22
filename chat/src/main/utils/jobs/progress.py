"""
Job progress helpers.

Two related concerns that used to live in separate modules:

1. **In-process streaming callbacks** — populate an ``asyncio.Queue`` so a
   streaming HTTP response can yield progress JSON lines, and a
   companion DB-update callback for the ``jobs`` table.
2. **Cross-process publishing** — Celery workers and async tasks in
   foreign event loops can't emit WebSocket messages directly, so they
   push updates onto a Redis pub/sub channel which the chat process
   subscribes to and forwards via STOMP / WebSocket.

Both flows speak the same shape, so they're consolidated here.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import json
from typing import Any

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

JOB_PROGRESS_CHANNEL = "scrapalot:job_progress"
"""Redis pub/sub channel for job progress updates."""


# ---------------------------------------------------------------------------
# In-process callbacks (streaming queue + DB updates)
# ---------------------------------------------------------------------------


def create_streaming_progress_callback(
    progress_queue: asyncio.Queue,
    job_manager_callback: Callable | None = None,
) -> Callable[[str, dict[str, Any]], None]:
    """Return a callback that enqueues progress updates for live streaming.

    The returned callable accepts ``(job_id, progress_data)`` and pushes a
    status packet onto ``progress_queue``. If ``job_manager_callback`` is
    provided it is invoked first (e.g. to update an in-memory job-status
    dict).
    """

    def _callback(job_id: str, progress_data: dict[str, Any]) -> None:
        if job_manager_callback:
            job_manager_callback(job_id, progress_data)
        try:
            progress_queue.put_nowait(
                {
                    "type": "status",
                    "content": {
                        "progress": progress_data.get("progress", 0),
                        "message": progress_data.get("message", "Processing..."),
                        "status": progress_data.get("status", "processing"),
                    },
                }
            )
        except asyncio.QueueFull:
            logger.warning("Progress queue full, dropping update")

    return _callback


def create_database_progress_callback(db_session, job_instance) -> Callable[[str, dict[str, Any]], None]:
    """Return a callback that writes progress + message back to a Job ORM row."""

    def _callback(job_id: str, progress_data: dict[str, Any]) -> None:
        try:
            if db_session and job_instance:
                job_instance.progress = progress_data.get("progress", job_instance.progress)
                job_instance.message = progress_data.get("message", job_instance.message)
                db_session.commit()
        except Exception as e:
            logger.error("Error updating progress for job %s: %s", job_id, str(e))

    return _callback


async def process_streaming_updates(progress_queue: asyncio.Queue, timeout: float = 0.1) -> str | None:
    """Pop one progress update off ``progress_queue`` as a JSON line (or ``None`` on timeout)."""
    try:
        progress_update = await asyncio.wait_for(progress_queue.get(), timeout=timeout)
        return json.dumps(progress_update) + "\n"
    except TimeoutError:
        return None
    except Exception as e:
        logger.warning("Error processing progress updates: %s", str(e))
        return None


def drain_remaining_updates(progress_queue: asyncio.Queue) -> list[str]:
    """Drain every pending update from ``progress_queue`` as JSON lines."""
    updates: list[str] = []
    try:
        while True:
            progress_update = progress_queue.get_nowait()
            updates.append(json.dumps(progress_update) + "\n")
    except asyncio.QueueEmpty:
        # Expected: queue drained, loop is finished.
        pass
    except Exception as e:
        logger.warning("Error draining progress updates: %s", str(e))
    return updates


# ---------------------------------------------------------------------------
# Cross-process publishing (Redis pub/sub)
# ---------------------------------------------------------------------------


def publish_job_progress(
    job_id: str,
    document_id: str,
    user_id: str,
    collection_id: str,
    progress: float,
    message: str,
    status: str = "processing",
    filename: str | None = None,
) -> bool:
    """Publish a progress update to the shared Redis pub/sub channel.

    Safe to call from any context (Celery worker, async, sync). The chat
    process subscribes to ``JOB_PROGRESS_CHANNEL`` and forwards each
    update to the client over STOMP / WebSocket.
    """
    try:
        from src.main.utils.redis.client import get_redis_client

        redis_client = get_redis_client()
        payload = json.dumps(
            {
                "job_id": job_id,
                "document_id": document_id,
                "user_id": user_id,
                "collection_id": collection_id,
                "progress": progress,
                "message": message,
                "status": status,
                "filename": filename,
            }
        )
        redis_client.publish(JOB_PROGRESS_CHANNEL, payload)
        logger.debug("Published job progress: job=%s, progress=%s%%, status=%s", job_id, progress, status)
        return True
    except Exception as e:
        logger.warning("Failed to publish job progress to Redis: %s", e)
        return False
