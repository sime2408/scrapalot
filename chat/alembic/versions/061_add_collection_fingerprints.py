"""add_collection_fingerprints

Revision ID: 061
Revises: 060
Create Date: 2026-04-17

Phase 08 (Cross-Domain Bridge) — per-collection fingerprint used by
Layer-1 bridge detection (pairwise cosine distance over centroids) and
Layer-2 bridge retrieval (shared entity lookup between collections).

Embedding dim is 384 (`all-MiniLM-L6-v2`, configured via
`rag.common.embedding_model`). The PRD mentions VECTOR(1536) from the
OpenAI-era draft — we use the model actually shipped.

The row is maintained by `FingerprintService.recompute(collection_id)`:
- centroid: element-wise mean of every chunk embedding in the collection
- top_entities: top-N entity canonical_names + their per-collection freq
- entity_coverage_score: fraction of chunks that mention ≥ 1 entity
"""
from typing import Union
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

revision: str = "061"
down_revision: str | None = "060"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "collection_fingerprints",
        sa.Column(
            "collection_id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
        ),
        sa.Column(
            "centroid",
            Vector(384),
            nullable=True,
            comment=(
                "Mean of all chunk embeddings in the collection. "
                "Shape matches the live embedding model (all-MiniLM-L6-v2, 384d). "
                "NULL when the collection has no embedded chunks."
            ),
        ),
        sa.Column(
            "top_entities",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
            comment=(
                "Top-100 entities in this collection — list of "
                "{canonical_name, entity_id, frequency, idf}. "
                "Used by BridgeService to detect shared entities."
            ),
        ),
        sa.Column(
            "entity_coverage_score",
            sa.Float,
            nullable=False,
            server_default="0",
            comment=(
                "Fraction of chunks in the collection that mention ≥ 1 "
                "Entity node. 0.0–1.0. Low coverage means the collection "
                "is a poor bridge candidate regardless of centroid distance."
            ),
        ),
        sa.Column(
            "document_count",
            sa.Integer,
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "chunk_count",
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


def downgrade() -> None:
    op.drop_table("collection_fingerprints")
