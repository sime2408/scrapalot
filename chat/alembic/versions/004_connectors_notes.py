"""External Connectors and Notes/Collaboration

Revision ID: 00004
Revises: 00003
Create Date: 2025-12-05

Creates connector and collaboration tables:
- connectors (external data source connections: Dropbox, Google Drive, etc.)
- connector_credentials (OAuth and API credentials)
- connector_oauth_states (OAuth flow state tracking)
- connector_sync_destinations (sync targets)
- connector_sync_jobs (sync job tracking)
- connector_file_syncs (synced file metadata)
- notes (collaborative notes)
- note_versions (note history)
- note_shares (note sharing)
- note_comments (note comments)
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

revision = '004'
down_revision = '003'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create connector and collaboration tables."""
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]
    json_type = db_utils.get_json_column_type()

    # === CONNECTORS TABLE ===
    if not db_utils.table_exists("connectors"):
        op.create_table(
            db_utils.get_table_name("connectors"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("workspace_id", foreign_key="workspaces.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_uuid_column("user_id", foreign_key="users.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_varchar_column("name", 200, nullable=False),
            db_utils.create_varchar_column("type", 50, nullable=False),  # dropbox, gdrive, onedrive, etc.
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=text("true" if is_postgres else "1")),
            sa.Column("config", json_type, nullable=True),
            sa.Column("last_sync_at", sa.DateTime(timezone=True), nullable=True),
            db_utils.create_varchar_column("sync_status", 50, nullable=True),
            sa.Column("sync_error", sa.Text(), nullable=True),
        )

    # === CONNECTOR_CREDENTIALS TABLE ===
    if not db_utils.table_exists("connector_credentials"):
        op.create_table(
            db_utils.get_table_name("connector_credentials"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("connector_id", foreign_key="connectors.id", on_delete="CASCADE", nullable=False, unique=True, index=True),
            db_utils.create_varchar_column("credential_type", 50, nullable=False),  # oauth, api_key, etc.
            sa.Column("encrypted_credentials", sa.Text(), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        )

    # === CONNECTOR_OAUTH_STATES TABLE (for OAuth flow) ===
    if not db_utils.table_exists("connector_oauth_states"):
        op.create_table(
            db_utils.get_table_name("connector_oauth_states"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_varchar_column("state", 255, nullable=False, unique=True, index=True),
            db_utils.create_uuid_column("user_id", foreign_key="users.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_uuid_column("workspace_id", foreign_key="workspaces.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_varchar_column("connector_type", 50, nullable=False),
            db_utils.create_varchar_column("connector_name", 200, nullable=True),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("oauth_credentials", json_type, nullable=True),
        )

    # === CONNECTOR_SYNC_DESTINATIONS TABLE ===
    if not db_utils.table_exists("connector_sync_destinations"):
        op.create_table(
            db_utils.get_table_name("connector_sync_destinations"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("connector_id", foreign_key="connectors.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_uuid_column("collection_id", foreign_key="collections.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_varchar_column("source_path", 500, nullable=True),
            sa.Column("sync_options", json_type, nullable=True),
        )

    # === CONNECTOR_SYNC_JOBS TABLE ===
    if not db_utils.table_exists("connector_sync_jobs"):
        op.create_table(
            db_utils.get_table_name("connector_sync_jobs"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("connector_id", foreign_key="connectors.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_varchar_column("status", 50, nullable=False),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("files_synced", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("files_failed", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("error_message", sa.Text(), nullable=True),
        )

    # === CONNECTOR_FILE_SYNCS TABLE ===
    if not db_utils.table_exists("connector_file_syncs"):
        op.create_table(
            db_utils.get_table_name("connector_file_syncs"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("connector_id", foreign_key="connectors.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_uuid_column("document_id", foreign_key="documents.id", on_delete="SET NULL", nullable=True, index=True),
            db_utils.create_varchar_column("source_file_id", 500, nullable=False),
            db_utils.create_varchar_column("source_file_path", 1000, nullable=False),
            db_utils.create_varchar_column("sync_status", 50, nullable=False),
            sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("file_metadata", json_type, nullable=True),
            sa.Column("sync_error", sa.Text(), nullable=True),
        )

    # === NOTES TABLE ===
    if not db_utils.table_exists("notes"):
        op.create_table(
            db_utils.get_table_name("notes"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("workspace_id", foreign_key="workspaces.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_uuid_column("user_id", foreign_key="users.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_uuid_column("session_id", foreign_key="sessions.id", on_delete="SET NULL", nullable=True, index=True),
            db_utils.create_varchar_column("title", 255, nullable=False),
            sa.Column("content", sa.Text(), nullable=True),
            db_utils.create_varchar_column("note_type", 50, nullable=False, server_default="markdown"),
            sa.Column("tags", json_type, nullable=True),
            sa.Column("is_public", sa.Boolean(), nullable=False, server_default=text("false" if is_postgres else "0")),
            sa.Column("is_pinned", sa.Boolean(), nullable=False, server_default=text("false" if is_postgres else "0")),
        )

    # === NOTE_VERSIONS TABLE ===
    if not db_utils.table_exists("note_versions"):
        op.create_table(
            db_utils.get_table_name("note_versions"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_uuid_column("note_id", foreign_key="notes.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_uuid_column("user_id", foreign_key="users.id", on_delete="CASCADE", nullable=False, index=True),
            sa.Column("version_number", sa.Integer(), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("change_summary", sa.Text(), nullable=True),
        )

    # === NOTE_SHARES TABLE ===
    if not db_utils.table_exists("note_shares"):
        op.create_table(
            db_utils.get_table_name("note_shares"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("note_id", foreign_key="notes.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_uuid_column("user_id", foreign_key="users.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_varchar_column("permission", 20, nullable=False, server_default="read"),
        )

    # === NOTE_COMMENTS TABLE ===
    if not db_utils.table_exists("note_comments"):
        op.create_table(
            db_utils.get_table_name("note_comments"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("note_id", foreign_key="notes.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_uuid_column("user_id", foreign_key="users.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_uuid_column("parent_comment_id", foreign_key="note_comments.id", on_delete="CASCADE", nullable=True, index=True),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("is_resolved", sa.Boolean(), nullable=False, server_default=text("false" if is_postgres else "0")),
        )


def downgrade() -> None:
    """Drop connector and collaboration tables."""
    tables = [
        "note_comments",
        "note_shares",
        "note_versions",
        "notes",
        "connector_file_syncs",
        "connector_sync_jobs",
        "connector_sync_destinations",
        "connector_oauth_states",
        "connector_credentials",
        "connectors",
    ]

    for table in tables:
        if db_utils.table_exists(table):
            op.drop_table(db_utils.get_table_name(table))
