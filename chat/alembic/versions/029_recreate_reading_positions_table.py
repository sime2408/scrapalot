"""Recreate reading_positions table (fixes missing table from migration 014)

Migration 014 created reading_positions with FK to users.id which does not
exist in the Python database (users live in Kotlin DB). This caused the
original migration to fail silently. This migration creates the table
correctly with user_id as a plain UUID (no FK constraint).

Revision ID: 029
Revises: 028
Create Date: 2026-03-02

"""
from pathlib import Path
import sys
from typing import Union
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# Add parent directory to path to import db_utils
sys.path.append(str(Path(__file__).parent))
# noinspection PyUnresolvedReferences
import db_utils

# revision identifiers, used by Alembic.
revision: str = '029'
down_revision: str | None = '028'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create reading_positions table if it does not exist."""
    if db_utils.table_exists('reading_positions'):
        return

    op.create_table(
        'reading_positions',
        db_utils.create_uuid_column('id', primary_key=True),
        db_utils.create_uuid_column('user_id', nullable=False),
        db_utils.create_uuid_column('document_id', nullable=False, foreign_key='documents.id', on_delete='CASCADE'),
        sa.Column('page_number', sa.Integer, nullable=False, server_default='1'),
        sa.Column('scroll_position', sa.Float, nullable=True, server_default='0.0'),
        sa.Column('epub_cfi', sa.String(), nullable=True),
        sa.Column('last_tts_char_index', sa.Integer, nullable=True),
        sa.Column('total_pages', sa.Integer, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.UniqueConstraint('user_id', 'document_id', name='uq_reading_position_user_document'),
    )

    db_utils.safe_create_index('ix_reading_positions_user_id', 'reading_positions', ['user_id'])
    db_utils.safe_create_index('ix_reading_positions_document_id', 'reading_positions', ['document_id'])


def downgrade() -> None:
    """Drop reading_positions table."""
    if not db_utils.table_exists('reading_positions'):
        return

    op.drop_index('ix_reading_positions_document_id', table_name='reading_positions')
    op.drop_index('ix_reading_positions_user_id', table_name='reading_positions')
    op.drop_table('reading_positions')
