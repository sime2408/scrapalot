"""Add graph_traversal_stats JSONB column to rag_evaluation_traces table.

Revision ID: 028
Revises: 027
Create Date: 2026-03-01

Stores graph traversal metadata from tri-modal fusion searches: nodes
visited, relationships traversed, matched entities, modality weights,
and fusion confidence. Populated in background after RAG execution.
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

revision: str = '028'
down_revision: str | None = '027'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('rag_evaluation_traces', sa.Column('graph_traversal_stats', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('rag_evaluation_traces', 'graph_traversal_stats')
