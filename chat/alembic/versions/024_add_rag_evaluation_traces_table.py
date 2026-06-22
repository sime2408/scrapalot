"""Add RAG evaluation traces table.

Revision ID: 024
Revises: 023
Create Date: 2026-02-25

Creates the rag_evaluation_traces table for storing RAG strategy routing
decisions used by the Data Inspector for analytics and quality monitoring.
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

from alembic import op

revision: str = '024'
down_revision: str | None = '023'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if db_utils.table_exists("rag_evaluation_traces"):
        return

    uuid_type = db_utils.get_uuid_column_type()
    json_type = sa.JSON()
    datetime_type = db_utils.get_datetime_column_type()

    op.create_table(
        "rag_evaluation_traces",
        sa.Column("id", uuid_type, primary_key=True),
        sa.Column("session_id", uuid_type, nullable=False),
        sa.Column("user_id", uuid_type, nullable=False),
        sa.Column("query", sa.Text(), nullable=False),
        sa.Column("selected_strategy", sa.String(100), nullable=False),
        sa.Column("selected_orchestrator", sa.String(100), nullable=True),
        sa.Column("strategy_type", sa.String(20), nullable=False),
        sa.Column("mode", sa.String(20), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("reasoning", sa.Text(), nullable=True),
        sa.Column("alternative_strategies", json_type, nullable=False, server_default="[]"),
        sa.Column("query_characteristics", json_type, nullable=False, server_default="{}"),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("token_count", sa.Integer(), nullable=True),
        sa.Column("created_at", datetime_type, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", datetime_type, nullable=False, server_default=sa.func.now()),
    )

    op.create_index("ix_rag_evaluation_traces_strategy", "rag_evaluation_traces", ["selected_strategy"])
    op.create_index("ix_rag_evaluation_traces_created_at", "rag_evaluation_traces", ["created_at"])
    op.create_index("ix_rag_evaluation_traces_session_id", "rag_evaluation_traces", ["session_id"])


def downgrade() -> None:
    if db_utils.table_exists("rag_evaluation_traces"):
        op.drop_index("ix_rag_evaluation_traces_session_id", table_name="rag_evaluation_traces")
        op.drop_index("ix_rag_evaluation_traces_created_at", table_name="rag_evaluation_traces")
        op.drop_index("ix_rag_evaluation_traces_strategy", table_name="rag_evaluation_traces")
        op.drop_table("rag_evaluation_traces")
