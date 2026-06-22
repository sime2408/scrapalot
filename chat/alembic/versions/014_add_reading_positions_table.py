"""Add reading_positions table

Revision ID: 014
Revises: 013
Create Date: 2026-01-05 19:19:52.809733

"""
from pathlib import Path
import sys
from typing import Union
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# Add a parent directory to a path to import db_utils
sys.path.append(str(Path(__file__).parent))
# noinspection PyUnresolvedReferences
import db_utils

# revision identifiers, used by Alembic.
revision: str = '014'
down_revision: str | None = '013'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# noinspection PyTypeChecker
def upgrade() -> None:
    """Create reading_positions table for tracking user reading positions in PDFs."""
    # Create reading_positions table
    op.create_table(
        'reading_positions',
        db_utils.create_uuid_column('id', primary_key=True),
        db_utils.create_uuid_column('user_id', nullable=False),
        db_utils.create_uuid_column('document_id', nullable=False),
        sa.Column('page_number', sa.Integer, nullable=False, server_default='1'),
        sa.Column('scroll_position', sa.Float, nullable=True, server_default='0.0'),
        sa.Column('last_tts_char_index', sa.Integer, nullable=True),
        sa.Column('total_pages', sa.Integer, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['document_id'], ['documents.id'], ondelete='CASCADE'),
        sa.UniqueConstraint('user_id', 'document_id', name='uq_reading_position_user_document'),
    )

    # Create indexes for better query performance
    op.create_index(
        'ix_reading_positions_user_id',
        'reading_positions',
        ['user_id']
    )
    op.create_index(
        'ix_reading_positions_document_id',
        'reading_positions',
        ['document_id']
    )


def downgrade() -> None:
    """Drop reading_positions table and its indexes."""
    # Drop indexes
    op.drop_index('ix_reading_positions_document_id', table_name='reading_positions')
    op.drop_index('ix_reading_positions_user_id', table_name='reading_positions')

    # Drop table
    op.drop_table('reading_positions')
