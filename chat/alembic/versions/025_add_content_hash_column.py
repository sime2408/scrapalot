"""Add content_hash column to documents table.

Revision ID: 025
Revises: 024
Create Date: 2026-02-28

Adds content_hash (SHA-256) column for cache-aware document reprocessing.
When reprocessing, if the hash matches, LLM-expensive steps (summarization,
embedding generation, entity extraction) are skipped.
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

revision: str = '025'
down_revision: str | None = '024'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('documents', sa.Column('content_hash', sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column('documents', 'content_hash')
