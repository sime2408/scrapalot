"""Backfill billable file_size for memory-only and dedup documents

Revision ID: 083
Revises: 082
Create Date: 2026-06-11

file_size is the BILLABLE measure of a document — the size of the original
upload, attributed to the workspace owner regardless of how the bytes are
physically kept (deduplicated content-store file, memory-only content in
TOAST, or a plain file on disk). The streaming upload path used to write
file_size=0 for memory-only documents (~93% of prod rows), which made
SUM(file_size) quota checks see almost nothing.

Backfill order of preference:
  1. content_store.file_size (exact original size for deduplicated docs)
  2. file_metadata->>'size' (the streaming path always recorded it there)
  3. pg_column_size(content)  (compressed parsed-content size — honest
     approximation when the original binary size is lost)
"""
from typing import Union
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '083'
down_revision: str | None = '082'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE documents d
        SET file_size = COALESCE(
            NULLIF((SELECT cs.file_size FROM content_store cs WHERE cs.id = d.content_store_id), 0),
            NULLIF((d.file_metadata->>'size')::numeric::bigint, 0),
            NULLIF(pg_column_size(d.content), 0),
            0
        )
        WHERE COALESCE(d.file_size, 0) = 0
        """
    )


def downgrade() -> None:
    # Irreversible data backfill — the previous zeros carried no information.
    pass
