"""Add graph_sync_status table for rebuild checkpointing

Revision ID: 036
Revises: 035
Create Date: 2026-03-08 23:00:00.000000

"""
from typing import Union
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = '036'
down_revision: str | None = '035'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Drop old per-entity graph_sync_status table and replace with per-document checkpoint table
    op.execute("DROP TABLE IF EXISTS graph_sync_status CASCADE")
    op.create_table(
        'graph_sync_status',
        sa.Column('document_id', sa.String(36), primary_key=True),
        sa.Column('collection_id', sa.String(36), nullable=False),
        sa.Column('status', sa.String(20), nullable=False, server_default='pending'),
        sa.Column('chunks_expected', sa.Integer, nullable=False, server_default='0'),
        sa.Column('chunks_created', sa.Integer, nullable=False, server_default='0'),
        sa.Column('entities_extracted', sa.Integer, nullable=False, server_default='0'),
        sa.Column('error_message', sa.Text, nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index('ix_gss_collection', 'graph_sync_status', ['collection_id'])
    op.create_index('ix_gss_status', 'graph_sync_status', ['status'])


def downgrade() -> None:
    op.drop_index('ix_gss_status')
    op.drop_index('ix_gss_collection')
    op.drop_table('graph_sync_status')
