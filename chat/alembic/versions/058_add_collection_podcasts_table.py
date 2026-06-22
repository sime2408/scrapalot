"""add_collection_podcasts_table

Revision ID: 058
Revises: 057
Create Date: 2026-04-16 10:50:31.287365

Stores metadata for NotebookLM-style audio overviews. The MP3 itself lives on
disk under the user's upload tree; this table tracks generation status + the
script so the UI can show a progress bar and a transcript next to the player.

"""
from typing import Union
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '058'
down_revision: str | None = '057'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "collection_podcasts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("collection_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("language", sa.String(8), nullable=False, server_default="en"),
        sa.Column(
            "status",
            sa.String(32),
            nullable=False,
            server_default="pending",
            comment="pending | generating_script | rendering_audio | completed | failed",
        ),
        sa.Column("title", sa.String(500), nullable=True),
        sa.Column("file_path", sa.Text, nullable=True, comment="Relative path under user's upload tree"),
        sa.Column("file_size", sa.BigInteger, nullable=True),
        sa.Column("duration_ms", sa.Integer, nullable=True),
        sa.Column(
            "script_json",
            postgresql.JSONB,
            nullable=True,
            comment="[{speaker, text}, ...] — preserved so the UI can show a transcript",
        ),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("collection_podcasts")
