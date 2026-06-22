"""schema_updates

Revision ID: 011
Revises: 010
Create Date: 2025-12-31 10:00:00

Squashed migrations:
- 011_add_timestamps_to_note_shares.py
- 012_remove_soft_delete_from_notes.py
- 013_add_yjs_state_to_notes.py
- 014_remove_unused_document_tables.py
- 016_add_document_summaries.py
- 017_add_tour_completed_to_users.py
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
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '011'
down_revision: str | None = '010'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# noinspection PyTypeChecker
def upgrade() -> None:
    from sqlalchemy import text
    conn = op.get_bind()

    # ### From 011_add_timestamps_to_note_shares.py ###
    # Add timestamps to note_shares (only if not already present)
    if not db_utils.column_exists('note_shares', 'created_at'):
        op.add_column('note_shares', sa.Column('created_at', sa.DateTime(), nullable=True))
        conn.execute(text("UPDATE note_shares SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL"))
        op.alter_column('note_shares', 'created_at', nullable=False)

    if not db_utils.column_exists('note_shares', 'updated_at'):
        op.add_column('note_shares', sa.Column('updated_at', sa.DateTime(), nullable=True))
        conn.execute(text("UPDATE note_shares SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL"))
        op.alter_column('note_shares', 'updated_at', nullable=False)

    # ### From 012_remove_soft_delete_from_notes.py ###
    # Remove soft delete columns from notes (only if present)
    if db_utils.column_exists('notes', 'is_deleted'):
        op.drop_column('notes', 'is_deleted')
    if db_utils.column_exists('notes', 'deleted_at'):
        op.drop_column('notes', 'deleted_at')

    # ### From 013_add_yjs_state_to_notes.py ###
    # Add yjs_state column to notes for collaborative editing
    if not db_utils.column_exists('notes', 'yjs_state'):
        op.add_column('notes', sa.Column('yjs_state', sa.LargeBinary(), nullable=True))

    # ### From 014_remove_unused_document_tables.py ###
    # NOTE: document_chunks is still used by migration 006 for indexes
    # Only drop if table exists and is the OLD schema (without collection_id)
    # The new document_chunks table has collection_id column
    if db_utils.table_exists('document_chunks'):
        if not db_utils.column_exists('document_chunks', 'collection_id'):
            # Old schema - safe to drop
            op.drop_table('document_chunks')

    # Drop old document_summaries if it exists with old schema
    if db_utils.table_exists('document_summaries'):
        if not db_utils.column_exists('document_summaries', 'summary_type'):
            # Old schema - safe to drop and recreate
            op.drop_table('document_summaries')

    # ### From 016_add_document_summaries.py ###
    # Create NEW document_summaries table (different schema from the old one)
    if not db_utils.table_exists('document_summaries'):
        uuid_type = db_utils.get_uuid_column_type()
        json_type = db_utils.get_json_column_type()
        datetime_type = db_utils.get_datetime_column_type()

        op.create_table(
            'document_summaries',
            sa.Column('id', uuid_type, nullable=False),
            sa.Column('document_id', uuid_type, nullable=False),
            sa.Column('summary_text', sa.Text(), nullable=False),
            sa.Column('summary_type', sa.String(length=50), nullable=False),
            sa.Column('metadata', json_type, nullable=True),
            sa.Column('created_at', datetime_type, nullable=False),
            sa.Column('updated_at', datetime_type, nullable=False),
            # noinspection PyTypeChecker
            sa.ForeignKeyConstraint(['document_id'], ['documents.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id')
        )
        db_utils.safe_create_index(
            'ix_document_summaries_document_id',
            'document_summaries',
            ['document_id']
        )
        db_utils.safe_create_index(
            'ix_document_summaries_summary_type',
            'document_summaries',
            ['summary_type']
        )

    # ### From 017_add_tour_completed_to_users.py ###
    # Add tour_completed flag to users
    if not db_utils.column_exists('users', 'tour_completed'):
        op.add_column('users', sa.Column('tour_completed', sa.Boolean(), nullable=True))
        conn.execute(text("UPDATE users SET tour_completed = false WHERE tour_completed IS NULL"))
        op.alter_column('users', 'tour_completed', nullable=False, server_default=sa.text("false"))


def downgrade() -> None:
    # ### Reverse 017_add_tour_completed_to_users.py ###
    op.drop_column('users', 'tour_completed')

    # ### Reverse 016_add_document_summaries.py ###
    op.drop_index('ix_document_summaries_summary_type', table_name='document_summaries')
    op.drop_index('ix_document_summaries_document_id', table_name='document_summaries')
    op.drop_table('document_summaries')

    # ### Reverse 014_remove_unused_document_tables.py ###
    # Recreate old tables (may be empty)
    op.create_table(
        'document_summaries',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('document_id', sa.String(length=36), nullable=False),
        sa.Column('summary', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_table(
        'document_chunks',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('document_id', sa.String(length=36), nullable=False),
        sa.Column('chunk_text', sa.Text(), nullable=False),
        sa.Column('chunk_index', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint('id')
    )

    # ### Reverse 013_add_yjs_state_to_notes.py ###
    op.drop_column('notes', 'yjs_state')

    # ### Reverse 012_remove_soft_delete_from_notes.py ###
    op.add_column('notes',
        sa.Column('is_deleted', sa.Boolean(),
                  server_default=sa.text("'false'"), nullable=False)
    )
    op.add_column('notes',
        sa.Column('deleted_at', sa.DateTime(), nullable=True)
    )

    # ### Reverse 011_add_timestamps_to_note_shares.py ###
    op.drop_column('note_shares', 'updated_at')
    op.drop_column('note_shares', 'created_at')
