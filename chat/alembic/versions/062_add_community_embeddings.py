"""add_community_embeddings

Revision ID: 062
Revises: 061
Create Date: 2026-04-27

CATEGORY_01 §1.1 Leiden Communities — community-summary vector index for
"global question" routing. RAGFlow's GraphRAG falls back to community-level
summaries when narrow entity retrieval has low confidence; we mirror that
with a pgvector lookup over the LLM-generated `title + summary` text.

The 384-dim embedding matches `all-MiniLM-L6-v2` (rag.common.embedding_model)
— same model that drives `collection_fingerprints` so we don't need a second
encoder loaded.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

revision: str = "062"
down_revision: str | None = "061"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "community_embeddings",
        sa.Column(
            "community_id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            comment="Mirror of Neo4j Community.id — 1:1 relationship.",
        ),
        sa.Column(
            "collection_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
            comment="Owning collection — drives the global-question fallback retrieval.",
        ),
        sa.Column(
            "level",
            sa.SmallInteger,
            nullable=False,
            server_default="0",
            comment="Hierarchy level (0 = top, deeper = more specific).",
        ),
        sa.Column(
            "embedding",
            Vector(384),
            nullable=True,
            comment=(
                "Embedding of `title + '\\n\\n' + summary` from the LLM-generated "
                "community report. NULL until the report is generated and embedded."
            ),
        ),
        sa.Column(
            "title",
            sa.Text,
            nullable=False,
            server_default="",
        ),
        sa.Column(
            "summary",
            sa.Text,
            nullable=False,
            server_default="",
        ),
        sa.Column(
            "rating",
            sa.Float,
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "size",
            sa.Integer,
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
    )
    op.create_index(
        "idx_community_embeddings_collection",
        "community_embeddings",
        ["collection_id"],
    )


def downgrade() -> None:
    op.drop_index("idx_community_embeddings_collection", table_name="community_embeddings")
    op.drop_table("community_embeddings")
