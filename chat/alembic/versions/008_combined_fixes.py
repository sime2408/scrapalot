"""Combined post-v007 migrations (00008-00018)

Revision ID: 00008_combined_post_v007
Revises: 00007
Create Date: 2025-12-10

This migration combines all changes from migrations 00008 through 00018:
- Model capabilities (supports_streaming, supports_function_calling, supports_vision)
- Document summaries table and Phase 4 settings
- Missing workspace columns (description, is_public, is_shared)
- CASCADE constraints for workspace deletion chain
- Default use_agentic_routing setting for existing users
- workspace_users.permission column
- Sync deprecated columns (role/permission, document_name/title)
- Drop deprecated document_name column
- System provider activation
- All merge migrations
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
from sqlalchemy import inspect, text

from alembic import op

revision = '008'
down_revision = '007'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def get_foreign_key_name(table_name: str, column_name: str) -> str:
    """Get the foreign key constraint name for a given table and column."""
    conn = op.get_bind()
    inspector = inspect(conn)
    dialect_info = db_utils.get_dialect_info()

    schema = dialect_info.get("schema_name") if dialect_info["is_postgresql"] else None

    # noinspection PyBroadException
    try:
        fks = inspector.get_foreign_keys(table_name, schema=schema)
        for fk in fks:
            if column_name in fk.get('constrained_columns', []):
                return fk.get('name')
    except Exception:
        pass
    return None


def check_fk_has_cascade(table_name: str, column_name: str) -> bool:
    """Check if a foreign key constraint already has ON DELETE CASCADE."""
    conn = op.get_bind()
    dialect_info = db_utils.get_dialect_info()

    if not dialect_info["is_postgresql"]:
        return True  # Skip for SQLite

    # noinspection PyBroadException
    try:
        # Query pg_constraint to check ON DELETE action
        result = conn.execute(text("""
            SELECT confdeltype
            FROM pg_constraint c
            JOIN pg_class t ON c.conrelid = t.oid
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
            WHERE t.relname = :table_name
            AND a.attname = :column_name
            AND c.contype = 'f'
        """), {"table_name": table_name, "column_name": column_name})
        row = result.fetchone()
        if row:
            # 'c' = CASCADE, 'a' = NO ACTION, 'r' = RESTRICT, 'n' = SET NULL, 'd' = SET DEFAULT
            return row[0] == 'c'
    except Exception:
        pass
    return False


# noinspection PyUnusedLocal
def recreate_fk_with_cascade(
    table_name: str,
    column_name: str,
    ref_table: str,
    ref_column: str = 'id',
    nullable: bool = False
) -> None:
    """Drop existing FK and recreate with CASCADE."""
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]

    if not is_postgres:
        # SQLite doesn't support ALTER TABLE for FK constraints
        # Foreign keys work if PRAGMA foreign_keys = ON
        return

    # Check if the column exists in the table
    if not db_utils.column_exists(table_name, column_name):
        return

    # Check if FK already has CASCADE - skip if so
    if check_fk_has_cascade(table_name, column_name):
        return

    # Find existing constraint name
    fk_name = get_foreign_key_name(table_name, column_name)
    new_fk_name = f"fk_{table_name}_{column_name}_{ref_table}"

    # Use direct SQL for atomic operation with IF EXISTS
    if fk_name:
        op.execute(text(f'ALTER TABLE "{table_name}" DROP CONSTRAINT IF EXISTS "{fk_name}"'))

    # Drop new constraint name if it exists (from previous partial migration)
    op.execute(text(f'ALTER TABLE "{table_name}" DROP CONSTRAINT IF EXISTS "{new_fk_name}"'))

    # Create new constraint with CASCADE
    op.execute(text(f'''
        ALTER TABLE "{table_name}"
        ADD CONSTRAINT "{new_fk_name}"
        FOREIGN KEY ("{column_name}")
        REFERENCES "{ref_table}" ("{ref_column}")
        ON DELETE CASCADE
    '''))


# noinspection PyTypeChecker
def upgrade() -> None:
    """Apply all combined migrations."""
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]
    connection = op.get_bind()

    print("\n" + "=" * 80)
    print("COMBINED MIGRATION 00008-00018")
    print("=" * 80)

    # ===== FROM 00008: Add model capability columns =====
    print("\n1. Adding model capability columns...")
    if db_utils.table_exists("model_provider_models"):
        table_name = db_utils.get_table_name("model_provider_models")

        if not db_utils.column_exists("model_provider_models", "supports_streaming"):
            if is_postgres:
                connection.execute(text(f"""
                    ALTER TABLE {table_name}
                    ADD COLUMN supports_streaming BOOLEAN NOT NULL DEFAULT false
                """))
            else:
                connection.execute(text(f"""
                    ALTER TABLE {table_name}
                    ADD COLUMN supports_streaming INTEGER NOT NULL DEFAULT 0
                """))
            print("   ✓ Added supports_streaming column")

        if not db_utils.column_exists("model_provider_models", "supports_function_calling"):
            if is_postgres:
                connection.execute(text(f"""
                    ALTER TABLE {table_name}
                    ADD COLUMN supports_function_calling BOOLEAN NOT NULL DEFAULT false
                """))
            else:
                connection.execute(text(f"""
                    ALTER TABLE {table_name}
                    ADD COLUMN supports_function_calling INTEGER NOT NULL DEFAULT 0
                """))
            print("   ✓ Added supports_function_calling column")

        if not db_utils.column_exists("model_provider_models", "supports_vision"):
            if is_postgres:
                connection.execute(text(f"""
                    ALTER TABLE {table_name}
                    ADD COLUMN supports_vision BOOLEAN NOT NULL DEFAULT false
                """))
            else:
                connection.execute(text(f"""
                    ALTER TABLE {table_name}
                    ADD COLUMN supports_vision INTEGER NOT NULL DEFAULT 0
                """))
            print("   ✓ Added supports_vision column")

    # ===== FROM 00009: Create document_summaries table =====
    print("\n2. Creating document_summaries table...")
    if not db_utils.table_exists("document_summaries"):
        if is_postgres:
            connection.execute(text("""
                CREATE TABLE document_summaries (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                    summary TEXT NOT NULL,
                    heading_prefixes JSONB,
                    tokens_used INTEGER DEFAULT 0,
                    generation_time_seconds FLOAT DEFAULT 0.0,
                    status VARCHAR(50) DEFAULT 'completed',
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
                )
            """))
        else:
            connection.execute(text("""
                CREATE TABLE document_summaries (
                    id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    heading_prefixes TEXT,
                    tokens_used INTEGER DEFAULT 0,
                    generation_time_seconds REAL DEFAULT 0.0,
                    status TEXT DEFAULT 'completed',
                    created_at TEXT,
                    updated_at TEXT,
                    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
                )
            """))

        table_name = db_utils.get_table_name("document_summaries")
        connection.execute(text(f"""
            CREATE INDEX idx_document_summaries_document_id
            ON {table_name} (document_id)
        """))
        connection.execute(text(f"""
            CREATE INDEX idx_document_summaries_status
            ON {table_name} (status)
        """))
        print("   ✓ Created document_summaries table with indices")

        # Add Phase 4 system settings
        if db_utils.table_exists("system_settings"):
            settings_table = db_utils.get_table_name("system_settings")
            connection.execute(text(f"""
                INSERT INTO {settings_table} (setting_name, setting_value, created_at, updated_at)
                VALUES
                ('document_summary_enabled', 'true', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                ('document_summary_max_tokens', '8000', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                ('document_summary_target_length', '500', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                ('enable_heading_prefix_generation', 'true', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                ('enable_document_context_in_rag', 'true', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT (setting_name) DO NOTHING
            """))
            print("   ✓ Added Phase 4 system settings")

    # ===== FROM 00010: Add missing workspace columns =====
    print("\n3. Adding missing workspace columns...")
    if db_utils.table_exists("workspaces"):
        if not db_utils.column_exists('workspaces', 'description'):
            op.add_column('workspaces', sa.Column('description', sa.Text(), nullable=True))
            print("   ✓ Added description column")

        if not db_utils.column_exists('workspaces', 'is_public'):
            server_default = 'false' if is_postgres else '0'
            op.add_column('workspaces', sa.Column('is_public', sa.Boolean(), nullable=False, server_default=server_default))
            print("   ✓ Added is_public column")

        if not db_utils.column_exists('workspaces', 'is_shared'):
            server_default = 'false' if is_postgres else '0'
            op.add_column('workspaces', sa.Column('is_shared', sa.Boolean(), nullable=False, server_default=server_default))
            print("   ✓ Added is_shared column")

    # ===== FROM 00012: Ensure CASCADE constraints =====
    print("\n4. Ensuring CASCADE constraints...")
    if is_postgres:
        # Workspace deletion chain
        if db_utils.table_exists("collections"):
            recreate_fk_with_cascade("collections", "workspace_id", "workspaces")
        if db_utils.table_exists("documents"):
            recreate_fk_with_cascade("documents", "collection_id", "collections")
        if db_utils.table_exists("document_chunks"):
            recreate_fk_with_cascade("document_chunks", "document_id", "documents")
            recreate_fk_with_cascade("document_chunks", "collection_id", "collections")
        if db_utils.table_exists("document_summaries"):
            recreate_fk_with_cascade("document_summaries", "document_id", "documents")

        # Sessions and messages
        if db_utils.table_exists("sessions"):
            recreate_fk_with_cascade("sessions", "collection_id", "collections", nullable=True)
            recreate_fk_with_cascade("sessions", "user_id", "users")
        if db_utils.table_exists("session_documents"):
            recreate_fk_with_cascade("session_documents", "session_id", "sessions")
            recreate_fk_with_cascade("session_documents", "document_id", "documents")
        if db_utils.table_exists("messages"):
            recreate_fk_with_cascade("messages", "session_id", "sessions")

        # Jobs
        if db_utils.table_exists("jobs"):
            recreate_fk_with_cascade("jobs", "collection_id", "collections")

        # Workspace related tables
        if db_utils.table_exists("workspace_users"):
            recreate_fk_with_cascade("workspace_users", "workspace_id", "workspaces")
            recreate_fk_with_cascade("workspace_users", "user_id", "users")
        if db_utils.table_exists("chat_conversations"):
            recreate_fk_with_cascade("chat_conversations", "workspace_id", "workspaces")

        # Notes
        if db_utils.table_exists("notes"):
            recreate_fk_with_cascade("notes", "workspace_id", "workspaces")
        if db_utils.table_exists("note_shares"):
            recreate_fk_with_cascade("note_shares", "note_id", "notes")
            recreate_fk_with_cascade("note_shares", "workspace_id", "workspaces")
        if db_utils.table_exists("note_versions"):
            recreate_fk_with_cascade("note_versions", "note_id", "notes")
        if db_utils.table_exists("note_comments"):
            recreate_fk_with_cascade("note_comments", "note_id", "notes")

        # Connectors
        if db_utils.table_exists("connectors"):
            recreate_fk_with_cascade("connectors", "workspace_id", "workspaces")
        if db_utils.table_exists("connector_credentials"):
            recreate_fk_with_cascade("connector_credentials", "connector_id", "connectors")
        if db_utils.table_exists("connector_oauth_states"):
            recreate_fk_with_cascade("connector_oauth_states", "workspace_id", "workspaces")
        if db_utils.table_exists("connector_sync_destinations"):
            recreate_fk_with_cascade("connector_sync_destinations", "connector_id", "connectors")
            recreate_fk_with_cascade("connector_sync_destinations", "collection_id", "collections")
        if db_utils.table_exists("connector_sync_jobs"):
            recreate_fk_with_cascade("connector_sync_jobs", "connector_id", "connectors")
        if db_utils.table_exists("connector_file_syncs"):
            recreate_fk_with_cascade("connector_file_syncs", "connector_id", "connectors")

        # User settings and API keys
        if db_utils.table_exists("user_settings"):
            recreate_fk_with_cascade("user_settings", "user_id", "users")
        if db_utils.table_exists("api_keys"):
            recreate_fk_with_cascade("api_keys", "user_id", "users")

        # LangChain tables
        if db_utils.table_exists("langchain_pg_embedding"):
            recreate_fk_with_cascade("langchain_pg_embedding", "collection_id", "langchain_pg_collection", "uuid")

        print("   ✓ Ensured CASCADE constraints")
    else:
        connection.execute(text("PRAGMA foreign_keys = ON"))
        print("   ✓ Enabled foreign keys for SQLite")

    # ===== FROM 00013: Set use_agentic_routing default =====
    print("\n5. Setting use_agentic_routing default...")
    if db_utils.table_exists("user_settings"):
        if is_postgres:
            connection.execute(text("""
                UPDATE user_settings
                SET setting_value = (COALESCE(setting_value::jsonb, '{}'::jsonb) || '{"use_agentic_routing": true}'::jsonb)::json,
                    updated_at = NOW()
                WHERE setting_key = 'general'
                AND (
                    setting_value IS NULL
                    OR (setting_value::jsonb)->>'use_agentic_routing' IS NULL
                )
            """))
        else:
            connection.execute(text("""
                UPDATE user_settings
                SET setting_value = json_set(
                    COALESCE(setting_value, '{}'),
                    '$.use_agentic_routing',
                    json('true')
                ),
                updated_at = datetime('now')
                WHERE setting_key = 'general'
                AND (
                    setting_value IS NULL
                    OR json_extract(setting_value, '$.use_agentic_routing') IS NULL
                )
            """))
        print("   ✓ Set use_agentic_routing to true for existing users")

    # ===== FROM 00014: Add workspace_users.permission column =====
    print("\n6. Adding workspace_users.permission column...")
    if db_utils.table_exists("workspace_users"):
        if not db_utils.column_exists('workspace_users', 'permission'):
            server_default = "'read'" if is_postgres else "'read'"
            op.add_column(
                'workspace_users',
                sa.Column(
                    'permission',
                    sa.String(length=20),
                    nullable=False,
                    server_default=sa.text(server_default)
                )
            )
            print("   ✓ Added permission column to workspace_users")

    # ===== FROM 00015: Sync deprecated columns =====
    print("\n7. Syncing deprecated columns...")
    if db_utils.table_exists("workspace_users"):
        # Check if role column exists before syncing
        if db_utils.column_exists("workspace_users", "role"):
            # Sync role <-> permission
            connection.execute(text("""
                UPDATE workspace_users
                SET permission = role
                WHERE role IS NOT NULL
                AND (permission IS NULL OR permission != role)
            """))
            connection.execute(text("""
                UPDATE workspace_users
                SET role = permission
                WHERE permission IS NOT NULL
                AND (role IS NULL OR role != permission)
            """))
        connection.execute(text("""
            UPDATE workspace_users
            SET permission = 'read'
            WHERE permission IS NULL
        """))
        if db_utils.column_exists("workspace_users", "role"):
            connection.execute(text("""
                UPDATE workspace_users
                SET role = 'read'
                WHERE role IS NULL
            """))
        print("   ✓ Synced workspace_users role/permission")

    if db_utils.table_exists("documents"):
        has_document_name = db_utils.column_exists("documents", "document_name")
        has_title = db_utils.column_exists("documents", "title")
        has_filename = db_utils.column_exists("documents", "filename")

        if has_document_name and has_title:
            # Sync document_name <-> title
            connection.execute(text("""
                UPDATE documents
                SET title = document_name
                WHERE document_name IS NOT NULL
                AND (title IS NULL OR title != document_name)
            """))
            connection.execute(text("""
                UPDATE documents
                SET document_name = title
                WHERE title IS NOT NULL
                AND (document_name IS NULL OR document_name != title)
            """))
            if has_filename:
                connection.execute(text("""
                    UPDATE documents
                    SET title = filename,
                        document_name = filename
                    WHERE title IS NULL
                    AND document_name IS NULL
                    AND filename IS NOT NULL
                """))
            connection.execute(text("""
                UPDATE documents
                SET title = 'Untitled Document',
                    document_name = 'Untitled Document'
                WHERE title IS NULL OR document_name IS NULL
            """))
            print("   ✓ Synced documents document_name/title")

    # ===== FROM 00016: Drop deprecated document_name column =====
    print("\n8. Dropping deprecated document_name column...")
    if db_utils.table_exists("documents"):
        if db_utils.column_exists("documents", "document_name"):
            table_name = db_utils.get_table_name("documents")
            connection.execute(text(f"""
                ALTER TABLE {table_name}
                DROP COLUMN document_name
            """))
            print("   ✓ Dropped document_name column")

    # ===== FROM 00017: Create and activate system provider =====
    print("\n9. Activating system provider...")
    if db_utils.table_exists("model_providers"):
        if db_utils.column_exists("model_providers", "status") and db_utils.column_exists("model_providers", "name"):
            # Check if system provider exists (user_id IS NULL)
            result = connection.execute(text("SELECT COUNT(*) FROM model_providers WHERE user_id IS NULL"))
            count = result.scalar()

            if count == 0:
                # Insert system provider if it doesn't exist
                if is_postgres:
                    connection.execute(text("""
                        INSERT INTO model_providers (id, name, provider_type, status, show_models, validation_status, created_at, updated_at, user_id)
                        VALUES (gen_random_uuid(), 'openai', 'cloud', 'active', true, 'unknown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
                    """))
                else:
                    # SQLite
                    import uuid
                    provider_id = str(uuid.uuid4())
                    connection.execute(text(f"""
                        INSERT INTO model_providers (id, name, provider_type, status, show_models, validation_status, created_at, updated_at, user_id)
                        VALUES ('{provider_id}', 'openai', 'cloud', 'active', 1, 'unknown', datetime('now'), datetime('now'), NULL)
                    """))
                print("   ✓ Created system provider")
            else:
                # Update existing system provider
                connection.execute(text("""
                    UPDATE model_providers
                    SET status = 'active',
                        show_models = true,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE user_id IS NULL
                """))
                print("   ✓ Activated system provider")
        else:
            print("   ⊘ Skipped (columns not present)")

    print("\n" + "=" * 80)
    print("✓ COMBINED MIGRATION COMPLETE")
    print("=" * 80 + "\n")


# noinspection PyTypeChecker
def downgrade() -> None:
    """Reverse all combined migrations (in reverse order)."""
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]
    connection = op.get_bind()

    print("\n" + "=" * 80)
    print("REVERSING COMBINED MIGRATION 00008-00018")
    print("=" * 80)

    # FROM 00017: Deactivate system provider
    if db_utils.table_exists("model_providers"):
        connection.execute(text("""
            UPDATE model_providers
            SET status = 'inactive',
                show_models = false,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id IS NULL
        """))

    # FROM 00016: Re-add document_name column
    if db_utils.table_exists("documents"):
        if not db_utils.column_exists("documents", "document_name"):
            table_name = db_utils.get_table_name("documents")
            if is_postgres:
                connection.execute(text(f"""
                    ALTER TABLE {table_name}
                    ADD COLUMN document_name VARCHAR(255)
                """))
                connection.execute(text(f"""
                    UPDATE {table_name}
                    SET document_name = filename
                    WHERE document_name IS NULL
                """))
            else:
                connection.execute(text(f"""
                    ALTER TABLE {table_name}
                    ADD COLUMN document_name VARCHAR(255)
                """))
                connection.execute(text(f"""
                    UPDATE {table_name}
                    SET document_name = filename
                    WHERE document_name IS NULL
                """))

    # FROM 00014: Remove workspace_users.permission column
    if db_utils.column_exists('workspace_users', 'permission'):
        op.drop_column('workspace_users', 'permission')

    # FROM 00010: Remove workspace columns
    if db_utils.table_exists("workspaces"):
        if db_utils.column_exists('workspaces', 'is_shared'):
            op.drop_column('workspaces', 'is_shared')
        if db_utils.column_exists('workspaces', 'is_public'):
            op.drop_column('workspaces', 'is_public')
        if db_utils.column_exists('workspaces', 'description'):
            op.drop_column('workspaces', 'description')

    # FROM 00009: Remove document_summaries and settings
    if db_utils.table_exists("system_settings"):
        settings_table = db_utils.get_table_name("system_settings")
        connection.execute(text(f"""
            DELETE FROM {settings_table}
            WHERE setting_name IN (
                'document_summary_enabled',
                'document_summary_max_tokens',
                'document_summary_target_length',
                'enable_heading_prefix_generation',
                'enable_document_context_in_rag'
            )
        """))

    if db_utils.table_exists("document_summaries"):
        table_name = db_utils.get_table_name("document_summaries")
        connection.execute(text(f"DROP TABLE {table_name}"))

    # FROM 00008: Remove model capability columns
    if db_utils.table_exists("model_provider_models"):
        table_name = db_utils.get_table_name("model_provider_models")
        if db_utils.column_exists("model_provider_models", "supports_vision"):
            connection.execute(text(f"ALTER TABLE {table_name} DROP COLUMN supports_vision"))
        if db_utils.column_exists("model_provider_models", "supports_function_calling"):
            connection.execute(text(f"ALTER TABLE {table_name} DROP COLUMN supports_function_calling"))
        if db_utils.column_exists("model_provider_models", "supports_streaming"):
            connection.execute(text(f"ALTER TABLE {table_name} DROP COLUMN supports_streaming"))

    print("\n" + "=" * 80)
    print("✓ DOWNGRADE COMPLETE")
    print("=" * 80 + "\n")
