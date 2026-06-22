"""Add tags and document_tags tables for document tagging system.

Revision ID: 040
Revises: 039
Create Date: 2026-03-18

Color-coded tags with keyboard shortcuts (1-9).
Tags work cross-collection for RAG filtering.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "040"
down_revision = "039"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Tags table — workspace-scoped, user-owned
    op.create_table(
        "tags",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("color", sa.String(7)),
        sa.Column("position", sa.SmallInteger()),  # 0-8 for keyboard shortcuts 1-9
        sa.Column("user_id", sa.String(255), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", "user_id", "workspace_id", name="uq_tag_name_user_workspace"),
    )

    # Document-tag junction table
    op.create_table(
        "document_tags",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("document_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("tag_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tags.id", ondelete="CASCADE"), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("document_id", "tag_id", name="uq_document_tag"),
    )
    op.create_index("idx_doctags_document", "document_tags", ["document_id"])
    op.create_index("idx_doctags_tag", "document_tags", ["tag_id"])


def downgrade() -> None:
    op.drop_index("idx_doctags_tag")
    op.drop_index("idx_doctags_document")
    op.drop_table("document_tags")
    op.drop_table("tags")
