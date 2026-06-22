"""Add processing_stats JSONB column to documents table.

Revision ID: 027
Revises: 026
Create Date: 2026-03-01

Stores per-document processing statistics: phase timings (parse, chunk,
embed, graph), chunk/embedding/entity counts, processor used, and
chunking strategy. Populated in background after document processing.
"""
from pathlib import Path
import sys

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from typing import Union
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = '027'
down_revision: str | None = '026'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('documents', sa.Column('processing_stats', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('documents', 'processing_stats')
