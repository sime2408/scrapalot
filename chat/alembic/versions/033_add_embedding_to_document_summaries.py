"""Add embedding vector to document_summaries for semantic search.

Revision ID: 033
Revises: 032
Create Date: 2026-03-05

Adds a 384-dim embedding column to document_summaries so that chapter/book
summaries can be searched by cosine similarity instead of raw SQL fetching.
The rag_hybrid_summary_search strategy uses this to rank summaries by
relevance to the user query before expanding to their chunks.

Also adds the langchain_chunk_id column to allow bridging pgvector chunk IDs
to Neo4j Chunk nodes for entity-based cross-document expansion.
"""

from pathlib import Path
import sys

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from typing import Union
from collections.abc import Sequence

import db_utils
from alembic import op

# revision identifiers
revision: str = "033"
down_revision: str | None = "032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EMBEDDING_DIM = 384  # all-MiniLM-L6-v2 / sentence-transformers default


def upgrade() -> None:
    # 1. Add embedding column to document_summaries
    if not db_utils.column_exists("document_summaries", "embedding"):
        op.execute(f"""
            ALTER TABLE document_summaries
            ADD COLUMN embedding vector({EMBEDDING_DIM})
        """)

    # 2. HNSW index for fast cosine similarity search on summaries
    #    (table is small so lists=1 for ivfflat, but HNSW needs no tuning)
    if not db_utils.index_exists("ix_document_summaries_embedding_hnsw", "document_summaries"):
        op.execute("""
            CREATE INDEX ix_document_summaries_embedding_hnsw
            ON document_summaries
            USING hnsw (embedding vector_cosine_ops)
        """)

    # 3. Add langchain_chunk_id to Neo4j bridge column on langchain_pg_embedding
    #    is already via cmetadata JSON — nothing to add here.
    #    Instead, add a column on document_summaries for the chunk_id range that
    #    was used so we can directly join to langchain_pg_embedding by chunk range.
    #    (chunk_start_index / chunk_end_index already exist — no extra column needed)


def downgrade() -> None:
    if db_utils.index_exists("ix_document_summaries_embedding_hnsw", "document_summaries"):
        op.execute("DROP INDEX ix_document_summaries_embedding_hnsw")

    if db_utils.column_exists("document_summaries", "embedding"):
        op.execute("ALTER TABLE document_summaries DROP COLUMN embedding")
