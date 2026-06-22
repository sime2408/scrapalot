"""add_papers_table

Revision ID: 053
Revises: 052
Create Date: 2026-04-04
"""
from typing import Union
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '053'
down_revision: str | None = '052'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _is_pg() -> bool:
    return op.get_bind().dialect.name == 'postgresql'


def _uuid_type():
    return postgresql.UUID(as_uuid=False) if _is_pg() else sa.String(36)


def _jsonb_or_text():
    return sa.Text() if not _is_pg() else postgresql.JSONB()


def upgrade() -> None:
    op.create_table(
        'papers',
        sa.Column('id', _uuid_type(), primary_key=True, nullable=False),
        sa.Column('user_id', sa.String(255), nullable=False, index=True),
        sa.Column('workspace_id', sa.String(255), nullable=False),
        sa.Column('research_plan_id', _uuid_type(), nullable=True),
        sa.Column('note_id', sa.String(255), nullable=True),
        sa.Column('template_key', sa.String(50), nullable=False),
        sa.Column('title', sa.String(500), nullable=True),
        sa.Column('status', sa.String(20), nullable=False, server_default='pending'),
        sa.Column('output_format', sa.String(10), nullable=False, server_default='pdf'),
        sa.Column('file_path', sa.String(500), nullable=True),
        sa.Column('metadata', _jsonb_or_text(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('word_count', sa.Integer(), nullable=True),
        sa.Column('page_count', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
        sa.Column('completed_at', sa.DateTime(), nullable=True),
    )
    op.create_index('idx_papers_user', 'papers', ['user_id'])
    op.create_index('idx_papers_workspace', 'papers', ['workspace_id', 'created_at'])

    if _is_pg():
        op.create_foreign_key(
            'fk_papers_research_plan',
            'papers', 'research_plans',
            ['research_plan_id'], ['id'],
            ondelete='SET NULL',
        )


def downgrade() -> None:
    if _is_pg():
        op.drop_constraint('fk_papers_research_plan', 'papers', type_='foreignkey')
    op.drop_index('idx_papers_workspace', table_name='papers')
    op.drop_index('idx_papers_user', table_name='papers')
    op.drop_table('papers')
