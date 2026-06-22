"""Add parent_collection_id and depth to collection_workspace_map for nested collections (Z-04).

Revision ID: 045
Revises: 044
Create Date: 2026-03-22
"""

from alembic import op
import sqlalchemy as sa
import db_utils

revision = "045"
down_revision = "044"
branch_labels = None
depends_on = None


def upgrade() -> None:
    dialect_info = db_utils.get_dialect_info()
    if dialect_info["is_postgresql"]:
        uuid_type = sa.dialects.postgresql.UUID(as_uuid=True)
    else:
        uuid_type = sa.String(36)

    op.add_column("collection_workspace_map", sa.Column("parent_collection_id", uuid_type, nullable=True))
    op.add_column("collection_workspace_map", sa.Column("depth", sa.SmallInteger(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("collection_workspace_map", "depth")
    op.drop_column("collection_workspace_map", "parent_collection_id")
