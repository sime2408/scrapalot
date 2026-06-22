"""Add btree index on langchain_pg_embedding collection_id

Revision ID: 085
Revises: 084
Create Date: 2026-06-17 16:10:00.000000

`GetCollectionStats` counts embeddings per collection with
`WHERE e.collection_id = (SELECT uuid FROM langchain_pg_collection WHERE name = :cid)`.
The FK `langchain_pg_embedding_collection_id_fkey` exists but Postgres does NOT
auto-create a backing index for it, so this filter did a Parallel Seq Scan over
all ~2.3M rows (~8 s, 328k buffers read from disk) on every stats call — even for
empty collections. The frontend (Knowledge Stacks refresh, External Books panel)
fires this repeatedly, and because the gRPC work holds a pooled connection across
the scan it cascaded into pool/loop starvation (jobs/active, external-books all
timing out together).

A plain btree on `collection_id` turns the lookup into an index scan (~0.09 ms for
small/empty collections, the common case). Created CONCURRENTLY in prod; this
migration keeps it on fresh/rebuilt databases. It also backs FK cascade deletes.
"""
from typing import Union
from collections.abc import Sequence

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '085'
down_revision: str | None = '084'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_lpe_collection_id "
        "ON langchain_pg_embedding (collection_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_lpe_collection_id")
