"""Add file_stored column to documents table.

Revision ID: 032
Revises: 031
Create Date: 2026-03-04

Adds file_stored boolean to distinguish memory-only documents
(embeddings exist but physical file was discarded) from full documents.
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

# revision identifiers
revision: str = "032"
down_revision: str | None = "031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if not db_utils.column_exists("documents", "file_stored"):
        op.add_column(
            "documents",
            sa.Column(
                "file_stored",
                sa.Boolean(),
                nullable=False,
                server_default="true",
            ),
        )
        op.create_index("ix_documents_file_stored", "documents", ["file_stored"])


def downgrade() -> None:
    if db_utils.column_exists("documents", "file_stored"):
        op.drop_index("ix_documents_file_stored", table_name="documents")
        op.drop_column("documents", "file_stored")
