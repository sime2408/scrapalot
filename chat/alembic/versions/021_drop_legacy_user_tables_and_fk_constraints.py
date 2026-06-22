"""Drop legacy user tables and FK constraints from Python DB.

Revision ID: 021
Revises: 020
Create Date: 2026-02-19

User management is fully handled by Kotlin backend (scrapalot_backend DB).
Python only needs user_id as a plain UUID value for filtering queries.
This migration:
1. Drops all 17 FK constraints referencing users.id
2. Drops 6 legacy tables: workspace_users, api_keys, user_subscriptions,
   subscription_plans, user_token_usage, users
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
from sqlalchemy import text

from alembic import op

revision: str = '021'
down_revision: str | None = '020'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# All FK constraints to drop (constraint_name, table_name)
FK_CONSTRAINTS = [
    ("fk_user_settings_user_id_users", "user_settings"),
    ("fk_model_providers_user_id_users", "model_providers"),
    ("fk_workspaces_user_id_users", "workspaces"),
    ("fk_sessions_user_id_users", "sessions"),
    ("fk_jobs_user_id_users", "jobs"),
    ("fk_document_summaries_user_id_users", "document_summaries"),
    ("fk_research_templates_user_id_users", "research_templates"),
    ("fk_notes_created_by_users", "notes"),
    ("fk_notes_last_edited_by_users", "notes"),
    ("fk_note_shares_user_id_users", "note_shares"),
    ("fk_connector_credentials_user_id_users", "connector_credentials"),
    ("fk_connector_oauth_states_user_id_users", "connector_oauth_states"),
    ("fk_connectors_user_id_users", "connectors"),
    ("fk_user_token_usage_user_id_users", "user_token_usage"),
    ("fk_user_subscriptions_user_id_users", "user_subscriptions"),
    ("fk_workspace_users_user_id_users", "workspace_users"),
    ("fk_api_keys_user_id_users", "api_keys"),
]

# Tables to drop (children first, then parents)
TABLES_TO_DROP = [
    "workspace_users",
    "api_keys",
    "user_subscriptions",
    "subscription_plans",
    "user_token_usage",
    "users",
]


# noinspection PyTypeChecker
def upgrade() -> None:
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]

    if not is_postgres:
        # SQLite does not support dropping FK constraints
        return

    conn = op.get_bind()

    # Step 1: Drop FK constraints (keep user_id columns as plain UUID)
    for constraint_name, table_name in FK_CONSTRAINTS:
        if db_utils.table_exists(table_name):
            # Check if constraint exists before dropping
            result = conn.execute(text(
                "SELECT 1 FROM pg_constraint WHERE conname = :name"
            ), {"name": constraint_name})
            if result.fetchone():
                op.drop_constraint(constraint_name, table_name, type_="foreignkey")

    # Step 2: Drop RLS policies that reference workspace_users
    rls_policies_to_drop = [
        ("shared_workspace_access", "collections"),
        ("shared_workspace_write", "collections"),
    ]
    for policy_name, table_name in rls_policies_to_drop:
        result = conn.execute(text(
            "SELECT 1 FROM pg_policy WHERE polname = :name"
        ), {"name": policy_name})
        if result.fetchone():
            conn.execute(text(f'DROP POLICY "{policy_name}" ON {table_name}'))

    # Step 3: Drop legacy tables with CASCADE to handle any remaining FK references.
    # The actual constraint names in the DB may differ from the predefined names above,
    # so some FK drops may be silently skipped. CASCADE ensures the tables drop cleanly.
    for table_name in TABLES_TO_DROP:
        if db_utils.table_exists(table_name):
            conn.execute(text(f"DROP TABLE IF EXISTS {table_name} CASCADE"))


# noinspection PyTypeChecker
def downgrade() -> None:
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]

    if not is_postgres:
        return

    # Recreate users table
    op.create_table(
        "users",
        sa.Column("id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("username", sa.String(50), nullable=True),
        sa.Column("email", sa.String(100), nullable=True),
        sa.Column("password", sa.String(255), nullable=True),
        sa.Column("first_name", sa.String(100), nullable=True),
        sa.Column("last_name", sa.String(100), nullable=True),
        sa.Column("profile_picture", sa.String(500), nullable=True),
        sa.Column("role", sa.String(20), nullable=False, server_default="user"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("is_external", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("license_agreement_consent", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("content_sharing_consent", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("tour_completed", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
    )

    # Recreate other dropped tables
    op.create_table(
        "subscription_plans",
        sa.Column("id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("name", sa.String(50), nullable=False, unique=True),
        sa.Column("display_name", sa.String(100), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "user_token_usage",
        sa.Column("id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("user_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_user_token_usage_user_id_users"),
    )

    op.create_table(
        "workspace_users",
        sa.Column("workspace_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("user_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("permission", sa.String(20), nullable=False, server_default="read"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("workspace_id", "user_id"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], name="fk_workspace_users_workspace_id_workspaces", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_workspace_users_user_id_users", ondelete="CASCADE"),
    )

    op.create_table(
        "api_keys",
        sa.Column("id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("user_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("key_hash", sa.String(255), nullable=False, unique=True),
        sa.Column("key_prefix", sa.String(10), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_api_keys_user_id_users", ondelete="CASCADE"),
    )

    op.create_table(
        "user_subscriptions",
        sa.Column("id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("user_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("subscription_plan_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_user_subscriptions_user_id_users", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["subscription_plan_id"], ["subscription_plans.id"], name="fk_user_subscriptions_subscription_plan_id_subscription_plans"),
    )

    # Re-add FK constraints on kept tables
    for constraint_name, table_name in FK_CONSTRAINTS:
        if table_name not in TABLES_TO_DROP:
            op.create_foreign_key(constraint_name, table_name, "users", ["user_id"], ["id"])
