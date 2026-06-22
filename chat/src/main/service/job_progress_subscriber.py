"""
Job progress subscriber — bridges Celery workers and WebSocket.

Celery workers publish job progress updates to Redis pub/sub.
This subscriber runs in the main scrapalot-chat process, listens to those
updates, and forwards them to the frontend via WebSocket/STOMP.

Start via: start_job_progress_subscriber() — called from server startup.
"""

import asyncio
import json
import threading

from src.main.utils.core.logger import get_logger
from src.main.utils.jobs.progress import JOB_PROGRESS_CHANNEL

logger = get_logger(__name__)

_subscriber_thread: threading.Thread | None = None
_stop_event = threading.Event()


def start_job_progress_subscriber() -> None:
    """Start the background subscriber thread. Safe to call multiple times."""
    global _subscriber_thread

    if _subscriber_thread is not None and _subscriber_thread.is_alive():
        logger.debug("Job progress subscriber already running")
        return

    _stop_event.clear()
    _subscriber_thread = threading.Thread(
        target=_subscriber_loop,
        name="job-progress-subscriber",
        daemon=True,
    )
    # noinspection PyUnresolvedReferences
    _subscriber_thread.start()
    logger.info("Job progress subscriber started")


def stop_job_progress_subscriber() -> None:
    """Signal the subscriber thread to stop."""
    _stop_event.set()
    logger.info("Job progress subscriber stop requested")


def _subscriber_loop() -> None:
    """
    Main subscriber loop — runs in a daemon thread.

    Subscribes to the Redis pub/sub channel and forwards each message
    to the WebSocket manager for delivery to the correct user.
    """
    pubsub = None
    try:
        from src.main.utils.redis.client import get_redis_client

        redis_client = get_redis_client()
        pubsub = redis_client.pubsub()
        pubsub.subscribe(JOB_PROGRESS_CHANNEL)
        logger.info("Subscribed to Redis channel: %s", JOB_PROGRESS_CHANNEL)

        while not _stop_event.is_set():
            message = pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message is None:
                continue

            if message["type"] != "message":
                continue

            try:
                data = message["data"]
                if isinstance(data, bytes):
                    data = data.decode("utf-8")

                payload = json.loads(data)
                _forward_to_websocket(payload)

            except (json.JSONDecodeError, KeyError) as e:
                logger.warning("Invalid job progress message: %s", e)
            except Exception as e:
                logger.error("Error processing job progress message: %s", e)

    except Exception as e:
        logger.error("Job progress subscriber crashed: %s", e)
    finally:
        # noinspection PyUnboundLocalVariable
        if pubsub is not None:
            try:
                # noinspection PyUnresolvedReferences
                pubsub.unsubscribe(JOB_PROGRESS_CHANNEL)
                # noinspection PyUnresolvedReferences
                pubsub.close()
            except Exception as e:
                logger.debug("Non-critical operation failed: %s", e)
        logger.info("Job progress subscriber stopped")


def _forward_to_websocket(payload: dict) -> None:
    """
    Forward a job progress update to the frontend via Python WebSocket manager.
    """
    try:
        from src.main.utils.websocket.manager import websocket_manager

        if websocket_manager is None:
            logger.debug("WebSocket manager not available, skipping progress forward")
            return

        user_id = payload.get("user_id")
        job_id = payload.get("job_id")
        status = payload.get("status", "processing")

        if not user_id or not job_id:
            logger.debug("Missing user_id or job_id in progress payload, skipping")
            return

        if status in ("completed", "COMPLETED"):
            event_type = "job_completed"
        elif status in ("failed", "FAILED"):
            event_type = "job_failed"
        else:
            event_type = "job_progress"

        notification_job_data = {
            "job_id": job_id,
            "document_id": payload.get("document_id"),
            "collection_id": payload.get("collection_id"),
            "filename": payload.get("filename"),
            "status": status,
            "progress": payload.get("progress", 0),
            "message": payload.get("message", "Processing..."),
        }

        try:
            main_loop = _get_main_event_loop()
            if main_loop and main_loop.is_running():
                # Fan out to two STOMP topics. The knowledge-file-uploader
                # creates a per-job DocumentProcessingTracker that subscribes
                # to /topic/job.{jobId}; if we only publish to the user-wide
                # topic, those per-document progress bars sit at 2 % until
                # the polling fallback lands (or its timeouts expire). Push
                # to both so both subscription styles see live updates.
                asyncio.run_coroutine_threadsafe(
                    websocket_manager.send_user_job_notification(user_id, event_type, notification_job_data),
                    main_loop,
                )
                asyncio.run_coroutine_threadsafe(
                    _publish_to_job_topic(websocket_manager, job_id, notification_job_data),
                    main_loop,
                )
        except Exception as loop_err:
            logger.debug("Cannot schedule WebSocket send: %s", loop_err)

    except Exception as e:
        logger.warning("Error forwarding job progress to WebSocket: %s", e)


async def _publish_to_job_topic(websocket_manager, job_id: str, data: dict) -> None:
    """
    Publish a progress payload to the `/topic/job.{job_id}` STOMP topic.

    Uses the manager's private `_send_stomp_message` so the message hits
    the same transport Socket.IO clients use. Safe no-op if the manager
    is unavailable or STOMP isn't wired in this deployment.
    """
    try:
        # noinspection PyProtectedMember
        from src.main.utils.websocket.manager import FASTAPI_WEBSOCKET_AVAILABLE

        if not FASTAPI_WEBSOCKET_AVAILABLE:
            return
        topic = f"/topic/job.{job_id}"
        # noinspection PyProtectedMember
        await websocket_manager._send_stomp_message(topic, data)
    except Exception as exc:
        logger.debug("Per-job STOMP publish skipped for %s: %s", job_id, exc)


# Reference to the main asyncio event loop (set during startup)
_main_loop: asyncio.AbstractEventLoop | None = None


def set_main_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Store a reference to the main event loop for thread-safe scheduling."""
    global _main_loop
    _main_loop = loop
    logger.debug("Main event loop reference stored for job progress subscriber")


def _get_main_event_loop() -> asyncio.AbstractEventLoop | None:
    """Get the stored main event loop reference."""
    return _main_loop
