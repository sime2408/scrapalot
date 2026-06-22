"""Drop dead columns documents.neo4j_node_id and documents.priority

Revision ID: 067
Revises: 066
Create Date: 2026-05-04 06:56:06.986100

Both columns are unused in production:

- ``documents.neo4j_node_id`` (varchar, nullable) was never written by any
  code path — every Book lookup uses ``MATCH (b:Book {document_id: ...})``
  in Cypher, not the elementId. 100% NULL across all 889 production rows
  on 2026-05-04. Not present in the SQLModel either; pure schema leftover.

- ``documents.priority`` (double precision, NOT NULL, default=1.0) is in
  ``models.sqlmodel_models.Document`` with the comment "Document priority
  for retrieval weighting (1.0 = normal, >1 = boosted, <1 = deprioritized)"
  — the feature was never implemented. 100% of rows have value 1.0; no
  call site reads or writes the field. Dead.

Dropping is destructive but safe: pre-flight grep across scrapalot-chat,
scrapalot-backend, scrapalot-ui, and scrapalot-gw confirmed zero usages
before this migration.

Downgrade restores both columns with their original definitions and
defaults; existing rows are recreated NULL / 1.0 respectively.
"""
from typing import Union
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "067"
down_revision: str | None = "066"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("documents", "neo4j_node_id")
    op.drop_column("documents", "priority")


def downgrade() -> None:
    op.add_column(
        "documents",
        sa.Column("neo4j_node_id", sa.String(), nullable=True),
    )
    op.add_column(
        "documents",
        sa.Column(
            "priority",
            sa.Float(),
            nullable=False,
            server_default="1.0",
        ),
    )
