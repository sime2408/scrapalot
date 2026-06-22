"""RAG System and Vector Embeddings

Revision ID: 00005
Revises: 00004
Create Date: 2025-12-05

Creates RAG and vector embedding tables:
- document_chunks (text chunks with vector embeddings)
- document_summaries (AI-generated document summaries)
- langchain_pg_collection (LangChain PGVector collections)
- langchain_pg_embedding (LangChain PGVector embeddings)

PostgreSQL-specific: Enables pgvector extension
"""
from pathlib import Path
import sys

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from typing import Union
from collections.abc import Sequence
# noinspection PyUnresolvedReferences
import db_utils
import sqlalchemy as sa
from sqlalchemy import text

from alembic import op

revision = '005'
down_revision = '004'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# noinspection PyTypeChecker
def upgrade() -> None:
    """Create RAG and vector tables."""
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]
    json_type = db_utils.get_json_column_type()

    # Enable pgvector extension for PostgreSQL
    if is_postgres:
        # noinspection PyBroadException
        try:
            op.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        except Exception:
            pass  # Extension may already exist or user may not have permissions

    # === DOCUMENT_CHUNKS TABLE ===
    if not db_utils.table_exists("document_chunks"):
        # Create table with basic columns first
        op.create_table(
            db_utils.get_table_name("document_chunks"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("document_id", foreign_key="documents.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_uuid_column("collection_id", foreign_key="collections.id", on_delete="CASCADE", nullable=False, index=True),
            sa.Column("chunk_index", sa.Integer(), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("metadata", json_type, nullable=True),
            sa.Column("page_number", sa.Integer(), nullable=True),
            sa.Column("chunk_type", sa.String(50), nullable=True),
            db_utils.create_varchar_column("embedding_model", 100, nullable=True),
        )

        # Add vector column for PostgreSQL only
        if is_postgres:
            # Add pgvector column (1536 dimensions for OpenAI ada-002 / sentence-transformers)
            op.execute(text(f"""
                ALTER TABLE {db_utils.get_table_name("document_chunks")}
                ADD COLUMN embedding vector(1536)
            """))

            # Create HNSW index for fast similarity search
            # noinspection PyBroadException
            try:
                op.execute(text(f"""
                    CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding_hnsw
                    ON {db_utils.get_table_name("document_chunks")}
                    USING hnsw (embedding vector_cosine_ops)
                    WITH (m = 16, ef_construction = 64)
                """))
            except Exception:
                # Fallback to IVFFlat if HNSW is not available
                op.execute(text(f"""
                    CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding_ivfflat
                    ON {db_utils.get_table_name("document_chunks")}
                    USING ivfflat (embedding vector_cosine_ops)
                    WITH (lists = 100)
                """))

    # === DOCUMENT_SUMMARIES TABLE ===
    if not db_utils.table_exists("document_summaries"):
        op.create_table(
            db_utils.get_table_name("document_summaries"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("document_id", foreign_key="documents.id", on_delete="CASCADE", nullable=False, unique=True, index=True),
            sa.Column("summary", sa.Text(), nullable=False),
            sa.Column("key_points", json_type, nullable=True),
            sa.Column("topics", json_type, nullable=True),
            db_utils.create_varchar_column("summary_model", 100, nullable=True),
            sa.Column("confidence_score", sa.Float(), nullable=True),
        )

    # === LANGCHAIN_PG_COLLECTION TABLE (for LangChain integration) ===
    if not db_utils.table_exists("langchain_pg_collection"):
        op.create_table(
            db_utils.get_table_name("langchain_pg_collection"),
            db_utils.create_uuid_column("uuid", primary_key=True),
            db_utils.create_varchar_column("name", 255, nullable=False, unique=True),
            sa.Column("cmetadata", json_type, nullable=True),
        )

    # === LANGCHAIN_PG_EMBEDDING TABLE (for LangChain integration) ===
    if not db_utils.table_exists("langchain_pg_embedding"):
        # Create basic table structure
        op.create_table(
            db_utils.get_table_name("langchain_pg_embedding"),
            db_utils.create_uuid_column("uuid", primary_key=True),
            db_utils.create_uuid_column("collection_id", foreign_key="langchain_pg_collection.uuid", on_delete="CASCADE", nullable=False, index=True),
            sa.Column("document", sa.Text(), nullable=False),
            sa.Column("cmetadata", json_type, nullable=True),
            sa.Column("custom_id", sa.String(255), nullable=True),
        )

        # Add vector column for PostgreSQL
        if is_postgres:
            op.execute(text(f"""
                ALTER TABLE {db_utils.get_table_name("langchain_pg_embedding")}
                ADD COLUMN embedding vector(1536)
            """))

            # Create index for similarity search
            # noinspection PyBroadException
            try:
                op.execute(text(f"""
                    CREATE INDEX IF NOT EXISTS idx_langchain_embedding_hnsw
                    ON {db_utils.get_table_name("langchain_pg_embedding")}
                    USING hnsw (embedding vector_cosine_ops)
                    WITH (m = 16, ef_construction = 64)
                """))
            except Exception:
                op.execute(text(f"""
                    CREATE INDEX IF NOT EXISTS idx_langchain_embedding_ivfflat
                    ON {db_utils.get_table_name("langchain_pg_embedding")}
                    USING ivfflat (embedding vector_cosine_ops)
                    WITH (lists = 100)
                """))

    # Create composite indexes for performance
    if is_postgres:
        # noinspection PyBroadException
        try:
            op.create_index(
                "idx_document_chunks_doc_collection",
                db_utils.get_table_name("document_chunks"),
                ["document_id", "collection_id"]
            )
        except Exception:
            pass

        # noinspection PyBroadException
        try:
            op.create_index(
                "idx_document_chunks_collection_page",
                db_utils.get_table_name("document_chunks"),
                ["collection_id", "page_number"]
            )
        except Exception:
            pass


def downgrade() -> None:
    """Drop RAG and vector tables."""
    tables = [
        "langchain_pg_embedding",
        "langchain_pg_collection",
        "document_summaries",
        "document_chunks",
    ]

    for table in tables:
        if db_utils.table_exists(table):
            op.drop_table(db_utils.get_table_name(table))

    # Note: We don't drop the pgvector extension as it might be used by other databases
