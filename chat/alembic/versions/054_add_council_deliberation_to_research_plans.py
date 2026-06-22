"""Add council_deliberation JSONB to research_plans

Revision ID: 054
Revises: 053
Create Date: 2026-04-12
"""

from alembic import op

revision = "054"
down_revision = "053"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE research_plans ADD COLUMN IF NOT EXISTS council_deliberation JSONB"
    )


def downgrade() -> None:
    op.drop_column("research_plans", "council_deliberation")
