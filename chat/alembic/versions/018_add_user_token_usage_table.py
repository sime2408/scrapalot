"""Add user_token_usage table for tracking monthly token usage

Revision ID: 018
Revises: 017
Create Date: 2026-01-25

Adds the user_token_usage table to track token usage per user per billing period.
This table is used for quota enforcement and usage statistics.
"""
import sys
from pathlib import Path

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from typing import Union
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
# noinspection PyUnresolvedReferences
import db_utils


revision: str = '018'
down_revision: str | None = '017'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]
    uuid_type = db_utils.get_uuid_column_type()

    # Create the user_token_usage table if it doesn't exist
    if not db_utils.table_exists("user_token_usage"):
        op.create_table(
            "user_token_usage",
            sa.Column("id", uuid_type, primary_key=True, nullable=False),
            sa.Column("user_id", uuid_type, nullable=False),
            sa.Column("billing_period_start", sa.DateTime(timezone=True), nullable=False),
            sa.Column("billing_period_end", sa.DateTime(timezone=True), nullable=False),
            sa.Column("total_input_tokens", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("total_output_tokens", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("total_tokens", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("total_cost_usd", sa.Numeric(10, 6), nullable=False, server_default="0"),
            sa.Column("request_count", sa.Integer(), nullable=False, server_default="0"),
        )

        # Create indexes for efficient lookups
        db_utils.safe_create_index(
            "ix_user_token_usage_user_id_period",
            "user_token_usage",
            ["user_id", "billing_period_start"]
        )

        # Create a foreign key to the users table
        if is_postgres:
            op.create_foreign_key(
                "user_token_usage_user_id_fkey",
                "user_token_usage",
                "users",
                ["user_id"],
                ["id"],
                ondelete="CASCADE"
            )

        # Create unique constraint on user_id + billing_period_start
        # (one record per user per billing period)
        if is_postgres:
            op.create_unique_constraint(
                "uq_user_token_usage_user_period",
                "user_token_usage",
                ["user_id", "billing_period_start"]
            )


def downgrade() -> None:
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]

    # Drop unique constraint first
    if is_postgres:
        # noinspection PyBroadException
        try:
            op.drop_constraint("uq_user_token_usage_user_period", "user_token_usage", type_="unique")
        except Exception:
            pass

    # Drop foreign key
    if is_postgres:
        # noinspection PyBroadException
        try:
            op.drop_constraint("user_token_usage_user_id_fkey", "user_token_usage", type_="foreignkey")
        except Exception:
            pass

    # Drop table
    if db_utils.table_exists("user_token_usage"):
        op.drop_table("user_token_usage")
