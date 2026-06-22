"""Increase file_type max_length to 255 for DOCX MIME type

Revision ID: 016
Revises: 015
Create Date: 2026-01-23 22:04:50.361157

"""
from typing import Union
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '016'
down_revision: str | None = '015'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Increase file_type column length from 50 to 255 to support long MIME types
    # Example: application/vnd.openxmlformats-officedocument.wordprocessingml.document (73 chars)
    op.alter_column('documents', 'file_type',
                   existing_type=sa.VARCHAR(length=50),
                   type_=sa.VARCHAR(length=255),
                   existing_nullable=True)


def downgrade() -> None:
    # Revert file_type column length from 255 back to 50
    op.alter_column('documents', 'file_type',
                   existing_type=sa.VARCHAR(length=255),
                   type_=sa.VARCHAR(length=50),
                   existing_nullable=True)
