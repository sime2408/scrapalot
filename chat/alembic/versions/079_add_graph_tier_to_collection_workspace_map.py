"""Add graph_tier to collection_workspace_map

Revision ID: 079
Revises: 078
Create Date: 2026-06-05 20:32:58.330592

Replica of the Kotlin-owned collections.graph_tier (migration 122). Per-collection
knowledge-graph build tier: 0=none, 1=light, 2=full; NULL=inherit from parent
(resolve_graph_tier walks parent_collection_id; root NULL → 0). Kept in sync over
the collections Redis stream + cold-start snapshot. Nullable, no default — NULL is
the meaningful "inherit" value.
"""
from typing import Union
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '079'
down_revision: str | None = '078'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "collection_workspace_map",
        sa.Column("graph_tier", sa.SmallInteger(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("collection_workspace_map", "graph_tier")
