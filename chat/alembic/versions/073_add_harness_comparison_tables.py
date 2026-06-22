"""Add harness comparison tables

Two additive tables for the harness comparison grid:
- harness_comparison_runs:    one row per grid invocation
- harness_comparison_results: one row per (question x retriever x delivery x variant) cell

Non-destructive — rollback drops the tables only.

Revision ID: 073
Revises: 072
Create Date: 2026-05-16

"""

from collections.abc import Sequence
from pathlib import Path
import sys

import sqlalchemy as sa

from alembic import op

# Add parent directory to path to import db_utils
sys.path.append(str(Path(__file__).parent))
# noinspection PyUnresolvedReferences
import db_utils  # type: ignore[import-not-found]

# revision identifiers, used by Alembic.
revision: str = "073"
down_revision: str | None = "072"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create harness_comparison_runs + harness_comparison_results tables."""
    op.create_table(
        "harness_comparison_runs",
        db_utils.create_uuid_column("id", primary_key=True),
        db_utils.create_uuid_column("created_by", nullable=False),
        sa.Column("eval_set_id", sa.String(255), nullable=False),
        sa.Column("config", sa.JSON, nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="queued"),
        sa.Column("summary", sa.JSON, nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_harness_runs_created_by",
        "harness_comparison_runs",
        ["created_by"],
    )
    op.create_index(
        "ix_harness_runs_eval_set_id",
        "harness_comparison_runs",
        ["eval_set_id"],
    )
    op.create_index(
        "ix_harness_runs_created_at",
        "harness_comparison_runs",
        ["created_at"],
    )
    op.create_index(
        "ix_harness_runs_status",
        "harness_comparison_runs",
        ["status"],
    )

    op.create_table(
        "harness_comparison_results",
        db_utils.create_uuid_column("id", primary_key=True),
        db_utils.create_uuid_column("run_id", nullable=False),
        sa.Column("question_id", sa.String(255), nullable=False),
        sa.Column("retriever", sa.String(64), nullable=False),
        sa.Column("delivery_mode", sa.String(16), nullable=False),
        sa.Column("prompt_variant", sa.String(64), nullable=False),
        sa.Column("answer_text", sa.Text, nullable=True),
        sa.Column("judge_relevance", sa.Numeric(3, 2), nullable=True),
        sa.Column("judge_groundedness", sa.Numeric(3, 2), nullable=True),
        sa.Column("judge_citation_accuracy", sa.Numeric(3, 2), nullable=True),
        sa.Column("latency_ms", sa.Integer, nullable=True),
        sa.Column("cost_usd", sa.Numeric(8, 4), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["harness_comparison_runs.id"],
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "ix_harness_results_run_id",
        "harness_comparison_results",
        ["run_id"],
    )
    op.create_index(
        "ix_harness_results_retriever",
        "harness_comparison_results",
        ["retriever"],
    )


def downgrade() -> None:
    """Drop harness_comparison_results + harness_comparison_runs."""
    op.drop_index(
        "ix_harness_results_retriever",
        table_name="harness_comparison_results",
    )
    op.drop_index(
        "ix_harness_results_run_id",
        table_name="harness_comparison_results",
    )
    op.drop_table("harness_comparison_results")

    op.drop_index("ix_harness_runs_status", table_name="harness_comparison_runs")
    op.drop_index("ix_harness_runs_created_at", table_name="harness_comparison_runs")
    op.drop_index(
        "ix_harness_runs_eval_set_id", table_name="harness_comparison_runs"
    )
    op.drop_index(
        "ix_harness_runs_created_by", table_name="harness_comparison_runs"
    )
    op.drop_table("harness_comparison_runs")
