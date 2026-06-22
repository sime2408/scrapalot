"""Add composite index on jobs(document_id, updated_at DESC, created_at DESC)

Revision ID: 081
Revises: 080
Create Date: 2026-06-07 05:10:00.000000

DocumentExtras.ListCollectionDocuments runs a per-document LATERAL subquery
`SELECT ... FROM jobs j WHERE j.document_id = d.id
 ORDER BY j.updated_at DESC NULLS LAST, j.created_at DESC LIMIT 1`
to render live per-file processing progress. The jobs table had NO index on
document_id at all, so each document forced a scan + sort of its job rows
(~0.5 ms × N docs, ~69 ms of the query, ~29k buffer hits). This composite
index — leading equality on document_id, then the exact ORDER BY ordering —
turns the LATERAL into a single index seek + LIMIT 1 (~0.005 ms/doc, 5
buffer hits), dropping the jobs lookup from ~69 ms to ~0.6 ms.

Created CONCURRENTLY in prod (live table, active worker writes); this
migration keeps it on fresh/rebuilt databases (plain CREATE INDEX is fine
there — empty/small table, no concurrent load).
"""
from typing import Union
from collections.abc import Sequence

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '081'
down_revision: str | None = '080'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_jobs_document_latest "
        "ON jobs (document_id, updated_at DESC NULLS LAST, created_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_jobs_document_latest")
