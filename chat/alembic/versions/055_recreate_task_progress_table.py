"""Recreate task_progress table for ProgressTracker.

Revision ID: 055
Revises: 054
Create Date: 2026-04-12

The task_progress table was dropped in migration 023 (was a Celery worker artifact).
It is now recreated with a new schema to support the ProgressTracker used by
connector sync and other background tasks.
"""
from pathlib import Path
import sys
from typing import Union
from collections.abc import Sequence

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

import db_utils
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '055'
down_revision: str | None = '054'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _uuid_type():
    return postgresql.UUID(as_uuid=False) if op.get_bind().dialect.name == 'postgresql' else sa.String(36)


def upgrade() -> None:
    json_type = sa.JSON()

    if not db_utils.table_exists("task_progress"):
        op.create_table(
            "task_progress",
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_varchar_column("task_id", 255, nullable=False, unique=True, index=True),
            db_utils.create_varchar_column("task_type", 100, nullable=False),
            sa.Column("entity_id", _uuid_type(), nullable=True),
            sa.Column("user_id", _uuid_type(), nullable=True),
            sa.Column("workspace_id", _uuid_type(), nullable=True),
            db_utils.create_varchar_column("status", 50, nullable=False),
            sa.Column("progress_percent", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("total_items", sa.Integer(), nullable=True),
            sa.Column("processed_items", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("current_step", sa.Text(), nullable=True),
            db_utils.create_varchar_column("started_at", 50, nullable=True),
            db_utils.create_varchar_column("completed_at", 50, nullable=True),
            db_utils.create_varchar_column("estimated_completion_at", 50, nullable=True),
            sa.Column("result_data", json_type, nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
        )

        op.create_index("ix_task_progress_task_type", "task_progress", ["task_type"])
        op.create_index("ix_task_progress_status", "task_progress", ["status"])
        op.create_index("ix_task_progress_entity_id", "task_progress", ["entity_id"])
        op.create_index("ix_task_progress_user_id", "task_progress", ["user_id"])


def downgrade() -> None:
    if db_utils.table_exists("task_progress"):
        op.drop_table("task_progress")
