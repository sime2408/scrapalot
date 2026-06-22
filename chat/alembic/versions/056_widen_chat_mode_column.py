"""Widen varchar columns that receive long agent type / mode values

Revision ID: 056
Revises: 055
Create Date: 2026-04-12

System agent types like 'deep_research_section_decomposer' (32 chars)
exceed the original varchar(30) limit. Mode values like
'tiered_post_retrieval_fallback' (30 chars) are at the varchar(20) boundary.
"""

from alembic import op
import sqlalchemy as sa

revision = "056"
down_revision = "055"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "llm_traces",
        "chat_mode",
        type_=sa.String(50),
        existing_type=sa.String(30),
        existing_nullable=False,
    )
    op.alter_column(
        "rag_evaluation_traces",
        "mode",
        type_=sa.String(50),
        existing_type=sa.String(20),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "llm_traces",
        "chat_mode",
        type_=sa.String(30),
        existing_type=sa.String(50),
        existing_nullable=False,
    )
    op.alter_column(
        "rag_evaluation_traces",
        "mode",
        type_=sa.String(20),
        existing_type=sa.String(50),
        existing_nullable=False,
    )
