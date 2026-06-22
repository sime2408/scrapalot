"""Add document priority field for retrieval weighting.

Documents with priority > 1.0 are boosted in reranking results.
Default 1.0 = normal weight. Used by reranker_manager to multiply
cross-encoder or API reranking scores.

Revision ID: 049
Revises: 048
Create Date: 2026-04-03
"""

from alembic import op
import sqlalchemy as sa

revision = "049"
down_revision = "048"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("documents", sa.Column("priority", sa.Float(), nullable=False, server_default="1.0"))


def downgrade() -> None:
    op.drop_column("documents", "priority")
