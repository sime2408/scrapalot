"""Add missing columns to collections and documents tables

Revision ID: 019
Revises: 018
Create Date: 2026-01-27

Fixes SQLite database that was created with an older schema missing columns
expected by the application. Adds columns that exist in SQLModel definitions
but were missing from the database:

collections:
- description (Text)
- chunking_strategy (VARCHAR 50)
- chunk_size (Integer)
- chunk_overlap (Integer)
- is_processing (Boolean)
- processing_error (Text)

documents:
- title (VARCHAR 255)
- filename (VARCHAR 255)
- file_size (BigInteger)
- file_type (VARCHAR 255)
- content (Text)
- page_count (Integer)
- word_count (Integer)
- processing_error (Text)
- processing_progress (Float)
- file_metadata (JSON)
- extracted_metadata (JSON)
- celery_task_id (VARCHAR 100)
"""
from pathlib import Path
import sys

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from typing import Union
from collections.abc import Sequence

import db_utils
import sqlalchemy as sa
from sqlalchemy import text

from alembic import op

revision: str = '019'
down_revision: str | None = '018'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# noinspection PyTypeChecker
def upgrade() -> None:
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]
    json_type = db_utils.get_json_column_type()

    # =========================================================================
    # COLLECTIONS TABLE - Add missing columns
    # =========================================================================
    if db_utils.table_exists("collections"):
        # description
        if not db_utils.column_exists("collections", "description"):
            op.add_column("collections", sa.Column("description", sa.Text(), nullable=True))

        # chunking_strategy
        if not db_utils.column_exists("collections", "chunking_strategy"):
            op.add_column("collections", sa.Column("chunking_strategy", sa.String(50), nullable=True))

        # chunk_size
        if not db_utils.column_exists("collections", "chunk_size"):
            op.add_column("collections", sa.Column("chunk_size", sa.Integer(), nullable=True))

        # chunk_overlap
        if not db_utils.column_exists("collections", "chunk_overlap"):
            op.add_column("collections", sa.Column("chunk_overlap", sa.Integer(), nullable=True))

        # is_processing
        if not db_utils.column_exists("collections", "is_processing"):
            default_val = text("false") if is_postgres else "0"
            op.add_column("collections", sa.Column("is_processing", sa.Boolean(), nullable=False, server_default=default_val))

        # processing_error
        if not db_utils.column_exists("collections", "processing_error"):
            op.add_column("collections", sa.Column("processing_error", sa.Text(), nullable=True))

    # =========================================================================
    # DOCUMENTS TABLE - Add missing columns
    # =========================================================================
    if db_utils.table_exists("documents"):
        # title
        if not db_utils.column_exists("documents", "title"):
            # For existing rows, use filename as title if available
            op.add_column("documents", sa.Column("title", sa.String(255), nullable=True))
            conn = op.get_bind()
            # Try to copy filename to title for existing rows
            if db_utils.column_exists("documents", "filename"):
                conn.execute(text("UPDATE documents SET title = filename WHERE title IS NULL AND filename IS NOT NULL"))

        # filename
        if not db_utils.column_exists("documents", "filename"):
            # For existing rows, extract from file_path
            op.add_column("documents", sa.Column("filename", sa.String(255), nullable=True))

        # file_size
        if not db_utils.column_exists("documents", "file_size"):
            op.add_column("documents", sa.Column("file_size", sa.BigInteger(), nullable=True))

        # file_type
        if not db_utils.column_exists("documents", "file_type"):
            op.add_column("documents", sa.Column("file_type", sa.String(255), nullable=True))
            db_utils.safe_create_index("ix_documents_file_type", "documents", ["file_type"])

        # content
        if not db_utils.column_exists("documents", "content"):
            op.add_column("documents", sa.Column("content", sa.Text(), nullable=True))

        # page_count
        if not db_utils.column_exists("documents", "page_count"):
            op.add_column("documents", sa.Column("page_count", sa.Integer(), nullable=True))

        # word_count
        if not db_utils.column_exists("documents", "word_count"):
            op.add_column("documents", sa.Column("word_count", sa.Integer(), nullable=True))

        # processing_error
        if not db_utils.column_exists("documents", "processing_error"):
            op.add_column("documents", sa.Column("processing_error", sa.Text(), nullable=True))

        # processing_progress
        if not db_utils.column_exists("documents", "processing_progress"):
            op.add_column("documents", sa.Column("processing_progress", sa.Float(), nullable=False, server_default="0.0"))

        # file_metadata
        if not db_utils.column_exists("documents", "file_metadata"):
            op.add_column("documents", sa.Column("file_metadata", json_type, nullable=True))

        # extracted_metadata
        if not db_utils.column_exists("documents", "extracted_metadata"):
            op.add_column("documents", sa.Column("extracted_metadata", json_type, nullable=True))

        # celery_task_id
        if not db_utils.column_exists("documents", "celery_task_id"):
            op.add_column("documents", sa.Column("celery_task_id", sa.String(100), nullable=True))

        # Add indexes for title and filename if not exists
        db_utils.safe_create_index("ix_documents_title", "documents", ["title"])
        db_utils.safe_create_index("ix_documents_filename", "documents", ["filename"])


def downgrade() -> None:
    # Remove documents columns
    if db_utils.table_exists("documents"):
        for col in ["celery_task_id", "extracted_metadata", "file_metadata",
                    "processing_progress", "processing_error", "word_count",
                    "page_count", "content", "file_type", "file_size",
                    "filename", "title"]:
            if db_utils.column_exists("documents", col):
                op.drop_column("documents", col)

    # Remove collections columns
    if db_utils.table_exists("collections"):
        for col in ["processing_error", "is_processing", "chunk_overlap",
                    "chunk_size", "chunking_strategy", "description"]:
            if db_utils.column_exists("collections", col):
                op.drop_column("collections", col)
