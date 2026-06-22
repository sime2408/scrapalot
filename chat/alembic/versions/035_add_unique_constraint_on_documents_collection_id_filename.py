"""Add unique constraint on documents collection_id filename

Revision ID: 035
Revises: 034
Create Date: 2026-03-08 06:05:00.538804

"""
from typing import Union
from collections.abc import Sequence

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '035'
down_revision: str | None = '034'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Remove duplicates first (keep the one with content, or the newest)
    op.execute("""
        DELETE FROM documents d1
        USING documents d2
        WHERE d1.collection_id = d2.collection_id
          AND d1.filename = d2.filename
          AND d1.id != d2.id
          AND (
              -- Keep the one with content; delete the one without
              (d1.content IS NULL AND d2.content IS NOT NULL)
              -- If both have or lack content, keep the newer one
              OR (d1.content IS NOT DISTINCT FROM d2.content AND d1.created_at < d2.created_at)
          )
    """)
    # Drop the old non-unique index
    op.drop_index("ix_documents_filename", table_name="documents")
    # Create unique constraint
    op.create_unique_constraint(
        "uq_documents_collection_filename",
        "documents",
        ["collection_id", "filename"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_documents_collection_filename", "documents", type_="unique")
    op.create_index("ix_documents_filename", "documents", ["filename"])
