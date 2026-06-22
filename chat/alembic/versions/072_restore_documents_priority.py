"""Restore documents.priority column.

Revision ID: 072
Revises: 071
Create Date: 2026-05-15 07:00:00.000000

Migration 067 dropped ``documents.priority`` on the assumption that the
column was unreferenced. That pre-flight grep missed three production call
sites that read/write the column:

- ``retriever_pgvector._inject_document_priorities`` selects priority for
  reranker boosting,
- ``document_evaluation_service`` orders evaluation candidates by priority,
- ``document_extras_service.UpdateDocumentPriority`` (gRPC RPC exposed
  through the Kotlin ``PATCH /documents/{id}/priority`` endpoint) writes
  user-set priorities.

Post-067 production logs filled with ``column "priority" does not exist``
errors on every reranking pass and every priority PATCH. Re-add the column
with the original definition so the existing code paths work again.
"""
from collections.abc import Sequence
from typing import Union

from alembic import op
import sqlalchemy as sa


revision: str = "072"
down_revision: str | None = "071"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column(
            "priority",
            sa.Float(),
            nullable=False,
            server_default="1.0",
        ),
    )


def downgrade() -> None:
    op.drop_column("documents", "priority")
