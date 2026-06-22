"""Add routing_tier columns to LLM traces and RAG evaluation traces.

Revision ID: 044
Revises: 043
Create Date: 2026-03-20

Tracks which tier of the Smart Tiered RAG Routing System handled the request:
  1 = rule_based, 2 = exemplar, 3 = llm_agent, 4 = post_retrieval_fallback
"""

from alembic import op
import sqlalchemy as sa

revision = "044"
down_revision = "043"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # LLM traces
    op.add_column("llm_traces", sa.Column("routing_tier", sa.Integer(), nullable=True))
    op.add_column("llm_traces", sa.Column("routing_tier_name", sa.String(30), nullable=True))

    # RAG evaluation traces
    op.add_column("rag_evaluation_traces", sa.Column("routing_tier", sa.Integer(), nullable=True))
    op.add_column("rag_evaluation_traces", sa.Column("routing_tier_name", sa.String(30), nullable=True))


def downgrade() -> None:
    op.drop_column("rag_evaluation_traces", "routing_tier_name")
    op.drop_column("rag_evaluation_traces", "routing_tier")
    op.drop_column("llm_traces", "routing_tier_name")
    op.drop_column("llm_traces", "routing_tier")
