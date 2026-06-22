"""
SQLModel models for background jobs and task progress tracking.
"""

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import BigInteger, DateTime, ForeignKey
from sqlmodel import JSON, Column, Field, Text

from src.main.models.sqlmodel_base import BaseModel, ScrapalotUUID

# =============================================================================
# JOB AND TASK MODELS
# =============================================================================


class Job(BaseModel, table=True):
    """
    Asynchronous job tracking for long-running operations.

    Tracks background jobs like document processing, model downloads,
    and other time-intensive operations.
    """

    __tablename__ = "jobs"

    # Job identification
    job_id: str = Field(max_length=100, unique=True, index=True)
    job_type: str = Field(max_length=50, index=True)  # document_processing, model_download, etc.
    job_name: str = Field(max_length=200)  # Human-readable job name

    # Job status
    status: str = Field(max_length=20, default="pending", index=True)  # pending, running, completed, failed
    progress: float = Field(default=0.0)  # Progress percentage (0.0 to 1.0)

    # Job details
    description: str | None = Field(default=None)
    error_message: str | None = Field(default=None, sa_column=Column(Text))

    # Job metadata (renamed from 'metadata' to avoid SQLAlchemy reserved name conflict)
    job_metadata: dict[str, Any] | None = Field(default=None, sa_column=Column("metadata", JSON))
    result: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))

    # Timing information
    started_at: str | None = Field(default=None)  # ISO datetime string
    completed_at: str | None = Field(default=None)  # ISO datetime string

    # Resource usage
    memory_usage_mb: int | None = Field(default=None)
    cpu_time_seconds: float | None = Field(default=None)

    # Related entities
    user_id: UUID | None = Field(sa_column=Column(ScrapalotUUID(), nullable=True, index=True), default=None)
    workspace_id: UUID | None = Field(sa_column=Column(ScrapalotUUID(), nullable=True, index=True), default=None)
    document_id: UUID | None = Field(sa_column=Column(ScrapalotUUID(), ForeignKey("documents.id"), nullable=True, index=True), default=None)

    # Heartbeat counter pattern
    # (adapted from onyx-dot-app/onyx docprocessing/heartbeat.py + tasks.py
    # validate_active_indexing_attempts at lines 130-310).
    #
    # The running task starts a daemon thread that bumps `heartbeat_counter`
    # every 30 s while the task body executes. The JobRecoveryService beat
    # task reads `(counter, last_heartbeat_value, last_heartbeat_time)` to
    # decide whether a task is alive (counter advanced since last snapshot),
    # still active (counter idle but within timeout), or stuck (counter
    # idle past 30 min cutoff → recovery candidate).
    #
    # This replaces the pre-Phase-2 `documents.updated_at` liveness signal
    # which advanced for many reasons unrelated to task progress (status
    # transitions, manual edits, ACL updates) — race-prone source of the
    # JobRecovery Pattern A double-dispatch bug fixed in commit fc0de69.
    # A monotonic counter that only the running task can advance is the
    # clean signal.
    heartbeat_counter: int = Field(
        sa_column=Column(BigInteger, nullable=False, server_default="0"),
        default=0,
    )
    # JobRecovery snapshot: the counter value + wall clock observed on the
    # PREVIOUS beat cycle. If `heartbeat_counter > last_heartbeat_value`
    # the task is making progress; refresh snapshot. If unchanged for
    # >cutoff_minutes since `last_heartbeat_time`, declare stuck.
    last_heartbeat_value: int | None = Field(
        sa_column=Column(BigInteger, nullable=True),
        default=None,
    )
    last_heartbeat_time: datetime | None = Field(
        sa_column=Column(DateTime(timezone=True), nullable=True),
        default=None,
    )


class TaskProgress(BaseModel, table=True):
    """
    Progress tracking for background tasks (connector sync, batch jobs, etc.).

    Standalone progress tracker keyed by task_id, not tied to the jobs table.
    Used by ProgressTracker in background/progress_tracker.py.
    """

    __tablename__ = "task_progress"

    # Task identification
    task_id: str = Field(max_length=255, unique=True, index=True)
    task_type: str = Field(max_length=100, index=True)

    # Related entities (optional context)
    entity_id: UUID | None = Field(sa_column=Column(ScrapalotUUID(), nullable=True, index=True), default=None)
    user_id: UUID | None = Field(sa_column=Column(ScrapalotUUID(), nullable=True, index=True), default=None)
    workspace_id: UUID | None = Field(sa_column=Column(ScrapalotUUID(), nullable=True), default=None)

    # Progress tracking
    status: str = Field(max_length=50, default="pending", index=True)
    progress_percent: int = Field(default=0)  # 0-100
    total_items: int | None = Field(default=None)
    processed_items: int = Field(default=0)
    current_step: str | None = Field(default=None, sa_column=Column(Text))

    # Timing
    started_at: str | None = Field(default=None)  # ISO datetime string
    completed_at: str | None = Field(default=None)  # ISO datetime string
    estimated_completion_at: str | None = Field(default=None)  # ISO datetime string

    # Result and error
    result_data: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    error_message: str | None = Field(default=None, sa_column=Column(Text))

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dictionary for Redis publishing and API responses."""
        return {
            "task_id": self.task_id,
            "task_type": self.task_type,
            "entity_id": str(self.entity_id) if self.entity_id else None,
            "user_id": str(self.user_id) if self.user_id else None,
            "workspace_id": str(self.workspace_id) if self.workspace_id else None,
            "status": self.status,
            "progress_percent": self.progress_percent,
            "total_items": self.total_items,
            "processed_items": self.processed_items,
            "current_step": self.current_step,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "estimated_completion_at": self.estimated_completion_at,
            "result_data": self.result_data,
            "error_message": self.error_message,
        }


# Update forward references
Job.model_rebuild()
TaskProgress.model_rebuild()
