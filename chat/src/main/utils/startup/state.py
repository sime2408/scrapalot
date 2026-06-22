"""
Startup state management for tracking initialization progress.

Centralised, thread-safe singleton that records the status of each
heavy-init task (DB, Redis, model deployment, ...) so the
``/health/ready`` endpoint can answer accurately even when requests
arrive after port binding but before initialization is complete.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import datetime
from enum import Enum
import threading
from typing import Any

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class InitializationStatus(str, Enum):
    """Enumeration of possible initialization states."""

    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class InitializationTask:
    """Represents a single initialization task."""

    name: str
    status: InitializationStatus = InitializationStatus.NOT_STARTED
    started_at: datetime.datetime | None = None
    completed_at: datetime.datetime | None = None
    error_message: str | None = None
    details: dict[str, Any] = field(default_factory=dict)


_DEFAULT_TASKS: tuple[str, ...] = (
    "database_connection",
    "database_schema",
    "redis_setup",
    "model_deployment",
    "diagnostics",
    "grpc_server",
)


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.UTC)


class StartupStateManager:
    """Thread-safe singleton tracking per-task initialization progress."""

    _instance: StartupStateManager | None = None
    _lock = threading.Lock()

    def __new__(cls) -> StartupStateManager:
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    inst = super().__new__(cls)
                    inst._initialized = False
                    cls._instance = inst
        return cls._instance

    def __init__(self) -> None:
        if self._initialized:
            return
        self._tasks: dict[str, InitializationTask] = {name: InitializationTask(name=name) for name in _DEFAULT_TASKS}
        self._overall_status = InitializationStatus.NOT_STARTED
        self._startup_time = _now()
        self._task_lock = threading.Lock()
        self._initialized = True

    # ------------------------------------------------------------------ writes

    def start_task(self, task_name: str, details: dict[str, Any] | None = None) -> None:
        """Mark ``task_name`` as in-progress (creates it if unknown)."""
        with self._task_lock:
            task = self._tasks.setdefault(task_name, InitializationTask(name=task_name))
            task.status = InitializationStatus.IN_PROGRESS
            task.started_at = _now()
            if details:
                task.details.update(details)
            if self._overall_status == InitializationStatus.NOT_STARTED:
                self._overall_status = InitializationStatus.IN_PROGRESS
            logger.debug("Started initialization task: %s", task_name)

    def complete_task(self, task_name: str, details: dict[str, Any] | None = None) -> None:
        """Mark ``task_name`` as completed successfully."""
        with self._task_lock:
            task = self._tasks.get(task_name)
            if task is None:
                logger.warning("Attempting to complete unknown task: %s", task_name)
                return
            task.status = InitializationStatus.COMPLETED
            task.completed_at = _now()
            if details:
                task.details.update(details)
            logger.debug("Completed initialization task: %s", task_name)
            self._update_overall_status_locked()

    def fail_task(self, task_name: str, error_message: str, details: dict[str, Any] | None = None) -> None:
        """Mark ``task_name`` as failed."""
        with self._task_lock:
            task = self._tasks.setdefault(task_name, InitializationTask(name=task_name))
            task.status = InitializationStatus.FAILED
            task.completed_at = _now()
            task.error_message = error_message
            if details:
                task.details.update(details)
            logger.error("Failed initialization task %s: %s", task_name, error_message)
            self._update_overall_status_locked()

    def _update_overall_status_locked(self) -> None:
        """Recompute the overall status. Caller must hold ``self._task_lock``."""
        if not self._tasks:
            return
        statuses = [task.status for task in self._tasks.values()]
        if any(s == InitializationStatus.FAILED for s in statuses):
            self._overall_status = InitializationStatus.FAILED
        elif all(s == InitializationStatus.COMPLETED for s in statuses):
            self._overall_status = InitializationStatus.COMPLETED
            logger.info("All initialization tasks completed successfully")
        elif any(s == InitializationStatus.IN_PROGRESS for s in statuses):
            self._overall_status = InitializationStatus.IN_PROGRESS
        else:
            self._overall_status = InitializationStatus.NOT_STARTED

    # ------------------------------------------------------------------ reads

    def get_task_status(self, task_name: str) -> InitializationTask | None:
        with self._task_lock:
            return self._tasks.get(task_name)

    def get_overall_status(self) -> InitializationStatus:
        return self._overall_status

    def is_ready(self) -> bool:
        """Whether the application is fully initialized and ready."""
        return self._overall_status == InitializationStatus.COMPLETED

    def is_healthy(self) -> bool:
        """Whether the application is healthy (i.e., not in FAILED state)."""
        return self._overall_status != InitializationStatus.FAILED

    def get_status_summary(self) -> dict[str, Any]:
        """Return a comprehensive serialisable summary."""
        with self._task_lock:
            now = _now()
            uptime = (now - self._startup_time).total_seconds()

            task_summaries: dict[str, dict[str, Any]] = {}
            for name, task in self._tasks.items():
                if task.started_at:
                    end_time = task.completed_at or now
                    duration = (end_time - task.started_at).total_seconds()
                else:
                    duration = None
                task_summaries[name] = {
                    "status": task.status.value,
                    "started_at": task.started_at.isoformat() if task.started_at else None,
                    "completed_at": task.completed_at.isoformat() if task.completed_at else None,
                    "duration_seconds": duration,
                    "error_message": task.error_message,
                    "details": task.details,
                }

            return {
                "overall_status": self._overall_status.value,
                "startup_time": self._startup_time.isoformat(),
                "uptime_seconds": uptime,
                "tasks": task_summaries,
                "ready": self.is_ready(),
                "healthy": self.is_healthy(),
            }


# Module-level singleton accessors.
startup_state = StartupStateManager()


def get_startup_state() -> StartupStateManager:
    """Return the global startup-state manager."""
    return startup_state
