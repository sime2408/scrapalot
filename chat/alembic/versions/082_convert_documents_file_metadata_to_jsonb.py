"""Convert documents.file_metadata from character varying to jsonb

Revision ID: 082
Revises: 081
Create Date: 2026-06-07 08:00:00.000000

`documents.file_metadata` was stored as `character varying` while the ORM
model (and its sibling columns `extracted_metadata` / `document_hierarchy`)
treat it as JSON. The mismatch made JSON operators fail on the raw column:
`GetStorageUsage` ran `d.file_metadata->>'file_size'` and Postgres raised
`operator does not exist: character varying ->> unknown`. Callers had to
defensively `::jsonb`-cast (or `json.loads`) it everywhere.

This aligns the physical column with jsonb (matching `document_hierarchy`,
which is jsonb-in-DB / JSON-in-model). All existing non-null rows are valid
JSON (verified: 0 rows fail `pg_input_is_valid(file_metadata,'jsonb')`), so
the rewrite is lossless. Empty strings — should any exist — map to NULL.
The table is small (~3.3k rows) so the rewrite lock is sub-second.
"""
from typing import Union
from collections.abc import Sequence

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '082'
down_revision: str | None = '081'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ALTER COLUMN ... TYPE rewrites the table under an ACCESS EXCLUSIVE lock.
    # On the live `documents` table, continuous SELECT/UPDATE traffic keeps
    # AccessShare/RowExclusive locks held, so the rewrite can wait a long time
    # to acquire the lock and trip the per-session statement_timeout. Bound the
    # lock wait so it fails fast and is retryable rather than blocking traffic,
    # and give the (sub-second, ~3.3k row) rewrite itself ample headroom.
    # documents is ~5 MB heap but ~820 MB total (the TOASTed `content` column),
    # and ALTER ... TYPE rewrites the whole table, so the rewrite itself runs
    # for ~1-2 min under ACCESS EXCLUSIVE — give statement_timeout ample room
    # (a too-short cap cancels mid-rewrite). lock_timeout stays short so we fail
    # fast and retry if we can't grab the exclusive lock during a traffic gap.
    op.execute("SET LOCAL lock_timeout = '10s'")
    op.execute("SET LOCAL statement_timeout = '600s'")
    op.execute(
        "ALTER TABLE documents "
        "ALTER COLUMN file_metadata TYPE jsonb "
        "USING (CASE WHEN file_metadata IS NULL OR file_metadata = '' "
        "THEN NULL ELSE file_metadata::jsonb END)"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE documents "
        "ALTER COLUMN file_metadata TYPE character varying "
        "USING file_metadata::text"
    )
