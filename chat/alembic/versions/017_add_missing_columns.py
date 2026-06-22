"""Add missing columns to jobs, subscription_plans, and workspace_users

Revision ID: 017
Revises: 016
Create Date: 2026-01-25

Adds columns that exist in SQLModel definitions but were missing from migrations:
- jobs: job_name, description, error_message, metadata, started_at, completed_at,
        memory_usage_mb, cpu_time_seconds, user_id, workspace_id, document_id
- subscription_plans: display_name, price_annual, documents_limit, tokens_limit,
                      stripe_price_id_monthly, stripe_price_id_annual, sort_order
- workspace_users: role (alias for permission for backward compatibility)
"""
from pathlib import Path
import sys

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from typing import Union
from collections.abc import Sequence
# noinspection PyUnresolvedReferences
import sqlalchemy as sa
from sqlalchemy import text

from alembic import op

revision: str = '017'
down_revision: str | None = '016'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# noinspection PyTypeChecker
def upgrade() -> None:
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]
    json_type = db_utils.get_json_column_type()
    conn = op.get_bind()

    # =========================================================================
    # JOBS TABLE - Add missing columns
    # =========================================================================
    if db_utils.table_exists("jobs"):
        # job_name
        if not db_utils.column_exists("jobs", "job_name"):
            op.add_column("jobs", sa.Column("job_name", sa.String(200), nullable=True))

        # description
        if not db_utils.column_exists("jobs", "description"):
            op.add_column("jobs", sa.Column("description", sa.Text(), nullable=True))

        # error_message
        if not db_utils.column_exists("jobs", "error_message"):
            op.add_column("jobs", sa.Column("error_message", sa.Text(), nullable=True))

        # metadata (for job_metadata field)
        if not db_utils.column_exists("jobs", "metadata"):
            op.add_column("jobs", sa.Column("metadata", json_type, nullable=True))

        # started_at
        if not db_utils.column_exists("jobs", "started_at"):
            op.add_column("jobs", sa.Column("started_at", sa.String(50), nullable=True))

        # completed_at
        if not db_utils.column_exists("jobs", "completed_at"):
            op.add_column("jobs", sa.Column("completed_at", sa.String(50), nullable=True))

        # memory_usage_mb
        if not db_utils.column_exists("jobs", "memory_usage_mb"):
            op.add_column("jobs", sa.Column("memory_usage_mb", sa.Integer(), nullable=True))

        # cpu_time_seconds
        if not db_utils.column_exists("jobs", "cpu_time_seconds"):
            op.add_column("jobs", sa.Column("cpu_time_seconds", sa.Float(), nullable=True))

        # user_id
        if not db_utils.column_exists("jobs", "user_id"):
            uuid_type = db_utils.get_uuid_column_type()
            op.add_column("jobs", sa.Column("user_id", uuid_type, nullable=True))
            # Add FK constraint
            if is_postgres:
                op.create_foreign_key("jobs_user_id_fkey", "jobs", "users", ["user_id"], ["id"])
            db_utils.safe_create_index("ix_jobs_user_id", "jobs", ["user_id"])

        # workspace_id
        if not db_utils.column_exists("jobs", "workspace_id"):
            uuid_type = db_utils.get_uuid_column_type()
            op.add_column("jobs", sa.Column("workspace_id", uuid_type, nullable=True))
            if is_postgres:
                op.create_foreign_key("jobs_workspace_id_fkey", "jobs", "workspaces", ["workspace_id"], ["id"])
            db_utils.safe_create_index("ix_jobs_workspace_id", "jobs", ["workspace_id"])

        # document_id
        if not db_utils.column_exists("jobs", "document_id"):
            uuid_type = db_utils.get_uuid_column_type()
            op.add_column("jobs", sa.Column("document_id", uuid_type, nullable=True))
            if is_postgres:
                op.create_foreign_key("jobs_document_id_fkey", "jobs", "documents", ["document_id"], ["id"])
            db_utils.safe_create_index("ix_jobs_document_id", "jobs", ["document_id"])

    # =========================================================================
    # SUBSCRIPTION_PLANS TABLE - Add missing columns
    # =========================================================================
    if db_utils.table_exists("subscription_plans"):
        # display_name
        if not db_utils.column_exists("subscription_plans", "display_name"):
            op.add_column("subscription_plans", sa.Column("display_name", sa.String(100), nullable=True))
            # Copy name to display_name for existing rows
            conn.execute(text("UPDATE subscription_plans SET display_name = name WHERE display_name IS NULL"))

        # price_annual (rename price_yearly if exists, or add new)
        if not db_utils.column_exists("subscription_plans", "price_annual"):
            if db_utils.column_exists("subscription_plans", "price_yearly"):
                # Rename price_yearly to price_annual
                op.alter_column("subscription_plans", "price_yearly", new_column_name="price_annual")
            else:
                op.add_column("subscription_plans", sa.Column("price_annual", sa.Numeric(10, 2), nullable=True, server_default="0"))

        # documents_limit
        if not db_utils.column_exists("subscription_plans", "documents_limit"):
            op.add_column("subscription_plans", sa.Column("documents_limit", sa.Integer(), nullable=True))

        # tokens_limit
        if not db_utils.column_exists("subscription_plans", "tokens_limit"):
            op.add_column("subscription_plans", sa.Column("tokens_limit", sa.BigInteger(), nullable=True))

        # stripe_price_id_monthly
        if not db_utils.column_exists("subscription_plans", "stripe_price_id_monthly"):
            op.add_column("subscription_plans", sa.Column("stripe_price_id_monthly", sa.String(100), nullable=True))

        # stripe_price_id_annual
        if not db_utils.column_exists("subscription_plans", "stripe_price_id_annual"):
            op.add_column("subscription_plans", sa.Column("stripe_price_id_annual", sa.String(100), nullable=True))

        # sort_order
        if not db_utils.column_exists("subscription_plans", "sort_order"):
            op.add_column("subscription_plans", sa.Column("sort_order", sa.Integer(), nullable=True))

    # =========================================================================
    # WORKSPACE_USERS TABLE - Add role column (alias for permission)
    # =========================================================================
    if db_utils.table_exists("workspace_users"):
        # Add role column if it doesn't exist (some queries use 'role' instead of 'permission')
        if not db_utils.column_exists("workspace_users", "role"):
            op.add_column("workspace_users", sa.Column("role", sa.String(20), nullable=True))
            # Copy permission to role
            conn.execute(text("UPDATE workspace_users SET role = permission WHERE role IS NULL"))


def downgrade() -> None:
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]

    # Remove workspace_users.role
    if db_utils.table_exists("workspace_users"):
        if db_utils.column_exists("workspace_users", "role"):
            op.drop_column("workspace_users", "role")

    # Remove subscription_plans columns
    if db_utils.table_exists("subscription_plans"):
        for col in ["sort_order", "stripe_price_id_annual", "stripe_price_id_monthly",
                    "tokens_limit", "documents_limit", "display_name"]:
            if db_utils.column_exists("subscription_plans", col):
                op.drop_column("subscription_plans", col)
        # Rename price_annual back to price_yearly
        if db_utils.column_exists("subscription_plans", "price_annual"):
            op.alter_column("subscription_plans", "price_annual", new_column_name="price_yearly")

    # Remove jobs columns
    if db_utils.table_exists("jobs"):
        # Drop FKs first if postgres
        if is_postgres:
            # noinspection PyBroadException
            try:
                op.drop_constraint("jobs_document_id_fkey", "jobs", type_="foreignkey")
            except Exception:
                pass
            # noinspection PyBroadException
            try:
                op.drop_constraint("jobs_workspace_id_fkey", "jobs", type_="foreignkey")
            except Exception:
                pass
            # noinspection PyBroadException
            try:
                op.drop_constraint("jobs_user_id_fkey", "jobs", type_="foreignkey")
            except Exception:
                pass

        for col in ["document_id", "workspace_id", "user_id", "cpu_time_seconds",
                    "memory_usage_mb", "completed_at", "started_at", "metadata",
                    "error_message", "description", "job_name"]:
            if db_utils.column_exists("jobs", col):
                op.drop_column("jobs", col)
