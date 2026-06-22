"""Multimodal elements

Revision ID: 066
Revises: 065
Create Date: 2026-05-01

One row per non-text element (image / table / equation) discovered during
document ingest. The descriptive chunk that feeds vector retrieval is
stored normally in pgvector with a `chunk_id` back-reference; the
(:Entity {entity_type='image|table|equation'}) Neo4j node is referenced
by `neo4j_entity_id`.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "066"
down_revision: str | None = "065"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "multimodal_elements",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "document_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "element_type",
            sa.String(length=16),
            nullable=False,
            comment="image | table | equation",
        ),
        sa.Column(
            "element_index",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
            comment="0-indexed within the document, used to build storage paths",
        ),
        sa.Column("page_idx", sa.Integer(), nullable=True),
        sa.Column(
            "bbox_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
            comment="{x0,y0,x1,y1} in PDF page coords for highlight overlays (3.5)",
        ),
        sa.Column(
            "storage_path",
            sa.String(length=500),
            nullable=True,
            comment="WebP path under data/multimodal/images/{document_id}/p{page}_i{idx}.webp (images only)",
        ),
        sa.Column(
            "content_text",
            sa.Text(),
            nullable=True,
            comment="Tables: Markdown body. Equations: raw LaTeX/MathML.",
        ),
        sa.Column("caption", sa.Text(), nullable=True),
        sa.Column(
            "footnotes",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
            comment="list[str]",
        ),
        sa.Column(
            "description",
            sa.Text(),
            nullable=True,
            comment="LLM-generated description that gets embedded into a sibling text chunk for retrieval.",
        ),
        sa.Column("entity_name", sa.String(length=255), nullable=True),
        sa.Column(
            "entity_subtype",
            sa.String(length=64),
            nullable=True,
            comment="image: photograph|chart|diagram|screenshot|illustration; table: data_table|comparison_table|matrix|flow_table",
        ),
        sa.Column(
            "structured_data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
            comment="Tables: {headers, rows, col_count, row_count}. Other types: free-form.",
        ),
        sa.Column(
            "derived_stats",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
            comment="Per-numeric-column stats {min,max,mean,stdev,count_non_null} for tables.",
        ),
        sa.Column(
            "symbol_map",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
            comment='Equations only: {"E": "energy", "m": "mass", "c": "speed of light"}',
        ),
        sa.Column(
            "chunk_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
            comment="Back-reference to the langchain_pg_embedding row created from `description`.",
        ),
        sa.Column(
            "neo4j_entity_id",
            sa.String(length=128),
            nullable=True,
            comment="Stable id of the (:Entity {entity_type='image|table|equation'}) node in Neo4j.",
        ),
        sa.Column(
            "processing_status",
            sa.String(length=20),
            nullable=False,
            server_default=sa.text("'pending'"),
            comment="pending | describing | indexed | failed",
        ),
        sa.Column("processing_error", sa.Text(), nullable=True),
        sa.Column("described_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint(
            "element_type IN ('image', 'table', 'equation')",
            name="ck_multimodal_elements_type",
        ),
        sa.CheckConstraint(
            "processing_status IN ('pending', 'describing', 'indexed', 'failed')",
            name="ck_multimodal_elements_status",
        ),
        sa.UniqueConstraint(
            "document_id",
            "element_type",
            "element_index",
            name="uq_multimodal_elements_doc_type_idx",
        ),
    )
    op.create_index(
        "ix_multimodal_elements_document_id",
        "multimodal_elements",
        ["document_id"],
    )
    op.create_index(
        "ix_multimodal_elements_element_type",
        "multimodal_elements",
        ["element_type"],
    )
    op.create_index(
        "ix_multimodal_elements_status",
        "multimodal_elements",
        ["processing_status"],
    )


def downgrade() -> None:
    op.drop_index("ix_multimodal_elements_status", table_name="multimodal_elements")
    op.drop_index("ix_multimodal_elements_element_type", table_name="multimodal_elements")
    op.drop_index("ix_multimodal_elements_document_id", table_name="multimodal_elements")
    op.drop_table("multimodal_elements")
