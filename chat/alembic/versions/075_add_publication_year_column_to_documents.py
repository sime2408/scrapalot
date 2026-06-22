"""Add publication_year column to documents

Revision ID: 075
Revises: 074
Create Date: 2026-05-22 14:44:18.879516

Adds a dedicated ``publication_year`` integer column to ``documents`` so
metadata resolvers (Google Books, OpenLibrary) can persist the original
source publication year out of the ``extracted_metadata`` JSON blob into
an indexable column. This unlocks temporal-graph queries and per-decade
filters in admin/dataset workflows without parsing JSON on every row.

Backfill of existing rows from ``extracted_metadata`` JSON is handled by
``scripts/backfill/backfill_publication_year.py`` rather than inline here — the
metadata column is stored as character varying in production and parsing
it inside a single transaction blocks DDL longer than is acceptable on a
large table. Run the backfill script separately after this migration.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "075"
down_revision: str | None = "074"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column("publication_year", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_documents_publication_year",
        "documents",
        ["publication_year"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_documents_publication_year", table_name="documents")
    op.drop_column("documents", "publication_year")
