"""Initial database schema - Core tables

Revision ID: 00001
Revises:
Create Date: 2025-12-05

Creates core application tables:
- users (authentication and user management)
- workspaces (organizational containers)
- workspace_users (workspace sharing)
- collections (document groups)
- documents (file metadata)
- sessions (chat sessions)
- session_documents (many-to-many)
- messages (chat history)
- chat_conversations (legacy, kept for compatibility)
- server_settings (system configuration)
- user_settings (user preferences)
- jobs (background job tracking)
- task_progress (task progress tracking)
"""
from pathlib import Path
import sys

# Add parent directory to path for db_utils
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

# Revision identifiers
revision = '001'
down_revision = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create initial schema."""
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]

    # Schema creation for PostgreSQL only
    if is_postgres:
        # noinspection PyTypeChecker
        op.execute(text("CREATE SCHEMA IF NOT EXISTS scrapalot"))

    # Get column type helpers
    json_type = db_utils.get_json_column_type()

    # === USERS TABLE ===
    if not db_utils.table_exists("users"):
        op.create_table(
            db_utils.get_table_name("users"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_varchar_column("username", 50, unique=True, index=True, nullable=True),
            db_utils.create_varchar_column("email", 100, unique=True, index=True, nullable=True),
            db_utils.create_varchar_column("password", 255, nullable=True),
            db_utils.create_varchar_column("first_name", 100, nullable=True, index=True),
            db_utils.create_varchar_column("last_name", 100, nullable=True, index=True),
            db_utils.create_varchar_column("profile_picture", 500, nullable=True),
            db_utils.create_varchar_column("role", 20, nullable=False, server_default="user"),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=text("true" if is_postgres else "1")),
            sa.Column("is_external", sa.Boolean(), nullable=False, server_default=text("false" if is_postgres else "0")),
            sa.Column("license_agreement_consent", sa.Boolean(), nullable=False, server_default=text("false" if is_postgres else "0")),
            sa.Column("content_sharing_consent", sa.Boolean(), nullable=False, server_default=text("true" if is_postgres else "1")),
        )

    # === WORKSPACES TABLE ===
    if not db_utils.table_exists("workspaces"):
        op.create_table(
            db_utils.get_table_name("workspaces"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("user_id", foreign_key="users.id", nullable=False, index=True),
            db_utils.create_varchar_column("name", 100, nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("is_public", sa.Boolean(), nullable=False, server_default=text("false" if is_postgres else "0")),
            sa.Column("is_shared", sa.Boolean(), nullable=False, server_default=text("false" if is_postgres else "0")),
        )

    # === WORKSPACE_USERS TABLE (sharing) ===
    if not db_utils.table_exists("workspace_users"):
        op.create_table(
            db_utils.get_table_name("workspace_users"),
            db_utils.create_uuid_column("workspace_id", primary_key=True, foreign_key="workspaces.id", on_delete="CASCADE"),
            db_utils.create_uuid_column("user_id", primary_key=True, foreign_key="users.id", on_delete="CASCADE"),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_varchar_column("permission", 20, nullable=False, server_default="read"),
        )

    # === COLLECTIONS TABLE ===
    if not db_utils.table_exists("collections"):
        op.create_table(
            db_utils.get_table_name("collections"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("workspace_id", foreign_key="workspaces.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_varchar_column("name", 100, nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            db_utils.create_varchar_column("chunking_strategy", 50, nullable=True),
            sa.Column("chunk_size", sa.Integer(), nullable=True),
            sa.Column("chunk_overlap", sa.Integer(), nullable=True),
            sa.Column("is_processing", sa.Boolean(), nullable=False, server_default=text("false" if is_postgres else "0")),
            sa.Column("processing_error", sa.Text(), nullable=True),
        )

    # === DOCUMENTS TABLE ===
    if not db_utils.table_exists("documents"):
        op.create_table(
            db_utils.get_table_name("documents"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("collection_id", foreign_key="collections.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_varchar_column("title", 255, nullable=False, index=True),
            db_utils.create_varchar_column("filename", 255, nullable=False, index=True),
            db_utils.create_varchar_column("file_path", 500, nullable=False),
            sa.Column("file_size", sa.BigInteger(), nullable=True),
            db_utils.create_varchar_column("file_type", 50, nullable=True, index=True),
            sa.Column("content", sa.Text(), nullable=True),
            sa.Column("page_count", sa.Integer(), nullable=True),
            sa.Column("word_count", sa.Integer(), nullable=True),
            db_utils.create_varchar_column("processing_status", 20, nullable=False, server_default="pending"),
            sa.Column("processing_error", sa.Text(), nullable=True),
            sa.Column("processing_progress", sa.Float(), nullable=False, server_default="0.0"),
            sa.Column("file_metadata", json_type, nullable=True),
            sa.Column("extracted_metadata", json_type, nullable=True),
            db_utils.create_varchar_column("celery_task_id", 100, nullable=True),
        )

    # === SESSIONS TABLE (chat sessions) ===
    if not db_utils.table_exists("sessions"):
        op.create_table(
            db_utils.get_table_name("sessions"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("user_id", foreign_key="users.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_uuid_column("collection_id", foreign_key="collections.id", on_delete="CASCADE", nullable=True, index=True),
            db_utils.create_varchar_column("conversation_name", 255, nullable=True),
            sa.Column("conversation_summary", sa.Text(), nullable=True),
            db_utils.create_varchar_column("last_model_used", 255, nullable=True),
        )

    # === SESSION_DOCUMENTS TABLE (many-to-many) ===
    if not db_utils.table_exists("session_documents"):
        op.create_table(
            db_utils.get_table_name("session_documents"),
            db_utils.create_uuid_column("session_id", primary_key=True, foreign_key="sessions.id", on_delete="CASCADE"),
            db_utils.create_uuid_column("document_id", primary_key=True, foreign_key="documents.id", on_delete="CASCADE"),
        )

    # === MESSAGES TABLE ===
    if not db_utils.table_exists("messages"):
        op.create_table(
            db_utils.get_table_name("messages"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            # Note: messages table doesn't have updated_at
            db_utils.create_uuid_column("session_id", foreign_key="sessions.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_varchar_column("sender", 50, nullable=False),
            db_utils.create_varchar_column("role", 10, nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("citations", json_type, nullable=True),
            sa.Column("metadata", json_type, nullable=True),
        )

    # === CHAT_CONVERSATIONS TABLE (legacy) ===
    if not db_utils.table_exists("chat_conversations"):
        op.create_table(
            db_utils.get_table_name("chat_conversations"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("workspace_id", foreign_key="workspaces.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_varchar_column("name", 100, nullable=False),
            sa.Column("summary", sa.Text(), nullable=True),
            sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=text("false" if is_postgres else "0")),
        )

    # === SERVER_SETTINGS TABLE ===
    if not db_utils.table_exists("server_settings"):
        op.create_table(
            db_utils.get_table_name("server_settings"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_varchar_column("setting_key", 100, nullable=False, unique=True, index=True),
            sa.Column("setting_value", json_type, nullable=True),
        )

    # === USER_SETTINGS TABLE ===
    if not db_utils.table_exists("user_settings"):
        op.create_table(
            db_utils.get_table_name("user_settings"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("user_id", foreign_key="users.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_varchar_column("setting_key", 100, nullable=False, index=True),
            sa.Column("setting_value", json_type, nullable=True),
        )

    # === JOBS TABLE ===
    if not db_utils.table_exists("jobs"):
        op.create_table(
            db_utils.get_table_name("jobs"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("collection_id", foreign_key="collections.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_varchar_column("job_id", 100, nullable=False, unique=True, index=True),
            db_utils.create_varchar_column("job_type", 50, nullable=False),
            db_utils.create_varchar_column("status", 20, nullable=False, server_default="pending"),
            sa.Column("progress", sa.Float(), nullable=False, server_default="0.0"),
            sa.Column("result", json_type, nullable=True),
            sa.Column("error", sa.Text(), nullable=True),
        )

    # === TASK_PROGRESS TABLE ===
    if not db_utils.table_exists("task_progress"):
        op.create_table(
            db_utils.get_table_name("task_progress"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_varchar_column("task_id", 255, nullable=False, unique=True, index=True),
            db_utils.create_varchar_column("task_type", 100, nullable=False),
            db_utils.create_varchar_column("status", 50, nullable=False),
            sa.Column("progress_percentage", sa.Float(), nullable=False, server_default="0.0"),
            sa.Column("total_items", sa.Integer(), nullable=True),
            sa.Column("processed_items", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("current_item", sa.Text(), nullable=True),
            sa.Column("result_data", json_type, nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    """Drop all tables created in this migration."""
    table_names = [
        "task_progress",
        "jobs",
        "user_settings",
        "server_settings",
        "chat_conversations",
        "messages",
        "session_documents",
        "sessions",
        "documents",
        "collections",
        "workspace_users",
        "workspaces",
        "users",
    ]

    for table_name in table_names:
        if db_utils.table_exists(table_name):
            op.drop_table(db_utils.get_table_name(table_name))
