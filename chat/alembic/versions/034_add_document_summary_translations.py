"""Add document_summary_translations table for cached LLM translations.

Revision ID: 034
Revises: 033
Create Date: 2026-03-08

Caches LLM-translated book summaries per language to avoid re-translating.
Used by the TranslateBookSummary gRPC streaming RPC.
"""

from pathlib import Path
import sys

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from typing import Union
from collections.abc import Sequence

import db_utils
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

# revision identifiers
revision: str = "034"
down_revision: str | None = "033"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if not db_utils.table_exists("document_summary_translations"):
        op.create_table(
            "document_summary_translations",
            sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
            sa.Column("document_id", UUID(as_uuid=True), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
            sa.Column("summary_type", sa.String(50), nullable=False, server_default="book"),
            sa.Column("language", sa.String(10), nullable=False),
            sa.Column("translated_text", sa.Text, nullable=False),
            sa.Column("model_used", sa.String(100), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )

    # Unique constraint: one translation per document+type+language
    if not db_utils.index_exists("uq_doc_summary_translation", "document_summary_translations"):
        op.create_unique_constraint(
            "uq_doc_summary_translation",
            "document_summary_translations",
            ["document_id", "summary_type", "language"],
        )

    if not db_utils.index_exists("ix_doc_summary_translations_doc_id", "document_summary_translations"):
        op.create_index(
            "ix_doc_summary_translations_doc_id",
            "document_summary_translations",
            ["document_id"],
        )


def downgrade() -> None:
    op.drop_table("document_summary_translations")
