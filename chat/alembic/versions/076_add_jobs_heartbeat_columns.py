"""Add heartbeat counter columns to jobs (PRD Phase 2)

Revision ID: 076
Revises: 075
Create Date: 2026-05-23 18:00:00.000000

PRD: docs/prd-competitive/prd_onyx_worker_stability.md (Phase 2).

Adapted from onyx-dot-app/onyx ``docprocessing/heartbeat.py`` + the
``validate_active_indexing_attempts`` beat task at
``docprocessing/tasks.py:130-310``. Replaces the pre-Phase-2
``documents.updated_at`` liveness signal used by ``JobRecoveryService``
— which advanced for many reasons unrelated to task progress (status
transitions, manual edits, ACL updates) and was the race-prone source
of the Pattern A double-dispatch bug fixed in commit ``fc0de69``.

The running task starts a daemon thread that bumps ``heartbeat_counter``
every 30 s. JobRecovery reads ``(counter, last_heartbeat_value,
last_heartbeat_time)`` to decide:

  * counter advanced since snapshot → alive, refresh snapshot, skip
  * counter idle but within cutoff window → wait
  * counter idle past cutoff (default 30 min) → stuck, recovery candidate

All three columns are pure-additive ALTER TABLE ADD COLUMN with safe
defaults; existing rows backfill in place without re-write thanks to
``server_default``. NULL is the "first observation" sentinel for the
last_heartbeat_* pair.

Idempotent: re-running the migration on a DB that already has these
columns is harmless because Alembic short-circuits on duplicate revision.
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "076"
down_revision: str | None = "075"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "jobs",
        sa.Column(
            "heartbeat_counter",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "jobs",
        sa.Column(
            "last_heartbeat_value",
            sa.BigInteger(),
            nullable=True,
        ),
    )
    op.add_column(
        "jobs",
        sa.Column(
            "last_heartbeat_time",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("jobs", "last_heartbeat_time")
    op.drop_column("jobs", "last_heartbeat_value")
    op.drop_column("jobs", "heartbeat_counter")
