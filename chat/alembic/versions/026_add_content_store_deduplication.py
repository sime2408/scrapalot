"""Add content_store table for content-addressable file storage with deduplication.

Revision ID: 026
Revises: 025
Create Date: 2026-02-28

Adds content_store table for SHA-256-based file deduplication with reference
counting, and a content_store_id FK on the documents table.
"""
from pathlib import Path
import sys

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from typing import Union
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID as PgUUID

from alembic import op

revision: str = '026'
down_revision: str | None = '025'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Create content_store table
    op.create_table(
        'content_store',
        sa.Column('id', PgUUID(), primary_key=True),
        sa.Column('file_hash', sa.String(64), nullable=False),
        sa.Column('content_hash', sa.String(64), nullable=True),
        sa.Column('file_path', sa.String(500), nullable=False),
        sa.Column('file_size', sa.Integer(), nullable=False),
        sa.Column('file_type', sa.String(255), nullable=True),
        sa.Column('original_filename', sa.String(255), nullable=False),
        sa.Column('page_count', sa.Integer(), nullable=True),
        sa.Column('word_count', sa.Integer(), nullable=True),
        sa.Column('processing_status', sa.String(20), nullable=False, server_default='pending'),
        sa.Column('ref_count', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # Create unique index on file_hash for deduplication lookups
    op.create_index('ix_content_store_file_hash', 'content_store', ['file_hash'], unique=True)

    # Add content_store_id FK column to documents
    op.add_column('documents', sa.Column('content_store_id', PgUUID(), nullable=True))
    op.create_index('ix_documents_content_store_id', 'documents', ['content_store_id'])
    op.create_foreign_key(
        'fk_documents_content_store_id_content_store',
        'documents',
        'content_store',
        ['content_store_id'],
        ['id'],
        ondelete='SET NULL',
    )


def downgrade() -> None:
    op.drop_constraint('fk_documents_content_store_id_content_store', 'documents', type_='foreignkey')
    op.drop_index('ix_documents_content_store_id', table_name='documents')
    op.drop_column('documents', 'content_store_id')
    op.drop_index('ix_content_store_file_hash', table_name='content_store')
    op.drop_table('content_store')
