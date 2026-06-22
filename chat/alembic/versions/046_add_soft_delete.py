"""Add deleted_at column to documents for soft-delete / trash (Z-16).

Revision ID: 046
Revises: 045
Create Date: 2026-03-22
"""

from alembic import op
import sqlalchemy as sa

revision = "046"
down_revision = "045"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("documents", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("idx_documents_deleted_at", "documents", ["deleted_at"])


def downgrade() -> None:
    op.drop_index("idx_documents_deleted_at", table_name="documents")
    op.drop_column("documents", "deleted_at")
