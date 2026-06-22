"""add_pagerank_columns

Revision ID: 060
Revises: 059
Create Date: 2026-04-17

Phase 07 (PageRank Centrality) — per-document structural centrality score
canonically stored in Postgres for cheap SQL sort. Neo4j holds the projection
and the computation pipeline; the number lives here.

Score is computed by `src/main/service/graph/pagerank_service.py` on two
triggers: on-demand via Celery (debounced 5 min per collection) and nightly
for every collection with ≥ 5 documents.
"""
from typing import Union
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "060"
down_revision: str | None = "059"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column(
            "pagerank_score",
            sa.Float,
            nullable=True,
            comment=(
                "PageRank centrality on the collection-scoped document-shares-entities graph. "
                "Higher = more structurally foundational. Computed by PageRankService."
            ),
        ),
    )
    op.add_column(
        "documents",
        sa.Column(
            "pagerank_computed_at",
            sa.DateTime(timezone=True),
            nullable=True,
            comment="When the score was last computed; stale if older than nightly pass.",
        ),
    )
    op.create_index(
        "idx_documents_collection_pagerank",
        "documents",
        ["collection_id", sa.text("pagerank_score DESC NULLS LAST")],
    )


def downgrade() -> None:
    op.drop_index("idx_documents_collection_pagerank", table_name="documents")
    op.drop_column("documents", "pagerank_computed_at")
    op.drop_column("documents", "pagerank_score")
