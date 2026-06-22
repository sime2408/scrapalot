"""Add custom_instructions to collection_workspace_map (CATEGORY_08 §8.1)

Mirrors the Kotlin-side scrapalot.collections.custom_instructions column
added in Liquibase changeset 106. The Python service reads this cached
copy when assembling the chat system prompt so it doesn't need to
gRPC-roundtrip to Kotlin for every chat message.

Kotlin → Redis Streams (`scrapalot:stream:collections`) carries the
field as `custom_instructions` in the COLLECTION_CREATED/UPDATED event
payload; redis_event_subscriber._handle_collection_updated forwards it
into upsert_collection_workspace which writes this column.

Revision ID: 065
Revises: 064
Create Date: 2026-04-29 10:00:00.000000
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '065'
down_revision: str | None = '064'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'collection_workspace_map',
        sa.Column('custom_instructions', sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('collection_workspace_map', 'custom_instructions')
