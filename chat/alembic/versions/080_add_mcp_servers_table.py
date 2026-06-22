"""Add mcp_servers table

Revision ID: 080
Revises: 079
Create Date: 2026-06-06 06:45:00.000000

Replica of the Kotlin-owned mcp_servers table (Liquibase migration 124). Per-user
MCP (Model Context Protocol) client integrations: a remote MCP server
(streamable HTTP / SSE) whose tools are injected into the user's chat agent at
request time when enabled. Kept in sync over the new scrapalot:stream:mcp_servers
Redis stream + cold-start snapshot (scrapalot:sync:mcp_servers_snapshot).

No foreign key on user_id: this is a denormalized read replica and the Python DB
does not own the users table. The auth_token is stored in its encrypted
(enc:v1:) form and decrypted at call time with the shared key.
"""
from pathlib import Path
import sys

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from collections.abc import Sequence

# noinspection PyUnresolvedReferences
import db_utils
import sqlalchemy as sa
from sqlalchemy import text

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '080'
down_revision: str | None = '079'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the mcp_servers replica table."""
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]
    json_type = db_utils.get_json_column_type()

    if not db_utils.table_exists("mcp_servers"):
        op.create_table(
            db_utils.get_table_name("mcp_servers"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at", nullable=False, default_now=True),
            db_utils.create_datetime_column("updated_at", nullable=False, default_now=True, update_now=True),
            db_utils.create_uuid_column("user_id", nullable=False, index=True),
            db_utils.create_varchar_column("name", 100, nullable=False),
            db_utils.create_varchar_column("transport", 20, nullable=False, server_default="http"),
            db_utils.create_varchar_column("url", 1000, nullable=False),
            db_utils.create_varchar_column("auth_token", 2000, nullable=True),
            sa.Column("headers", json_type, nullable=True),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=text("true" if is_postgres else "1")),
            db_utils.create_varchar_column("tool_prefix", 50, nullable=True),
            db_utils.create_varchar_column("description", 500, nullable=True),
            sa.Column("cached_tools", json_type, nullable=True),
            db_utils.create_datetime_column("last_connected_at", nullable=True),
            db_utils.create_varchar_column("last_error", 2000, nullable=True),
        )


def downgrade() -> None:
    """Drop the mcp_servers replica table."""
    if db_utils.table_exists("mcp_servers"):
        op.drop_table(db_utils.get_table_name("mcp_servers"))
