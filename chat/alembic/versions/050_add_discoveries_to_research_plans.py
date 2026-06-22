"""Add discoveries JSONB column to research_plans.

Stores structured findings extracted from synthesis reports (Phase 5.5).
Each discovery has: title, claim, summary, evidence, sources, confidence.

Revision ID: 050
Revises: 049
Create Date: 2026-04-03
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "050"
down_revision = "049"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("research_plans", sa.Column("discoveries", JSONB, nullable=False, server_default="[]"))


def downgrade() -> None:
    op.drop_column("research_plans", "discoveries")
