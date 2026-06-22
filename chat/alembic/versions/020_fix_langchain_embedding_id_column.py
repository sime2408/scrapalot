"""Fix langchain_pg_embedding schema to match LangChain postgres v0.0.16

Revision ID: 020
Revises: 019
Create Date: 2026-02-12

Two fixes for the langchain vector tables:

1. Rename 'uuid' column to 'id' in langchain_pg_embedding.
   LangChain postgres v0.0.16 expects 'id' (String PK), but migration 005
   created 'uuid' (UUID PK). This caused:
     column "id" of relation "langchain_pg_embedding" does not exist

2. Remove fixed dimension constraint from embedding vector columns.
   Migration 005 hardcoded vector(1536) for OpenAI ada-002, but local models
   (e.g., all-MiniLM-L6-v2) produce 384-dimensional vectors. This caused:
     expected 1536 dimensions, not 384
   LangChain PGVector handles dimensions dynamically, so we remove the
   fixed constraint to allow any embedding model to be used.
"""
from pathlib import Path
import sys

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from typing import Union
from collections.abc import Sequence

import db_utils
from sqlalchemy import text

from alembic import op

revision: str = '020'
down_revision: str | None = '019'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# noinspection PyTypeChecker
def upgrade() -> None:
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]

    if not db_utils.table_exists("langchain_pg_embedding"):
        return

    # Check if the column needs renaming (uuid exists but id does not)
    has_uuid = db_utils.column_exists("langchain_pg_embedding", "uuid")
    has_id = db_utils.column_exists("langchain_pg_embedding", "id")

    if has_uuid and not has_id:
        if is_postgres:
            conn = op.get_bind()
            # Rename the column from uuid to id
            conn.execute(text(
                'ALTER TABLE langchain_pg_embedding RENAME COLUMN "uuid" TO id'
            ))
            # Change type from UUID to VARCHAR to match LangChain's String type
            conn.execute(text(
                "ALTER TABLE langchain_pg_embedding ALTER COLUMN id TYPE VARCHAR USING id::text"
            ))
        else:
            # SQLite supports RENAME COLUMN since 3.25.0
            op.alter_column("langchain_pg_embedding", "uuid", new_column_name="id")

    # Fix 2: Remove fixed vector dimension constraint from embedding columns.
    # Migration 005 hardcoded vector(1536) but local models use 384 dimensions.
    # LangChain handles dimensions dynamically, so we use vector without a fixed size.
    if is_postgres:
        conn = op.get_bind()

        # Fix langchain_pg_embedding.embedding: vector(1536) -> vector
        if db_utils.table_exists("langchain_pg_embedding") and db_utils.column_exists("langchain_pg_embedding", "embedding"):
            # noinspection PyBroadException
            try:
                # Drop and recreate HNSW index since it depends on the column type
                conn.execute(text("DROP INDEX IF EXISTS idx_langchain_embedding_hnsw"))
                conn.execute(text("DROP INDEX IF EXISTS idx_langchain_embedding_ivfflat"))
                # Change column type to vector without dimension constraint
                conn.execute(text(
                    "ALTER TABLE langchain_pg_embedding ALTER COLUMN embedding TYPE vector USING embedding::vector"
                ))
            except Exception:
                pass  # Column may already be unconstrained

        # Fix document_chunks.embedding: vector(1536) -> vector
        if db_utils.table_exists("document_chunks") and db_utils.column_exists("document_chunks", "embedding"):
            # noinspection PyBroadException
            try:
                conn.execute(text("DROP INDEX IF EXISTS idx_document_chunks_embedding_hnsw"))
                conn.execute(text("DROP INDEX IF EXISTS idx_document_chunks_embedding_ivfflat"))
                conn.execute(text(
                    "ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector USING embedding::vector"
                ))
            except Exception:
                pass  # Column may already be unconstrained


# noinspection PyTypeChecker
def downgrade() -> None:
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]

    if not db_utils.table_exists("langchain_pg_embedding"):
        return

    has_id = db_utils.column_exists("langchain_pg_embedding", "id")
    has_uuid = db_utils.column_exists("langchain_pg_embedding", "uuid")

    if has_id and not has_uuid:
        if is_postgres:
            conn = op.get_bind()
            conn.execute(text(
                "ALTER TABLE langchain_pg_embedding ALTER COLUMN id TYPE UUID USING id::uuid"
            ))
            conn.execute(text(
                'ALTER TABLE langchain_pg_embedding RENAME COLUMN id TO "uuid"'
            ))
        else:
            op.alter_column("langchain_pg_embedding", "id", new_column_name="uuid")

    # Restore fixed vector(1536) dimension constraint
    if is_postgres:
        conn = op.get_bind()

        if db_utils.table_exists("langchain_pg_embedding") and db_utils.column_exists("langchain_pg_embedding", "embedding"):
            # noinspection PyBroadException
            try:
                conn.execute(text(
                    "ALTER TABLE langchain_pg_embedding ALTER COLUMN embedding TYPE vector(1536)"
                ))
            except Exception:
                pass

        if db_utils.table_exists("document_chunks") and db_utils.column_exists("document_chunks", "embedding"):
            # noinspection PyBroadException
            try:
                conn.execute(text(
                    "ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector(1536)"
                ))
            except Exception:
                pass
