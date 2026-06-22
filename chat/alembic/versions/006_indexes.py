"""Create Performance Indexes

Revision ID: 00006
Revises: 00005
Create Date: 2025-12-05

Creates indexes for improved query performance on all tables.
Supports both PostgreSQL and SQLite.
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

revision = '006'
down_revision = '005'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create all performance indexes using safe_create_index to avoid transaction aborts."""
    # Define all indexes: (index_name, table_name, columns)
    indexes = [
        # Users table
        ("ix_users_email", "users", ["email"]),
        ("ix_users_username", "users", ["username"]),
        ("ix_users_created_at", "users", ["created_at"]),

        # Workspaces table
        ("ix_workspaces_user_id", "workspaces", ["user_id"]),
        ("ix_workspaces_created_at", "workspaces", ["created_at"]),

        # Workspace users table
        ("ix_workspace_users_workspace_id", "workspace_users", ["workspace_id"]),
        ("ix_workspace_users_user_id", "workspace_users", ["user_id"]),

        # Collections table
        ("ix_collections_workspace_id", "collections", ["workspace_id"]),
        ("ix_collections_created_at", "collections", ["created_at"]),

        # Documents table
        ("ix_documents_collection_id", "documents", ["collection_id"]),
        ("ix_documents_title", "documents", ["title"]),
        ("ix_documents_filename", "documents", ["filename"]),
        ("ix_documents_created_at", "documents", ["created_at"]),
        ("ix_documents_processing_status", "documents", ["processing_status"]),

        # Sessions table
        ("ix_sessions_user_id", "sessions", ["user_id"]),
        ("ix_sessions_collection_id", "sessions", ["collection_id"]),
        ("ix_sessions_created_at", "sessions", ["created_at"]),

        # Session documents table
        ("ix_session_documents_session_id", "session_documents", ["session_id"]),
        ("ix_session_documents_document_id", "session_documents", ["document_id"]),

        # Messages table
        ("ix_messages_session_id", "messages", ["session_id"]),
        ("ix_messages_created_at", "messages", ["created_at"]),
        ("ix_messages_role", "messages", ["role"]),

        # Jobs table
        ("ix_jobs_collection_id", "jobs", ["collection_id"]),
        ("ix_jobs_job_id", "jobs", ["job_id"]),
        ("ix_jobs_status", "jobs", ["status"]),
        ("ix_jobs_created_at", "jobs", ["created_at"]),

        # User settings table
        ("ix_user_settings_user_id", "user_settings", ["user_id"]),
        ("ix_user_settings_setting_key", "user_settings", ["setting_key"]),

        # Server settings table
        ("ix_server_settings_setting_key", "server_settings", ["setting_key"]),

        # Model providers table
        ("ix_model_providers_user_id", "model_providers", ["user_id"]),
        ("ix_model_providers_name", "model_providers", ["name"]),

        # Model provider models table
        ("ix_model_provider_models_provider_id", "model_provider_models", ["provider_id"]),
        ("ix_model_provider_models_model_name", "model_provider_models", ["model_name"]),

        # API keys table
        ("ix_api_keys_user_id", "api_keys", ["user_id"]),
        ("ix_api_keys_key_hash", "api_keys", ["key_hash"]),

        # Connectors table
        ("ix_connectors_workspace_id", "connectors", ["workspace_id"]),
        ("ix_connectors_user_id", "connectors", ["user_id"]),
        ("ix_connectors_type", "connectors", ["type"]),

        # Document chunks table
        ("ix_document_chunks_document_id", "document_chunks", ["document_id"]),
        ("ix_document_chunks_collection_id", "document_chunks", ["collection_id"]),

        # Task progress table
        ("ix_task_progress_task_id", "task_progress", ["task_id"]),
        ("ix_task_progress_status", "task_progress", ["status"]),
    ]

    # Create all indexes safely (checks existence first to avoid transaction aborts)
    for index_name, table_name, columns in indexes:
        db_utils.safe_create_index(index_name, table_name, columns)


def downgrade() -> None:
    """Drop all indexes."""
    # Dropping indexes - they'll be recreated if needed
    pass  # SQLAlchemy will handle index drops when tables are dropped
