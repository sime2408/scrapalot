"""Add context expansion support - document hierarchy and GIN indices

Revision ID: 009
Revises: 008
Create Date: 2025-12-11

This migration adds support for Phase 1-2 of the Context Expansion PRD:
- Adds document_hierarchy column to documents table for storing document structure
- Adds GIN index on document_chunks.metadata for efficient section queries
- Supports both PostgreSQL and SQLite databases
"""

from pathlib import Path
import sys

# Add parent directory to path for importing db_utils
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

# Revision identifiers
revision = "009"
down_revision = "008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# noinspection PyTypeChecker
def upgrade():
    """Add context expansion support."""
    # Get database dialect info
    dialect_info = db_utils.get_dialect_info()
    conn = op.get_bind()

    # 1. Add document_hierarchy column to documents table
    table_name = db_utils.get_table_name("documents")

    # Check if column doesn't already exist
    if not db_utils.column_exists("documents", "document_hierarchy"):
        print(f"Adding document_hierarchy column to {table_name}")

        if dialect_info["is_postgresql"]:
            # PostgreSQL: Use JSONB for better performance
            op.add_column(
                "documents",
                sa.Column("document_hierarchy", sa.dialects.postgresql.JSONB, nullable=True)
            )
        else:
            # SQLite: Use JSON
            op.add_column(
                "documents",
                sa.Column("document_hierarchy", sa.JSON, nullable=True)
            )
    else:
        print("document_hierarchy column already exists, skipping...")

    # 2. Add GIN index on document_chunks.metadata for efficient section queries (PostgreSQL only)
    if dialect_info["is_postgresql"]:
        chunk_table_name = db_utils.get_table_name("document_chunks")

        # Check if index doesn't already exist
        try:
            conn.execute(text(f"""
                SELECT 1 FROM pg_indexes
                WHERE tablename = 'document_chunks'
                AND indexname = 'idx_document_chunks_metadata_gin'
            """))
            result = conn.fetchone()

            if not result:
                print(f"Creating GIN index on {chunk_table_name}.metadata")
                conn.execute(text(f"""
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_document_chunks_metadata_gin
                    ON {chunk_table_name} USING GIN (metadata jsonb_path_ops)
                """))
            else:
                print("GIN index on document_chunks.metadata already exists, skipping...")
        except Exception as e:
            print(f"Error creating GIN index: {e}")
            # Non-blocking: Create without CONCURRENTLY as fallback
            try:
                conn.execute(text(f"""
                    CREATE INDEX IF NOT EXISTS idx_document_chunks_metadata_gin
                    ON {chunk_table_name} USING GIN (metadata jsonb_path_ops)
                """))
            except Exception as fallback_e:
                print(f"Fallback index creation also failed: {fallback_e}")

    # 3. Add regular index on section_heading for SQLite and as backup for PostgreSQL
    chunk_table_name = db_utils.get_table_name("document_chunks")

    try:
        if dialect_info["is_postgresql"]:
            # PostgreSQL: JSON path index for section_heading
            conn.execute(text(f"""
                CREATE INDEX IF NOT EXISTS idx_document_chunks_section_heading
                ON {chunk_table_name} USING btree ((metadata->>'section_heading'))
            """))
        else:
            # SQLite: JSON extract index
            conn.execute(text(f"""
                CREATE INDEX IF NOT EXISTS idx_document_chunks_section_heading
                ON {chunk_table_name} (json_extract(metadata, '$.section_heading'))
            """))
        print(f"Created section_heading index on {chunk_table_name}")
    except Exception as e:
        print(f"Error creating section_heading index: {e}")


# noinspection PyTypeChecker
def downgrade():
    """Remove context expansion support."""
    # Get database dialect info
    dialect_info = db_utils.get_dialect_info()
    conn = op.get_bind()

    # 1. Drop indices
    if dialect_info["is_postgresql"]:
        try:
            conn.execute(text("DROP INDEX IF EXISTS idx_document_chunks_metadata_gin"))
            conn.execute(text("DROP INDEX IF EXISTS idx_document_chunks_section_heading"))
        except Exception as e:
            print(f"Error dropping PostgreSQL indices: {e}")
    else:
        try:
            conn.execute(text("DROP INDEX IF EXISTS idx_document_chunks_section_heading"))
        except Exception as e:
            print(f"Error dropping SQLite index: {e}")

    # 2. Drop document_hierarchy column
    try:
        op.drop_column("documents", "document_hierarchy")
    except Exception as e:
        print(f"Error dropping document_hierarchy column: {e}")
