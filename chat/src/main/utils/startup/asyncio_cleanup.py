"""
Asyncio cleanup utilities.

Robust task / event-loop teardown that avoids the GC exceptions we used
to see during shutdown. The :class:`AsyncioTaskManager` tracks tasks we
explicitly spawn, while :func:`cleanup_all_asyncio_tasks` is a final
safety net that targets every live task on the current loop.
"""

from __future__ import annotations

import asyncio
import gc
import weakref

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class AsyncioTaskManager:
    """Track asyncio tasks via weak refs so they can be cancelled on shutdown."""

    def __init__(self) -> None:
        self._tracked_tasks: set[weakref.ReferenceType[asyncio.Task]] = set()
        self._cleanup_in_progress = False

    def track_task(self, task: asyncio.Task) -> asyncio.Task:
        """Add ``task`` to the tracked set (skipped during shutdown)."""
        if not self._cleanup_in_progress:
            self._tracked_tasks.add(weakref.ref(task))
        return task

    def create_tracked_task(self, coro, *, name: str | None = None) -> asyncio.Task:
        """``asyncio.create_task`` shortcut that registers the task."""
        return self.track_task(asyncio.create_task(coro, name=name))

    async def cleanup_all_tasks(self, timeout: float = 5.0) -> int:
        """Cancel every live tracked task and return the count successfully cancelled."""
        self._cleanup_in_progress = True
        try:
            live_tasks: list[asyncio.Task] = []
            for task_ref in list(self._tracked_tasks):
                task = task_ref()
                if task is not None and not task.done():
                    live_tasks.append(task)

            if not live_tasks:
                logger.debug("No tracked tasks to clean up")
                return 0

            logger.debug("Cleaning up %s tracked tasks", len(live_tasks))
            for task in live_tasks:
                if not task.cancelled():
                    task.cancel("TaskManager cleanup")

            try:
                await asyncio.wait_for(
                    asyncio.gather(*live_tasks, return_exceptions=True),
                    timeout=timeout,
                )
            except TimeoutError:
                logger.warning("Some tasks did not cancel within %s seconds", timeout)

            cancelled_count = sum(1 for task in live_tasks if task.cancelled())
            logger.debug("Successfully cancelled %s/%s tracked tasks", cancelled_count, len(live_tasks))
            return cancelled_count
        finally:
            self._tracked_tasks.clear()
            self._cleanup_in_progress = False


# Module-level singleton.
task_manager = AsyncioTaskManager()


async def cleanup_all_asyncio_tasks(timeout: float = 5.0) -> int:
    """Cancel every live task on the current event loop (except the caller).

    Returns the number of tasks that were cancelled. Always tries to
    fail gracefully — never raises during shutdown.
    """
    try:
        current_task = asyncio.current_task()
        all_tasks = [t for t in asyncio.all_tasks() if not t.done() and t is not current_task]

        if not all_tasks:
            logger.debug("No asyncio tasks to clean up")
            return 0

        logger.debug("Cleaning up %s asyncio tasks", len(all_tasks))

        cancelled_tasks: list[asyncio.Task] = []
        for task in all_tasks:
            if task.cancelled() or task.done():
                continue
            try:
                task.cancel("Application shutdown")
                cancelled_tasks.append(task)
            except Exception as cancel_error:
                logger.debug("Error cancelling task %s: %s", task, cancel_error)

        if not cancelled_tasks:
            logger.debug("No tasks needed cancellation")
            return 0

        try:
            results = await asyncio.wait_for(
                asyncio.gather(*cancelled_tasks, return_exceptions=True),
                timeout=timeout,
            )
            cancelled_count = sum(1 for r in results if isinstance(r, asyncio.CancelledError))
            logger.debug("Successfully cancelled %s/%s asyncio tasks", cancelled_count, len(cancelled_tasks))
            return cancelled_count

        except TimeoutError:
            logger.warning("Task cancellation timed out after %s seconds", timeout)
            for task in cancelled_tasks:
                if not task.done():
                    try:
                        task.cancel()
                    except Exception as e:
                        logger.debug("Non-critical operation failed: %s", e)
            return len(cancelled_tasks)

        except asyncio.CancelledError:
            logger.debug("🧹 Cleanup was cancelled during shutdown - this is expected")
            return len(cancelled_tasks)

        except Exception as wait_error:
            logger.warning("Error waiting for task cancellation: %s", str(wait_error))
            return len(cancelled_tasks)

    except Exception as cleanup_error:
        logger.error("Error during asyncio task cleanup: %s", str(cleanup_error))
        return 0


def cleanup_event_loop() -> None:
    """Cancel pending tasks and close the current event loop.

    Should be called in a ``finally`` block during application shutdown
    to avoid GC exceptions during interpreter teardown.
    """
    try:
        logger.debug("Performing event loop cleanup...")

        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            logger.debug("Event loop already closed or not available")
            return

        if loop.is_closed():
            logger.debug("Event loop already closed")
            return

        all_tasks = asyncio.all_tasks(loop)
        pending_tasks = [t for t in all_tasks if not t.done()]

        if pending_tasks:
            logger.debug("Cancelling %s remaining tasks in event loop", len(pending_tasks))
            for task in pending_tasks:
                if task.cancelled() or task.done():
                    continue
                try:
                    task.cancel("Event loop cleanup - aggressive shutdown")
                    task_name = getattr(task, "_name", "unnamed")
                    logger.debug("Cancelled task: %s", task_name)
                except Exception as cancel_error:
                    logger.debug("Error cancelling task %s: %s", task, cancel_error)

            for attempt in range(3):
                try:
                    loop.run_until_complete(asyncio.sleep(0.05))
                    still_pending = [t for t in pending_tasks if not t.done()]
                    if not still_pending:
                        logger.debug("All tasks cancelled successfully after attempt %s", attempt + 1)
                        break
                    logger.debug("Attempt %s: %s tasks still pending", attempt + 1, len(still_pending))
                except Exception as run_error:
                    logger.debug("Error during cleanup attempt %s: %s", attempt + 1, run_error)
                    break

        gc.collect()
        try:
            loop.close()
            logger.debug("Event loop closed successfully")
        except Exception as close_error:
            logger.debug("Error closing event loop: %s", str(close_error))
        gc.collect()

    except Exception as cleanup_error:
        logger.debug("Error during event loop cleanup: %s", str(cleanup_error))
