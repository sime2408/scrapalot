"""add_stripe_webhook_events_table

Revision ID: 013
Revises: 012
Create Date: 2026-01-01 10:03:58.134562

"""
from pathlib import Path
import sys
from typing import Union
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# Add parent directory to path to import db_utils
sys.path.append(str(Path(__file__).parent))
# noinspection PyUnresolvedReferences
import db_utils

# revision identifiers, used by Alembic.
revision: str = '013'
down_revision: str | None = '012'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create stripe_webhook_events table for tracking Stripe webhook events."""
    # Create stripe_webhook_events table
    op.create_table(
        'stripe_webhook_events',
        db_utils.create_uuid_column('id', primary_key=True),
        sa.Column('stripe_event_id', sa.String(100), nullable=False, unique=True),
        sa.Column('event_type', sa.String(100), nullable=False),
        sa.Column('event_data', sa.JSON, nullable=False),
        sa.Column('processed', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('processing_error', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    # Create indexes for better query performance
    op.create_index(
        'ix_stripe_webhook_events_stripe_id',
        'stripe_webhook_events',
        ['stripe_event_id']
    )
    op.create_index(
        'ix_stripe_webhook_events_processed',
        'stripe_webhook_events',
        ['processed']
    )
    op.create_index(
        'ix_stripe_webhook_events_event_type',
        'stripe_webhook_events',
        ['event_type']
    )


def downgrade() -> None:
    """Drop stripe_webhook_events table and its indexes."""
    # Drop indexes
    op.drop_index('ix_stripe_webhook_events_event_type', table_name='stripe_webhook_events')
    op.drop_index('ix_stripe_webhook_events_processed', table_name='stripe_webhook_events')
    op.drop_index('ix_stripe_webhook_events_stripe_id', table_name='stripe_webhook_events')

    # Drop table
    op.drop_table('stripe_webhook_events')
