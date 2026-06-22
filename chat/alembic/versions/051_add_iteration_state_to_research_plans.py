"""Add iteration_count and research_state columns to research_plans.

Supports iterative deep research (Phase 3 AI Scientist PRD).
iteration_count tracks completed iterations, research_state stores
the serialized ResearchIterationState JSONB across iterations.

Revision ID: 051
Revises: 050
Create Date: 2026-04-04
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "051"
down_revision = "050"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("research_plans", sa.Column("iteration_count", sa.Integer, nullable=False, server_default="1"))
    op.add_column("research_plans", sa.Column("research_state", JSONB, nullable=False, server_default="{}"))


def downgrade() -> None:
    op.drop_column("research_plans", "research_state")
    op.drop_column("research_plans", "iteration_count")
