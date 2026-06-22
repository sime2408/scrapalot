"""Widen document_summaries.chapter_title and section_heading from VARCHAR(500) to TEXT

Revision ID: 071
Revises: 070
Create Date: 2026-05-10 11:55:00.000000

Polluted hierarchy keys from flat-markdown EPUBs concatenated body text into the
chapter title field and exceeded varchar(500). Cat-G summary persistence then
crashed with StringDataRightTruncation on books like 4710bf45 (Acuna Rain
Harvesting). Defensive truncation in document_summary_service is the first
line of defense; widening the column itself removes the data-loss risk for
the operator who later chooses to surface raw chunker output without trimming.

Pure widening — no data loss possible because the new TEXT type accepts every
value the old VARCHAR(500) accepted.
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "071"
down_revision: str | None = "070"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "document_summaries",
        "chapter_title",
        existing_type=sa.String(length=500),
        type_=sa.Text(),
        existing_nullable=True,
    )
    op.alter_column(
        "document_summaries",
        "section_heading",
        existing_type=sa.String(length=500),
        type_=sa.Text(),
        existing_nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "document_summaries",
        "chapter_title",
        existing_type=sa.Text(),
        type_=sa.String(length=500),
        existing_nullable=True,
    )
    op.alter_column(
        "document_summaries",
        "section_heading",
        existing_type=sa.Text(),
        type_=sa.String(length=500),
        existing_nullable=True,
    )
