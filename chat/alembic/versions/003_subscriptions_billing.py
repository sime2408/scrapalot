"""Subscriptions, Billing, and API Keys

Revision ID: 00003
Revises: 00002
Create Date: 2025-12-05

Creates subscription and billing tables:
- subscription_plans (plan definitions: researcher, professional, enterprise)
- user_subscriptions (user subscription tracking)
- api_keys (programmatic API access)
"""
from pathlib import Path
import sys

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from typing import Union
from collections.abc import Sequence
# noinspection PyUnresolvedReferences
import db_utils
import sqlalchemy as sa
from sqlalchemy import text

from alembic import op

revision = '003'
down_revision = '002'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create subscription and billing tables."""
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]
    json_type = db_utils.get_json_column_type()

    # === SUBSCRIPTION_PLANS TABLE ===
    if not db_utils.table_exists("subscription_plans"):
        op.create_table(
            db_utils.get_table_name("subscription_plans"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_varchar_column("name", 100, nullable=False, unique=True, index=True),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("price_monthly", sa.Numeric(precision=10, scale=2), nullable=False),
            sa.Column("price_yearly", sa.Numeric(precision=10, scale=2), nullable=True),
            sa.Column("storage_limit_bytes", sa.BigInteger(), nullable=True),  # NULL = unlimited
            sa.Column("max_workspaces", sa.Integer(), nullable=True),  # NULL = unlimited
            sa.Column("max_collections_per_workspace", sa.Integer(), nullable=True),
            sa.Column("max_documents_per_collection", sa.Integer(), nullable=True),
            sa.Column("features", json_type, nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=text("true" if is_postgres else "1")),
            sa.Column("trial_days", sa.Integer(), nullable=False, server_default="0"),
        )

    # === USER_SUBSCRIPTIONS TABLE ===
    if not db_utils.table_exists("user_subscriptions"):
        op.create_table(
            db_utils.get_table_name("user_subscriptions"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("user_id", foreign_key="users.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_uuid_column("subscription_plan_id", foreign_key="subscription_plans.id", nullable=False, index=True),
            db_utils.create_varchar_column("status", 20, nullable=False, server_default="active"),
            db_utils.create_varchar_column("billing_cycle", 20, nullable=False, server_default="monthly"),
            db_utils.create_varchar_column("payment_method", 50, nullable=True),
            db_utils.create_varchar_column("stripe_subscription_id", 255, nullable=True),
            db_utils.create_varchar_column("stripe_customer_id", 255, nullable=True),
            sa.Column("current_period_start", sa.DateTime(timezone=True), nullable=True),
            sa.Column("current_period_end", sa.DateTime(timezone=True), nullable=True),
            sa.Column("cancel_at_period_end", sa.Boolean(), nullable=False, server_default=text("false" if is_postgres else "0")),
            sa.Column("subscribed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        )

    # === API_KEYS TABLE ===
    if not db_utils.table_exists("api_keys"):
        op.create_table(
            db_utils.get_table_name("api_keys"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("user_id", foreign_key="users.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_varchar_column("key_hash", 255, nullable=False, unique=True, index=True),
            db_utils.create_varchar_column("key_prefix", 10, nullable=False, index=True),
            db_utils.create_varchar_column("name", 100, nullable=False),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=text("true" if is_postgres else "1")),
            sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("scopes", json_type, nullable=True),
        )


def downgrade() -> None:
    """Drop subscription and billing tables."""
    tables = ["api_keys", "user_subscriptions", "subscription_plans"]
    for table in tables:
        if db_utils.table_exists(table):
            op.drop_table(db_utils.get_table_name(table))
