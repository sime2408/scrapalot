"""Add missing jobs table columns.

Revision ID: 023
Revises: 022
Create Date: 2026-02-22

Drops the old task_progress table (Celery worker artifact, no longer used in default setup).
Adds missing columns to jobs that the Job SQLModel expects but earlier migrations did not
create: job_name, description, error_message (renamed from error), metadata.
"""
from pathlib import Path
import sys

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from typing import Union
from collections.abc import Sequence

import db_utils
import sqlalchemy as sa
from sqlalchemy import text

from alembic import op

revision: str = '023'
down_revision: str | None = '022'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# noinspection PyTypeChecker
def upgrade() -> None:
    json_type = sa.JSON()

    # =========================================================================
    # TASK_PROGRESS TABLE - Drop (Celery worker artifact, unused in default setup)
    # =========================================================================
    if db_utils.table_exists("task_progress"):
        op.drop_table("task_progress")

    # =========================================================================
    # JOBS TABLE - Add missing columns that Job SQLModel expects
    # =========================================================================
    if db_utils.table_exists("jobs"):
        conn = op.get_bind()

        # job_name - required field in Job SQLModel
        if not db_utils.column_exists("jobs", "job_name"):
            op.add_column("jobs", sa.Column("job_name", sa.String(200), nullable=True))
            # Backfill with job_type as a reasonable default
            conn.execute(text("UPDATE jobs SET job_name = job_type WHERE job_name IS NULL"))

        # description - optional field
        if not db_utils.column_exists("jobs", "description"):
            op.add_column("jobs", sa.Column("description", sa.Text(), nullable=True))

        # error_message - Job SQLModel uses error_message; old schema used error
        if not db_utils.column_exists("jobs", "error_message"):
            if db_utils.column_exists("jobs", "error"):
                op.alter_column("jobs", "error", new_column_name="error_message")
            else:
                op.add_column("jobs", sa.Column("error_message", sa.Text(), nullable=True))

        # metadata - Job SQLModel stores as column named 'metadata'
        if not db_utils.column_exists("jobs", "metadata"):
            op.add_column("jobs", sa.Column("metadata", json_type, nullable=True))


def downgrade() -> None:
    if db_utils.table_exists("jobs"):
        if db_utils.column_exists("jobs", "metadata"):
            op.drop_column("jobs", "metadata")
        if db_utils.column_exists("jobs", "description"):
            op.drop_column("jobs", "description")
        if db_utils.column_exists("jobs", "job_name"):
            op.drop_column("jobs", "job_name")
        if db_utils.column_exists("jobs", "error_message") and not db_utils.column_exists("jobs", "error"):
            op.alter_column("jobs", "error_message", new_column_name="error")
