"""restore_pgvector_hnsw_indexes

Revision ID: 064
Revises: 063
Create Date: 2026-04-29

Restore the HNSW ANN indexes that migration 020 dropped during the
`vector(1536)` → `vector` column-type change. 020 dropped them because
pgvector ANN indexes require a fixed dimension and the old hardcoded
1536 didn't match the local 384-dim models. The fix should have been to
re-cast to `vector(384)` and recreate the indexes; instead the indexes
were left dropped and never restored, so every similarity_search on
`langchain_pg_embedding` (now ~187k vectors / 846 MB) and
`document_chunks` falls back to a sequential scan.

Direct symptom: 7.3 ComposeFromSources hits its 30 s retrieval timeout
on any non-trivial corpus. Same root cause silently degrades every RAG
strategy in the codebase.

This migration:

  1. Casts each embedding column to `vector(384)` (all stored vectors
     are 384-dim; verified via `vector_dims(embedding)`).
  2. Recreates HNSW indexes with `vector_cosine_ops` — cosine is what
     LangChain's PGVector default `DistanceStrategy.COSINE` requires
     and what the retriever invokes. Index params left at HNSW defaults
     (m=16, ef_construction=64) which match pgvector docs' general
     guidance for this corpus size.

The ALTER + CREATE INDEX is wrapped in DO blocks so partial state from
prior failed attempts (e.g. an index that already exists under the same
name, or the column already cast) doesn't abort the upgrade.
"""

from pathlib import Path
import sys

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from collections.abc import Sequence

import db_utils
from alembic import op
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "064"
down_revision: str | None = "063"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Vectors stored by all production embedding models in this codebase
# are 384-dim (verified in prod: `SELECT vector_dims(embedding) FROM
# langchain_pg_embedding GROUP BY 1` returns a single row at 384). If a
# future model lands at a different dim, this migration must be paired
# with a column-type roll-forward.
EMBEDDING_DIM = 384


def upgrade() -> None:
    dialect_info = db_utils.get_dialect_info()
    if not dialect_info["is_postgresql"]:
        return

    conn = op.get_bind()

    # ─── langchain_pg_embedding ────────────────────────────────────────
    # The LangChain PGVector store. All retriever_pgvector queries land
    # here. By far the largest table — restoring HNSW first has the
    # biggest ROI.
    if db_utils.table_exists("langchain_pg_embedding") and db_utils.column_exists(
        "langchain_pg_embedding", "embedding"
    ):
        conn.execute(text("DROP INDEX IF EXISTS idx_langchain_embedding_hnsw"))
        # Cast back to a dimensioned vector. Idempotent: already-cast
        # columns just get re-asserted at the same type.
        conn.execute(
            text(
                f"ALTER TABLE langchain_pg_embedding "
                f"ALTER COLUMN embedding TYPE vector({EMBEDDING_DIM}) "
                f"USING embedding::vector({EMBEDDING_DIM})"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_langchain_embedding_hnsw "
                "ON langchain_pg_embedding USING hnsw (embedding vector_cosine_ops)"
            )
        )

    # ─── document_chunks ───────────────────────────────────────────────
    # Legacy chunk store. Some RAG paths still query this table; the
    # missing index causes the same regression.
    if db_utils.table_exists("document_chunks") and db_utils.column_exists(
        "document_chunks", "embedding"
    ):
        conn.execute(text("DROP INDEX IF EXISTS idx_document_chunks_embedding_hnsw"))
        conn.execute(
            text(
                f"ALTER TABLE document_chunks "
                f"ALTER COLUMN embedding TYPE vector({EMBEDDING_DIM}) "
                f"USING embedding::vector({EMBEDDING_DIM})"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding_hnsw "
                "ON document_chunks USING hnsw (embedding vector_cosine_ops)"
            )
        )


def downgrade() -> None:
    dialect_info = db_utils.get_dialect_info()
    if not dialect_info["is_postgresql"]:
        return

    conn = op.get_bind()

    # Drop the indexes and revert columns to unconstrained vector — the
    # state migration 020 left behind. We do not attempt to restore the
    # original migration-005 vector(1536) shape because production data
    # is 384-dim and that cast would fail.
    conn.execute(text("DROP INDEX IF EXISTS idx_langchain_embedding_hnsw"))
    conn.execute(text("DROP INDEX IF EXISTS idx_document_chunks_embedding_hnsw"))
    if db_utils.table_exists("langchain_pg_embedding") and db_utils.column_exists(
        "langchain_pg_embedding", "embedding"
    ):
        conn.execute(
            text(
                "ALTER TABLE langchain_pg_embedding "
                "ALTER COLUMN embedding TYPE vector USING embedding::vector"
            )
        )
    if db_utils.table_exists("document_chunks") and db_utils.column_exists(
        "document_chunks", "embedding"
    ):
        conn.execute(
            text(
                "ALTER TABLE document_chunks "
                "ALTER COLUMN embedding TYPE vector USING embedding::vector"
            )
        )
