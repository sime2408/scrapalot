"""Add btree expr index on langchain_pg_embedding document_id chunk_index

Revision ID: 078
Revises: 077
Create Date: 2026-06-05 13:51:59.705727

Many chunk-fetch queries filter `WHERE cmetadata->>'document_id' = $x [AND
(cmetadata->>'chunk_index')::int ...]` — entity-expansion chunk materialisation,
document QA, retrieval. With only the GIN(jsonb_path_ops) index (which serves
`@>` containment, NOT `->>` equality) these did a Parallel Seq Scan over all
~629k rows: 0.5-4 s each, and under concurrent load pinned Postgres CPU. A btree
index on the extracted expressions turns them into index scans (~0.075 ms).
Created CONCURRENTLY in prod; this migration keeps it on fresh/rebuilt databases.
"""
from typing import Union
from collections.abc import Sequence

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '078'
down_revision: str | None = '077'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_lpe_doc_chunk "
        "ON langchain_pg_embedding ((cmetadata->>'document_id'), ((cmetadata->>'chunk_index')::int))"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_lpe_doc_chunk")
