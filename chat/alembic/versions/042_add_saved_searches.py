"""Add saved_searches table for virtual collections.

Revision ID: 042
Revises: 041
Create Date: 2026-03-18

Users save search criteria as "smart collections" that auto-update.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "042"
down_revision = "041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "saved_searches",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("user_id", sa.String(255), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("criteria", postgresql.JSONB(), nullable=False),
        sa.Column("icon", sa.String(50), server_default="search"),
        sa.Column("color", sa.String(7)),
        sa.Column("sort_order", sa.Integer(), server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_saved_searches_user_workspace", "saved_searches", ["user_id", "workspace_id"])


def downgrade() -> None:
    op.drop_index("idx_saved_searches_user_workspace")
    op.drop_table("saved_searches")
