"""Add process_retry_count to documents

Revision ID: 068
Revises: 067
Create Date: 2026-05-04 12:00:00.000000

Bounds the JobRecoveryService auto-retry path. Until now, a document
whose worker died mid-flight without producing artifacts (no pgvector
chunks, no Neo4j Book) was marked ``processing_status='failed'`` with
``processing_error='errorWorkerDied'`` and required a human to click
the Reprocess button. The most common real-world cause is a transient
worker death — CI/CD redeploy, ``docker restart scrapalot-workers``,
host SIGKILL — where the doc would have processed fine on a second
attempt.

The new ``process_retry_count`` column stores how many automatic
retries the recovery service has already consumed. ``MAX_AUTO_RETRIES``
in ``service/document/job_recovery_service.py`` caps the budget at 1
so a doc that consistently crashes (OOM on a giant PDF, parser bug,
malformed input) cannot retry-storm the worker. Manual reprocess
resets the counter to 0.

Idempotent NOT NULL DEFAULT 0 — existing rows pick up the default
without a backfill.
"""
from typing import Union
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "068"
down_revision: str | None = "067"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column(
            "process_retry_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("documents", "process_retry_count")
