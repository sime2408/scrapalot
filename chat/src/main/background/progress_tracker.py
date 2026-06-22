"""
Progress tracking utility for background tasks.

Provides a unified interface for tracking and updating task progress,
similar to document processing progress tracking.
"""

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from src.main.models.sqlmodel_jobs import TaskProgress
from src.main.utils.core.logger import get_logger
from src.main.utils.redis.client import get_redis_client

logger = get_logger(__name__)


class ProgressTracker:
    """Tracks the progress of a background task with database and Redis support."""

    def __init__(
        self,
        task_id: str,
        task_type: str,
        entity_id: UUID | None,
        user_id: UUID,
        workspace_id: UUID | None,
        db: Session,
    ):
        self.task_id = task_id
        self.task_type = task_type
        self.entity_id = entity_id
        self.user_id = user_id
        self.workspace_id = workspace_id
        self.db = db
        self.redis_client = get_redis_client()
        self._progress_record: TaskProgress | None = None

    def _get_or_create_progress(self) -> TaskProgress:
        """Get an existing progress record or create a new one."""
        if self._progress_record:
            return self._progress_record

        # Try to find existing record
        # noinspection PyTypeChecker
        progress = self.db.query(TaskProgress).filter(TaskProgress.task_id == self.task_id).first()

        if not progress:
            # Create new progress record
            progress = TaskProgress(
                task_id=self.task_id,
                task_type=self.task_type,
                entity_id=self.entity_id,
                user_id=self.user_id,
                workspace_id=self.workspace_id,
                status="pending",
                progress_percent=0,
                processed_items=0,
            )
            self.db.add(progress)
            self.db.commit()
            logger.info("Created progress tracker for task %s", self.task_id)

        self._progress_record = progress
        return progress

    def start(self, total_items: int | None = None, current_step: str | None = None):
        """Mark the task as started."""
        progress = self._get_or_create_progress()
        progress.status = "in_progress"
        progress.started_at = datetime.now(UTC).isoformat()
        progress.progress_percent = 0

        if total_items is not None:
            progress.total_items = total_items

        if current_step:
            progress.current_step = current_step

        self.db.commit()
        self._publish_update(progress)
        logger.info("Task %s started: %s", self.task_id, current_step or "Processing")

    def update(
        self,
        processed_items: int | None = None,
        progress_percent: int | None = None,
        current_step: str | None = None,
        total_items: int | None = None,
    ):
        """Update task progress."""
        progress = self._get_or_create_progress()

        if processed_items is not None:
            progress.processed_items = processed_items

        if total_items is not None:
            progress.total_items = total_items

        # Calculate progress percentage
        if progress_percent is not None:
            progress.progress_percent = min(100, max(0, progress_percent))
        elif progress.total_items and progress.total_items > 0:
            total = progress.total_items  # local var so type checker can see it's not None
            done = progress.processed_items or 0
            progress.progress_percent = min(100, int((done / total) * 100))

        if current_step:
            progress.current_step = current_step

        # Estimate completion time
        pct = progress.progress_percent
        if progress.started_at and pct is not None and 0 < pct < 100:
            started = datetime.fromisoformat(progress.started_at)
            elapsed = (datetime.now(UTC) - started).total_seconds()
            estimated_total = elapsed / (pct / 100)
            remaining = estimated_total - elapsed
            progress.estimated_completion_at = (datetime.now(UTC) + timedelta(seconds=remaining)).isoformat()

        self.db.commit()
        self._publish_update(progress)

    def complete(self, result_data: dict[str, Any] | None = None):
        """Mark the task as completed."""
        progress = self._get_or_create_progress()
        progress.status = "completed"
        progress.progress_percent = 100
        progress.completed_at = datetime.now(UTC).isoformat()

        if result_data:
            progress.result_data = result_data

        self.db.commit()
        self._publish_update(progress)
        logger.info("Task %s completed successfully", self.task_id)

    def fail(self, error_message: str):
        """Mark the task as failed."""
        progress = self._get_or_create_progress()
        progress.status = "failed"
        progress.completed_at = datetime.now(UTC).isoformat()
        progress.error_message = error_message

        self.db.commit()
        self._publish_update(progress)
        logger.error("Task %s failed: %s", self.task_id, error_message)

    def cancel(self):
        """Mark the task as canceled."""
        progress = self._get_or_create_progress()
        progress.status = "cancelled"
        progress.completed_at = datetime.now(UTC).isoformat()

        self.db.commit()
        self._publish_update(progress)
        logger.info("Task %s cancelled", self.task_id)

    def _publish_update(self, progress: TaskProgress):
        """Publish progress update to Redis for real-time notifications."""
        try:
            # Publish to user-specific channel
            channel = f"task_progress:{self.user_id}"
            message = progress.to_dict()
            self.redis_client.publish(channel, str(message))

            # Also publish to entity-specific channel if applicable
            if self.entity_id:
                entity_channel = f"task_progress:{self.task_type}:{self.entity_id}"
                self.redis_client.publish(entity_channel, str(message))

        except Exception as e:
            logger.warning("Failed to publish progress update to Redis: %s", e)

    def get_progress(self) -> dict[str, Any] | None:
        """Get current progress as a dictionary."""
        progress = self._get_or_create_progress()
        return progress.to_dict() if progress else None
