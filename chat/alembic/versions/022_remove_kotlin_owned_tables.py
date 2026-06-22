"""Remove Kotlin-owned tables from Python DB.

Revision ID: 022
Revises: 021
Create Date: 2026-02-20

Kotlin backend is the owner of workspaces, collections, sessions, messages,
notes, note_shares, note_versions, note_comments, session_documents, and
chat_conversations. Python only needs lightweight replacements:
- yjs_collaboration_state: Y.js CRDT state (from notes.yjs_state)
- conversation_summaries: Session summaries (from sessions.conversation_summary)
- collection_workspace_map: Collection/workspace metadata cache

This migration:
1. Creates 3 new Python-only tables
2. Migrates data from old tables to new ones
3. Drops all 19 FK constraints referencing dropped tables
4. Drops 10 Kotlin-owned tables (children first)
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

revision: str = '022'
down_revision: str | None = '021'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# All FK constraints to drop (constraint_name, table_name)
# Names verified against pg_constraint in the live database
FK_CONSTRAINTS = [
    # session_documents FKs
    ("fk_session_documents_session_id_sessions", "session_documents"),
    ("fk_session_documents_document_id_documents", "session_documents"),
    # note_shares FKs
    ("fk_note_shares_note_id_notes", "note_shares"),
    ("fk_note_shares_workspace_id_workspaces", "note_shares"),
    # note_versions FK
    ("fk_note_versions_note_id_notes", "note_versions"),
    # note_comments FKs
    ("fk_note_comments_note_id_notes", "note_comments"),
    ("fk_note_comments_parent_comment_id_note_comments", "note_comments"),
    # notes FKs
    ("fk_notes_workspace_id_workspaces", "notes"),
    ("fk_notes_session_id", "notes"),
    # messages FK
    ("fk_messages_session_id_sessions", "messages"),
    # research_plans FKs (table kept, FKs dropped)
    ("research_plans_session_id_fkey", "research_plans"),
    ("research_plans_message_id_fkey", "research_plans"),
    # collections FK
    ("fk_collections_workspace_id_workspaces", "collections"),
    # documents FK to collections
    ("fk_documents_collection_id_collections", "documents"),
    # sessions FK to collections
    ("fk_sessions_collection_id_collections", "sessions"),
    # chat_conversations FK
    ("fk_chat_conversations_workspace_id_workspaces", "chat_conversations"),
    # connectors FK
    ("fk_connectors_workspace_id_workspaces", "connectors"),
    # connector_credentials FK to workspaces
    ("fk_connector_credentials_workspace_id_workspaces", "connector_credentials"),
    # connector_oauth_states FK to workspaces
    ("fk_connector_oauth_states_workspace_id_workspaces", "connector_oauth_states"),
    # jobs FKs
    ("jobs_workspace_id_fkey", "jobs"),
    ("fk_jobs_collection_id_collections", "jobs"),
]

# Tables to drop (children first, then parents)
TABLES_TO_DROP = [
    "note_comments",
    "note_versions",
    "note_shares",
    "session_documents",
    "messages",
    "chat_conversations",
    "notes",
    "sessions",
    "collections",
    "workspaces",
]


# noinspection PyTypeChecker
def upgrade() -> None:
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]

    if not is_postgres:
        return

    conn = op.get_bind()

    # Step 1: Create new Python-only tables
    op.create_table(
        "yjs_collaboration_state",
        sa.Column("note_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("yjs_state", sa.LargeBinary(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("note_id"),
    )

    op.create_table(
        "conversation_summaries",
        sa.Column("session_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("session_id"),
    )

    op.create_table(
        "collection_workspace_map",
        sa.Column("collection_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("workspace_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("owner_user_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("collection_name", sa.String(255), nullable=True),
        sa.Column("workspace_name", sa.String(255), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("collection_id"),
    )
    op.create_index("ix_cwm_workspace", "collection_workspace_map", ["workspace_id"])
    op.create_index("ix_cwm_owner", "collection_workspace_map", ["owner_user_id"])

    # Step 2: Migrate data from old tables to new ones
    # Y.js state from notes
    if db_utils.table_exists("notes"):
        conn.execute(text(
            "INSERT INTO yjs_collaboration_state (note_id, yjs_state, updated_at) "
            "SELECT id, yjs_state, COALESCE(updated_at, NOW()) FROM notes "
            "WHERE yjs_state IS NOT NULL "
            "ON CONFLICT (note_id) DO NOTHING"
        ))

    # Conversation summaries from sessions
    if db_utils.table_exists("sessions"):
        conn.execute(text(
            "INSERT INTO conversation_summaries (session_id, summary, updated_at) "
            "SELECT id, conversation_summary, COALESCE(updated_at, NOW()) FROM sessions "
            "WHERE conversation_summary IS NOT NULL "
            "ON CONFLICT (session_id) DO NOTHING"
        ))

    # Collection-workspace mapping from collections + workspaces
    if db_utils.table_exists("collections") and db_utils.table_exists("workspaces"):
        conn.execute(text(
            "INSERT INTO collection_workspace_map "
            "(collection_id, workspace_id, owner_user_id, collection_name, workspace_name, updated_at) "
            "SELECT c.id, c.workspace_id, w.user_id, c.name, w.name, NOW() "
            "FROM collections c "
            "JOIN workspaces w ON c.workspace_id = w.id "
            "ON CONFLICT (collection_id) DO NOTHING"
        ))

    # Step 3: Drop FK constraints (keep columns as plain UUID where table is retained)
    for constraint_name, table_name in FK_CONSTRAINTS:
        if db_utils.table_exists(table_name):
            result = conn.execute(text(
                "SELECT 1 FROM pg_constraint WHERE conname = :name"
            ), {"name": constraint_name})
            if result.fetchone():
                op.drop_constraint(constraint_name, table_name, type_="foreignkey")

    # Step 4: Drop RLS policies referencing dropped tables
    rls_policies_to_drop = [
        ("workspace_owner_access", "collections"),
        ("workspace_owner_write", "collections"),
    ]
    for policy_name, table_name in rls_policies_to_drop:
        result = conn.execute(text(
            "SELECT 1 FROM pg_policy WHERE polname = :name"
        ), {"name": policy_name})
        if result.fetchone():
            conn.execute(text(f'DROP POLICY "{policy_name}" ON {table_name}'))

    # Step 5: Drop Kotlin-owned tables (children first) with CASCADE to handle
    # any remaining FK references whose constraint names differ from the predefined list.
    for table_name in TABLES_TO_DROP:
        if db_utils.table_exists(table_name):
            conn.execute(text(f"DROP TABLE IF EXISTS {table_name} CASCADE"))


# noinspection PyTypeChecker
def downgrade() -> None:
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]

    if not is_postgres:
        return

    # Recreate workspaces
    op.create_table(
        "workspaces",
        sa.Column("id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("user_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("is_public", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("is_shared", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
    )

    # Recreate collections
    op.create_table(
        "collections",
        sa.Column("id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("workspace_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("chunking_strategy", sa.String(50), nullable=True),
        sa.Column("chunk_size", sa.Integer(), nullable=True),
        sa.Column("chunk_overlap", sa.Integer(), nullable=True),
        sa.Column("is_processing", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("processing_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"],
                                name="fk_collections_workspace_id_workspaces", ondelete="CASCADE"),
    )

    # Recreate sessions
    op.create_table(
        "sessions",
        sa.Column("id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("user_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("collection_id", sa.dialects.postgresql.UUID(), nullable=True),
        sa.Column("conversation_name", sa.String(255), nullable=True),
        sa.Column("conversation_summary", sa.Text(), nullable=True),
        sa.Column("last_model_used", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["collection_id"], ["collections.id"],
                                name="fk_sessions_collection_id_collections", ondelete="CASCADE"),
    )

    # Recreate messages
    op.create_table(
        "messages",
        sa.Column("id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("session_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("sender", sa.String(50), nullable=False),
        sa.Column("role", sa.String(10), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("message_metadata", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"],
                                name="fk_messages_session_id_sessions", ondelete="CASCADE"),
    )

    # Recreate notes
    op.create_table(
        "notes",
        sa.Column("id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("title", sa.String(500), nullable=True),
        sa.Column("content", sa.JSON(), nullable=False),
        sa.Column("content_text", sa.Text(), nullable=True),
        sa.Column("yjs_state", sa.LargeBinary(), nullable=True),
        sa.Column("workspace_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("session_id", sa.dialects.postgresql.UUID(), nullable=True),
        sa.Column("created_by", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("last_edited_by", sa.dialects.postgresql.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"],
                                name="fk_notes_workspace_id_workspaces", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"],
                                name="fk_notes_session_id_sessions", ondelete="SET NULL"),
    )

    # Recreate chat_conversations
    op.create_table(
        "chat_conversations",
        sa.Column("id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("workspace_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"],
                                name="fk_chat_conversations_workspace_id_workspaces", ondelete="CASCADE"),
    )

    # Recreate session_documents
    op.create_table(
        "session_documents",
        sa.Column("session_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("document_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.PrimaryKeyConstraint("session_id", "document_id"),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"],
                                name="fk_session_documents_session_id_sessions", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["document_id"], ["documents.id"],
                                name="fk_session_documents_document_id_documents", ondelete="CASCADE"),
    )

    # Recreate note_shares
    op.create_table(
        "note_shares",
        sa.Column("id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("note_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("workspace_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("user_id", sa.dialects.postgresql.UUID(), nullable=True),
        sa.Column("shared_by", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("shared_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["note_id"], ["notes.id"],
                                name="fk_note_shares_note_id_notes", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"],
                                name="fk_note_shares_workspace_id_workspaces", ondelete="CASCADE"),
    )

    # Recreate note_versions
    op.create_table(
        "note_versions",
        sa.Column("id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("note_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("created_by", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("content", sa.JSON(), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("change_summary", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["note_id"], ["notes.id"],
                                name="fk_note_versions_note_id_notes", ondelete="CASCADE"),
    )

    # Recreate note_comments
    op.create_table(
        "note_comments",
        sa.Column("id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("note_id", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("parent_comment_id", sa.dialects.postgresql.UUID(), nullable=True),
        sa.Column("created_by", sa.dialects.postgresql.UUID(), nullable=False),
        sa.Column("resolved_by", sa.dialects.postgresql.UUID(), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("position", sa.JSON(), nullable=True),
        sa.Column("is_resolved", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["note_id"], ["notes.id"],
                                name="fk_note_comments_note_id_notes", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["parent_comment_id"], ["note_comments.id"],
                                name="fk_note_comments_parent_comment_id_note_comments", ondelete="CASCADE"),
    )

    # Re-add FK constraints on kept tables (use original names from pg_constraint)
    op.create_foreign_key("research_plans_session_id_fkey", "research_plans", "sessions", ["session_id"], ["id"])
    op.create_foreign_key("research_plans_message_id_fkey", "research_plans", "messages", ["message_id"], ["id"])
    op.create_foreign_key("fk_documents_collection_id_collections", "documents", "collections", ["collection_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("fk_sessions_collection_id_collections", "sessions", "collections", ["collection_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("fk_connectors_workspace_id_workspaces", "connectors", "workspaces", ["workspace_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("fk_connector_credentials_workspace_id_workspaces", "connector_credentials", "workspaces", ["workspace_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("fk_connector_oauth_states_workspace_id_workspaces", "connector_oauth_states", "workspaces", ["workspace_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("jobs_workspace_id_fkey", "jobs", "workspaces", ["workspace_id"], ["id"])
    op.create_foreign_key("fk_jobs_collection_id_collections", "jobs", "collections", ["collection_id"], ["id"])

    # Drop new tables
    op.drop_index("ix_cwm_owner", "collection_workspace_map")
    op.drop_index("ix_cwm_workspace", "collection_workspace_map")
    op.drop_table("collection_workspace_map")
    op.drop_table("conversation_summaries")
    op.drop_table("yjs_collaboration_state")
