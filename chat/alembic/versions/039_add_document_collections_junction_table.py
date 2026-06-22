"""Add document_collections junction table for multi-collection membership.

Revision ID: 039
Revises: 038
Create Date: 2026-03-18

Documents can belong to multiple collections via this junction table.
Existing documents.collection_id is preserved as primary_collection_id
for backward compatibility. Data is migrated from the FK column.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "039"
down_revision = "038"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create junction table
    op.create_table(
        "document_collections",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("document_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("collection_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("document_id", "collection_id", name="uq_doc_collection"),
    )
    op.create_index("idx_dc_document", "document_collections", ["document_id"])
    op.create_index("idx_dc_collection", "document_collections", ["collection_id"])

    # Migrate existing data — copy current collection_id into junction table
    op.execute("""
        INSERT INTO document_collections (document_id, collection_id)
        SELECT id, collection_id FROM documents
        WHERE collection_id IS NOT NULL
        ON CONFLICT DO NOTHING
    """)


def downgrade() -> None:
    op.drop_index("idx_dc_collection")
    op.drop_index("idx_dc_document")
    op.drop_table("document_collections")
