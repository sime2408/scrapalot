"""Add epub_cfi field to reading_positions

Revision ID: 015
Revises: 014
Create Date: 2026-01-19 18:30:52.454233

"""
from typing import Union
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '015'
down_revision: str | None = '014'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Add epub_cfi column to reading_positions table
    op.add_column(
        'reading_positions',
        sa.Column('epub_cfi', sa.String(), nullable=True),
        schema='public'
    )


def downgrade() -> None:
    # Remove epub_cfi column from reading_positions table
    op.drop_column('reading_positions', 'epub_cfi', schema='public')
