"""Add llm_traces table for persistent RAG tracing.

Revision ID: 031
Revises: 030
Create Date: 2026-03-03

Creates the llm_traces table for storing detailed trace data
per LLM request for analytics, audit, and dataset generation.
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

revision: str = '031'
down_revision: str | None = '030'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if db_utils.table_exists("llm_traces"):
        return

    uuid_type = db_utils.get_uuid_column_type()
    json_type = sa.JSON()
    datetime_type = db_utils.get_datetime_column_type()

    op.create_table(
        "llm_traces",
        # Identity
        sa.Column("id", uuid_type, primary_key=True),
        sa.Column("session_id", uuid_type, nullable=False),
        sa.Column("user_id", uuid_type, nullable=False),
        sa.Column("workspace_id", uuid_type, nullable=True),
        sa.Column("assistant_message_id", uuid_type, nullable=True),

        # Input
        sa.Column("query", sa.Text(), nullable=False),
        sa.Column("chat_mode", sa.String(30), nullable=False),
        sa.Column("collection_ids", json_type, nullable=False, server_default="[]"),
        sa.Column("document_ids", json_type, nullable=False, server_default="[]"),

        # RAG parameters
        sa.Column("top_k", sa.Integer(), nullable=True),
        sa.Column("similarity_threshold", sa.Float(), nullable=True),
        sa.Column("strategy_name", sa.String(100), nullable=True),
        sa.Column("strategy_type", sa.String(30), nullable=True),
        sa.Column("agentic_routing", sa.Boolean(), nullable=False, server_default="false"),

        # Retrieved chunks (JSONB for PostgreSQL, JSON/Text for SQLite)
        sa.Column("retrieved_chunks", json_type, nullable=False, server_default="[]"),
        sa.Column("retrieved_chunk_count", sa.Integer(), nullable=False, server_default="0"),

        # System prompt composition
        sa.Column("system_prompt_length", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("context_token_estimate", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("history_message_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("has_conversation_summary", sa.Boolean(), nullable=False, server_default="false"),

        # LLM execution
        sa.Column("provider", sa.String(50), nullable=True),
        sa.Column("model", sa.String(100), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("total_tokens", sa.Integer(), nullable=True),
        sa.Column("cost_usd", sa.Float(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),

        # Response preview
        sa.Column("response_preview", sa.String(500), nullable=True),

        # Agentic-specific
        sa.Column("source_analysis", json_type, nullable=True),

        # Timestamps
        sa.Column("created_at", datetime_type, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", datetime_type, nullable=False, server_default=sa.func.now()),
    )

    op.create_index("ix_llm_traces_session_id", "llm_traces", ["session_id"])
    op.create_index("ix_llm_traces_user_id", "llm_traces", ["user_id"])
    op.create_index("ix_llm_traces_created_at", "llm_traces", ["created_at"])
    op.create_index("ix_llm_traces_chat_mode", "llm_traces", ["chat_mode"])


def downgrade() -> None:
    if db_utils.table_exists("llm_traces"):
        op.drop_index("ix_llm_traces_chat_mode", table_name="llm_traces")
        op.drop_index("ix_llm_traces_created_at", table_name="llm_traces")
        op.drop_index("ix_llm_traces_user_id", table_name="llm_traces")
        op.drop_index("ix_llm_traces_session_id", table_name="llm_traces")
        op.drop_table("llm_traces")
