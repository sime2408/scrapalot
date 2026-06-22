"""Add saved search enhancements: result_count, last_evaluated_at, is_pinned.

Revision ID: 043
Revises: 042
Create Date: 2026-03-20

Phase 2 of saved searches — supports preview counts, pinning, and freshness tracking.
"""

from alembic import op
import sqlalchemy as sa

revision = "043"
down_revision = "042"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("saved_searches", sa.Column("result_count", sa.Integer(), nullable=True))
    op.add_column("saved_searches", sa.Column("last_evaluated_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("saved_searches", sa.Column("is_pinned", sa.Boolean(), server_default="false", nullable=False))


def downgrade() -> None:
    op.drop_column("saved_searches", "is_pinned")
    op.drop_column("saved_searches", "last_evaluated_at")
    op.drop_column("saved_searches", "result_count")
