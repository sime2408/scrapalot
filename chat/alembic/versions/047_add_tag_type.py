"""Add tag_type column to tags for automatic vs manual distinction (Z-11).

tag_type: 0 = manual (user-created), 1 = automatic (from metadata/CrossRef keywords)

Revision ID: 047
Revises: 046
Create Date: 2026-03-24
"""

from alembic import op
import sqlalchemy as sa

revision = "047"
down_revision = "046"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tags", sa.Column("tag_type", sa.SmallInteger(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("tags", "tag_type")
