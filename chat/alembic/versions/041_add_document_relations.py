"""Add document_relations table for bidirectional related items.

Revision ID: 041
Revises: 040
Create Date: 2026-03-18

Typed bidirectional relationships between documents:
CITES, EXTENDS, CONTRADICTS, REVIEWS, RELATED_TO.
Synced to Neo4j as Book-to-Book relationships.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "041"
down_revision = "040"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "document_relations",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("source_document_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("target_document_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("relationship_type", sa.String(20), nullable=False),
        sa.Column("user_id", sa.String(255), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("note", sa.Text()),
        sa.Column("confidence", sa.Float(), server_default="1.0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_document_id", "target_document_id", "relationship_type", name="uq_document_relation"),
        sa.CheckConstraint("source_document_id != target_document_id", name="chk_no_self_relation"),
        sa.CheckConstraint(
            "relationship_type IN ('CITES','CITED_BY','EXTENDS','EXTENDED_BY','CONTRADICTS','CONTRADICTED_BY','REVIEWS','REVIEWED_BY','RELATED_TO')",
            name="chk_relationship_type",
        ),
    )
    op.create_index("idx_doc_relations_source", "document_relations", ["source_document_id"])
    op.create_index("idx_doc_relations_target", "document_relations", ["target_document_id"])
    op.create_index("idx_doc_relations_workspace", "document_relations", ["workspace_id"])


def downgrade() -> None:
    op.drop_index("idx_doc_relations_workspace")
    op.drop_index("idx_doc_relations_target")
    op.drop_index("idx_doc_relations_source")
    op.drop_table("document_relations")
