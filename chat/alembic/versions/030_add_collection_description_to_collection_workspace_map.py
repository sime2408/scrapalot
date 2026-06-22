"""Add collection description to collection_workspace_map

Revision ID: 030
Revises: 029
Create Date: 2026-03-02 07:24:57.737120

"""
from typing import Union
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '030'
down_revision: str | None = '029'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('collection_workspace_map', sa.Column('description', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('collection_workspace_map', 'description')
