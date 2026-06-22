"""
Shared database schema utilities for Alembic migrations.

This module provides reusable functions for database schema operations
that are shared across multiple migration files.

IMPORTANT: This module must NOT import from src.main to avoid circular imports
during migration execution.
"""

import uuid

from sqlalchemy import text


def is_postgresql(op):
    """Check if we're using PostgreSQL/Supabase."""
    bind = op.get_bind()
    return bind.dialect.name == "postgresql"


def get_database_defaults(op):
    """
    Get database-specific default values for columns.

    Args:
        op: An alembic operations object

    Returns:
        Dictionary with server defaults for different database types
    """
    if is_postgresql(op):
        return {
            "server_default_uuid": text("gen_random_uuid()"),
            "server_default_now": text("CURRENT_TIMESTAMP"),
            "server_default_true": text("true"),
            "server_default_false": text("false"),
            "table_kwargs": {},
        }
    else:
        # SQLite - no server defaults, handled by Python event listeners
        return {
            "server_default_uuid": None,
            "server_default_now": None,
            "server_default_true": text("1"),
            "server_default_false": text("0"),
            "table_kwargs": {},
        }


def get_uuid_value(op):
    """
    Generate a UUID value compatible with the current database.

    Args:
        op: An alembic operations object

    Returns:
        String UUID value for the current database type
    """
    bind = op.get_bind()
    dialect_name = bind.dialect.name

    if dialect_name == "postgresql":
        # For PostgreSQL/Supabase, use gen_random_uuid() function
        return "gen_random_uuid()"
    else:
        # For SQLite and others, generate Python UUID
        return f"'{uuid.uuid4()!s}'"  # pyright: ignore[reportUnknownMemberType]


def column_exists(op, table_name, column_name):
    """
    Check if a column exists in a table, compatible with all database types.

    Args:
        op: Alembic operations object
        table_name: Name of the table
        column_name: Name of the column

    Returns:
        Boolean indicating if a column exists
    """
    bind = op.get_bind()
    dialect_name = bind.dialect.name

    if dialect_name == "postgresql":
        # Use information_schema for PostgreSQL/Supabase
        result = bind.execute(
            text("""
            SELECT EXISTS (
                SELECT FROM information_schema.columns
                WHERE table_name = :table_name AND column_name = :column_name
            )
        """),
            {"table_name": table_name, "column_name": column_name},
        )
        return result.fetchone()[0]
    else:
        # Use PRAGMA for SQLite
        # noinspection PyBroadException
        try:
            result = bind.execute(text(f"PRAGMA table_info({table_name})"))
            columns = result.fetchall()
            return any(col[1] == column_name for col in columns)
        except Exception:
            # If table doesn't exist, column doesn't exist
            return False


def table_exists(op, table_name):
    """
    Check if a table exists, compatible with all database types.

    Args:
        op: Alembic operations object
        table_name: Name of the table

    Returns:
        Boolean indicating if table exists
    """
    bind = op.get_bind()
    dialect_name = bind.dialect.name

    if dialect_name == "postgresql":
        # Use information_schema for PostgreSQL/Supabase
        result = bind.execute(
            text("""
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = :table_name AND table_schema = 'public'
            )
        """),
            {"table_name": table_name},
        )
        return result.fetchone()[0]
    else:
        # Use sqlite_master for SQLite
        result = bind.execute(
            text("""
            SELECT COUNT(*) FROM sqlite_master
            WHERE type='table' AND name = :table_name
        """),
            {"table_name": table_name},
        )
        return result.fetchone()[0] > 0


def insert_with_uuid(op, table_name, data_rows):
    """
    Insert rows with database-appropriate UUID generation.

    Args:
        op: Alembic operations object
        table_name: Name of the table
        data_rows: List of dictionaries containing row data
    """
    bind = op.get_bind()
    dialect_name = bind.dialect.name

    for row_data in data_rows:
        # Generate UUID for id field if not provided
        if "id" not in row_data:
            if dialect_name == "postgresql":
                # Use PostgreSQL function in SQL
                columns = ", ".join(row_data.keys())
                values = ", ".join([f":{key}" for key in row_data.keys()])
                sql = f"INSERT INTO {table_name} (id, {columns}) VALUES (gen_random_uuid(), {values})"
                bind.execute(text(sql), row_data)
            else:
                # Generate UUID in Python for SQLite
                row_data["id"] = f"{uuid.uuid4()!s}"  # pyright: ignore[reportUnknownMemberType]
                columns = ", ".join(row_data.keys())
                values = ", ".join([f":{key}" for key in row_data.keys()])
                sql = f"INSERT INTO {table_name} ({columns}) VALUES ({values})"
                bind.execute(text(sql), row_data)
        else:
            # ID provided, insert normally
            columns = ", ".join(row_data.keys())
            values = ", ".join([f":{key}" for key in row_data.keys()])
            sql = f"INSERT INTO {table_name} ({columns}) VALUES ({values})"
            bind.execute(text(sql), row_data)


def get_uuid_column_type():
    """Get UUID column type for the current database."""
    import sqlalchemy as sa

    return sa.String(36)  # Works for both PostgreSQL and SQLite


def get_json_column_type():
    """Get JSON column type for the current database."""
    import sqlalchemy as sa

    return sa.Text()  # Works for both PostgreSQL and SQLite


def get_datetime_column_type():
    """Get DateTime column type for the current database."""
    import sqlalchemy as sa

    return sa.DateTime()


def create_user_settings_table(op, defaults):
    """
    Create user_settings table with database-specific configurations.

    Args:
        op: Alembic operations object
        defaults: Database defaults from get_database_defaults()
    """
    import sqlalchemy as sa

    op.create_table(
        "user_settings",
        sa.Column("id", get_uuid_column_type(), primary_key=True, server_default=defaults["server_default_uuid"]),
        sa.Column("user_id", get_uuid_column_type(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("setting_key", sa.String(100), nullable=False),
        sa.Column("setting_value", get_json_column_type(), nullable=True),
        sa.Column(
            "created_at",
            get_datetime_column_type(),
            server_default=defaults["server_default_now"],
            nullable=False,
        ),
        sa.Column("updated_at", get_datetime_column_type(), nullable=True),
        # noinspection PyTypeChecker
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        **defaults["table_kwargs"],
    )


def create_model_provider_tables(op, defaults):
    """
    Create model provider related tables with database-specific configurations.

    Args:
        op: Alembic operations object
        defaults: Database defaults from get_database_defaults()
    """
    import sqlalchemy as sa

    # Create model_providers table
    op.create_table(
        "model_providers",
        sa.Column("id", get_uuid_column_type(), primary_key=True, server_default=defaults["server_default_uuid"]),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("provider_type", sa.String(50), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("settings", get_json_column_type(), nullable=True),
        sa.Column("show_models", sa.Boolean(), server_default=defaults["server_default_true"], nullable=False),
        sa.Column("status", sa.String(20), server_default=sa.text("'active'"), nullable=False),
        sa.Column("user_id", get_uuid_column_type(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column(
            "created_at",
            get_datetime_column_type(),
            server_default=defaults["server_default_now"],
            nullable=False,
        ),
        sa.Column("updated_at", get_datetime_column_type(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        **defaults["table_kwargs"],
    )

    # Create model_provider_models table
    op.create_table(
        "model_provider_models",
        sa.Column("id", get_uuid_column_type(), primary_key=True, server_default=defaults["server_default_uuid"]),
        sa.Column(
            "provider_id",
            get_uuid_column_type(),
            sa.ForeignKey("model_providers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("model_name", sa.String(200), nullable=False),
        sa.Column("display_name", sa.String(200), nullable=True),
        sa.Column("model_type", sa.String(50), nullable=False),
        sa.Column("context_length", sa.Integer(), nullable=True),
        sa.Column("max_output_tokens", sa.Integer(), nullable=True),
        sa.Column("input_cost_per_token", sa.Numeric(precision=10, scale=8), nullable=True),
        sa.Column("output_cost_per_token", sa.Numeric(precision=10, scale=8), nullable=True),
        sa.Column("supports_streaming", sa.Boolean(), server_default=defaults["server_default_true"], nullable=False),
        sa.Column("supports_function_calling", sa.Boolean(), server_default=defaults["server_default_false"], nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=defaults["server_default_true"], nullable=False),
        sa.Column(
            "created_at",
            get_datetime_column_type(),
            server_default=defaults["server_default_now"],
            nullable=False,
        ),
        sa.Column("updated_at", get_datetime_column_type(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        **defaults["table_kwargs"],
    )


def add_indexes_for_performance(op):
    """
    Add common indexes for better query performance.

    Args:
        op: Alembic operations object
    """
    # User settings indexes
    op.create_index("idx_user_settings_user_key", "user_settings", ["user_id", "setting_key"], unique=True)
    op.create_index("idx_user_settings_user_id", "user_settings", ["user_id"])

    # Model provider indexes
    op.create_index("idx_model_providers_type_status", "model_providers", ["provider_type", "status"])
    op.create_index("idx_model_providers_user_id", "model_providers", ["user_id"])
    op.create_index("idx_model_provider_models_provider", "model_provider_models", ["provider_id"])
    op.create_index("idx_model_provider_models_type", "model_provider_models", ["model_type"])


def drop_indexes_for_rollback(op):
    """
    Drop indexes during migration rollback.

    Args:
        op: Alembic operations object
    """
    # Drop user settings indexes
    op.drop_index("idx_user_settings_user_key", "user_settings")
    op.drop_index("idx_user_settings_user_id", "user_settings")

    # Drop model provider indexes
    op.drop_index("idx_model_providers_type_status", "model_providers")
    op.drop_index("idx_model_providers_user_id", "model_providers")
    op.drop_index("idx_model_provider_models_provider", "model_provider_models")
    op.drop_index("idx_model_provider_models_type", "model_provider_models")
