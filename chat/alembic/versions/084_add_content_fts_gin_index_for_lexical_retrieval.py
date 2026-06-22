"""Add content FTS GIN index for lexical retrieval

Revision ID: 084
Revises: 083
Create Date: 2026-06-17 11:45:47.999234

GIN full-text index on ``documents.content``. It powers the content arm of the
lexical (hybrid) retrieval rescue in
``PGVectorRetriever._lexical_doc_candidates`` — title + content full-text are
UNION'd so each uses its own access path. Without this index the content match
seq-scanned the ~1.2 GB TOASTed column and hit the statement timeout, so the
lexical half silently returned nothing and retrieval degraded to dense-only.

``IF NOT EXISTS`` makes it idempotent — production already has this index
(built manually with ``CREATE INDEX CONCURRENTLY`` on 2026-06-17 to avoid a
table lock on the live ~1.2 GB table), so here it is a no-op that just records
the revision. On a fresh environment the ``documents`` table is small, so the
plain (transactional) build is fast. We do NOT use ``CONCURRENTLY`` here: this
project's Alembic env wraps each migration in an explicit transaction, which is
incompatible with ``CONCURRENTLY`` / ``autocommit_block``.
"""
from typing import Union
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "084"
down_revision: str | None = "083"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_documents_content_fts "
        "ON documents USING gin(to_tsvector('english', coalesce(content, '')))"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_documents_content_fts")
