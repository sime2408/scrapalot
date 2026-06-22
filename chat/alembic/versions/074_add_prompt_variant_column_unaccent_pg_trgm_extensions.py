"""Add prompt_variant column + unaccent + pg_trgm extensions

Follow-ups:

- ``rag_evaluation_traces.prompt_variant`` (Phase 4 OQ #2): persist the
  category-conditioned prompt variant alongside the strategy choice. Today
  it's only emitted as a `prompt_variant_selected` packet.

- ``CREATE EXTENSION IF NOT EXISTS unaccent`` (Phase 1 OQ #6): unblocks
  diacritic-folding author resolution
  (`resolve_authors_to_document_ids` — `Đorđević` ↔ `Djordjevic`).

- ``CREATE EXTENSION IF NOT EXISTS pg_trgm`` (Phase 2 OQ): foundation for
  the GIN index below + already-deployed fuzzy-title duplicate detector
  (`duplicate_detector.py:172` logs a debug warning when missing).

- ``ix_documents_content_trgm`` GIN index on ``documents.content`` so the
  Phase 2 `RAGRegexGrep` strategy and the Phase 1 `grep_search` tool
  scale past sequential scans on the largest collections.

All operations are additive / idempotent. Rollback drops only what this
migration added.

Revision ID: 074
Revises: 073
Create Date: 2026-05-16

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "074"
down_revision: str | None = "073"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply additive schema + extension changes."""

    # 1) prompt_variant column on the routing trace table.
    op.add_column(
        "rag_evaluation_traces",
        sa.Column("prompt_variant", sa.Text, nullable=True),
    )
    op.create_index(
        "ix_rag_evaluation_traces_prompt_variant",
        "rag_evaluation_traces",
        ["prompt_variant"],
    )

    # 2) Extensions. CREATE EXTENSION IF NOT EXISTS is idempotent, so a
    # repeated migration is a no-op. Both are present in standard Postgres
    # contrib (no external install needed).
    op.execute("CREATE EXTENSION IF NOT EXISTS unaccent")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    # 3) GIN trigram index on documents.content. Use IF NOT EXISTS so a
    # rerun of the migration on a partially-applied environment is safe.
    # CONCURRENTLY would be nicer for live tables but Alembic wraps the
    # migration in a transaction by default; plain CREATE INDEX is fine
    # for a young table.
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_documents_content_trgm "
        "ON documents USING gin (content gin_trgm_ops)"
    )


def downgrade() -> None:
    """Drop everything this migration created."""

    op.execute("DROP INDEX IF EXISTS ix_documents_content_trgm")
    # Leave the extensions in place — other parts of the codebase use them
    # (duplicate_detector.py for pg_trgm fuzzy matching). Dropping would
    # cascade-break unrelated features.
    op.drop_index(
        "ix_rag_evaluation_traces_prompt_variant",
        table_name="rag_evaluation_traces",
    )
    op.drop_column("rag_evaluation_traces", "prompt_variant")
