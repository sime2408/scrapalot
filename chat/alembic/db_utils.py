"""
Database utilities for Alembic migrations to ensure compatibility between
PostgreSQL and SQLite databases.
"""

from typing import Any

import sqlalchemy as sa
from sqlalchemy import Column, inspect, text
from sqlalchemy.dialects import postgresql

from alembic import context, op
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def get_dialect_info():
    """
    Get dialect-specific information for the current connection.

    Returns:
        dict: Dictionary containing dialect information
    """
    connection = context.get_context().bind
    dialect_name = str(connection.dialect.name).lower()

    # Determine if we're using PostgreSQL or SQLite
    is_postgresql = "postgresql" in dialect_name

    if is_postgresql:
        return {
            "is_postgresql": True,
            "dialect_name": dialect_name,
            "schema_name": "public",  # Use public schema instead of scrapalot
            "schema_prefix": "",  # No prefix needed since alembic handles schema context
        }
    else:
        return {
            "is_postgresql": False,
            "dialect_name": dialect_name,
            "schema_name": None,
            "schema_prefix": "",
        }


def get_table_name(table_name: str) -> str:
    """
    Get the appropriate table name for the current dialect.

    Args:
        table_name: Base table name without a schema

    Returns:
        Table name without schema prefix since alembic context handles schema
    """
    # Don't add schema prefix - alembic context already handles the schema
    # when search_path is set to 'scrapalot, public'
    return table_name


def table_exists(table_name: str) -> bool:
    """
    Check if a table exists in the database.

    Args:
        table_name: Base table name without a schema

    Returns:
        True if the table exists, False otherwise
    """
    conn = op.get_bind()
    inspector = inspect(conn)
    dialect_info = get_dialect_info()

    if dialect_info["is_postgresql"]:
        # For PostgreSQL, check with schema
        tables = inspector.get_table_names(schema=dialect_info["schema_name"])
        return table_name in tables
    else:
        # For SQLite, check without a schema
        tables = inspector.get_table_names()
        return table_name in tables


def column_exists(table_name: str, column_name: str) -> bool:
    """
    Check if a column exists in a table.

    Args:
        table_name: Base table name without schema
        column_name: Name of the column to check

    Returns:
        True if the column exists, False otherwise
    """
    conn = op.get_bind()
    inspector = inspect(conn)
    dialect_info = get_dialect_info()

    if not table_exists(table_name):
        return False

    if dialect_info["is_postgresql"]:
        # For PostgreSQL, check with schema
        columns = inspector.get_columns(table_name, schema=dialect_info["schema_name"])
    else:
        # For SQLite, check without a schema
        columns = inspector.get_columns(table_name)

    column_names = [c["name"] for c in columns]
    return column_name in column_names


def index_exists(index_name: str, table_name: str) -> bool:
    """
    Check if an index exists on a table.

    Args:
        index_name: Name of the index to check
        table_name: Name of the table

    Returns:
        True if the index exists, False otherwise
    """
    conn = op.get_bind()
    inspector = inspect(conn)
    dialect_info = get_dialect_info()

    if not table_exists(table_name):
        return False

    if dialect_info["is_postgresql"]:
        indexes = inspector.get_indexes(table_name, schema=dialect_info["schema_name"])
    else:
        indexes = inspector.get_indexes(table_name)

    index_names = [idx["name"] for idx in indexes]
    return index_name in index_names


def safe_create_index(index_name: str, table_name: str, columns: list[str]) -> bool:
    """
    Safely create an index, checking if it exists first to avoid transaction aborts.

    Args:
        index_name: Name of the index to create
        table_name: Name of the table
        columns: List of column names for the index

    Returns:
        True if index was created, False if it already existed
    """
    if index_exists(index_name, table_name):
        logger.debug("Index %s already exists on %s, skipping", index_name, table_name)
        return False

    if not table_exists(table_name):
        logger.debug("Table %s does not exist, skipping index %s", table_name, index_name)
        return False

    op.create_index(index_name, get_table_name(table_name), columns)
    logger.debug("Created index %s on %s", index_name, table_name)
    return True


def get_uuid_column_type() -> Any:
    """
    Get the appropriate UUID column type for the current dialect.

    Returns:
        UUID column type for PostgreSQL, String(36) for SQLite
    """
    dialect_info = get_dialect_info()

    if dialect_info["is_postgresql"]:
        return postgresql.UUID()
    else:
        return sa.String(36)


def get_varchar_column_type(length: int = 255) -> Any:
    """
    Get the appropriate VARCHAR column type for the current dialect.

    Args:
        length: Maximum length for the varchar column

    Returns:
        VARCHAR column type
    """
    return sa.String(length)


def get_json_column_type() -> Any:
    """
    Get the appropriate JSON column type for the current dialect.

    Returns:
        JSONB for PostgreSQL (required for jsonb_path_ops indexes), JSON/Text for SQLite
    """
    dialect_info = get_dialect_info()

    if dialect_info["is_postgresql"]:
        # Use JSONB for PostgreSQL - required for GIN indexes with jsonb_path_ops
        return postgresql.JSONB
    else:
        # For SQLite, use JSON with Text variant
        return sa.JSON().with_variant(sa.Text(), "sqlite")


def get_datetime_column_type() -> Any:
    """
    Get the appropriate DateTime column type for the current dialect.

    Returns:
        DateTime column type with timezone support for PostgreSQL, regular DateTime for SQLite
    """
    dialect_info = get_dialect_info()

    if dialect_info["is_postgresql"]:
        return sa.DateTime(timezone=True)
    else:
        return sa.DateTime()


def get_uuid_default():
    """
    Get the appropriate UUID default value for the current dialect.

    Returns:
        Default value expression for UUID columns
    """
    dialect_info = get_dialect_info()

    if dialect_info["is_postgresql"]:
        return text("gen_random_uuid()")
    else:
        # SQLite will use Python uuid4() in the application layer
        return None


def get_datetime_default():
    """
    Get the appropriate DateTime default value for the current dialect.

    Returns:
        Default value expression for DateTime columns
    """
    dialect_info = get_dialect_info()

    if dialect_info["is_postgresql"]:
        return text("now()")
    else:
        # SQLite will use Python datetime.now(datetime.UTC) in the application layer
        return None


def create_uuid_column(
    column_name: str,
    primary_key: bool = False,
    nullable: bool = False,
    index: bool = False,
    unique: bool = False,
    foreign_key: str | None = None,
    on_delete: str | None = None,
) -> Column:
    """
    Create a UUID column compatible with both PostgreSQL and SQLite.

    Args:
        column_name: Name of the column
        primary_key: Whether this is a primary key column
        nullable: Whether the column can be null
        index: Whether to create an index on this column
        unique: Whether to add a unique constraint
        foreign_key: Foreign key reference (e.g., "users.id")
        on_delete: On delete action (CASCADE, SET NULL, etc.)

    Returns:
        SQLAlchemy Column object
    """
    from sqlalchemy import ForeignKey

    dialect_info = get_dialect_info()

    # Build foreign key constraint if specified
    fk_constraint = None
    if foreign_key:
        if on_delete:
            fk_constraint = ForeignKey(foreign_key, ondelete=on_delete.upper())
        else:
            fk_constraint = ForeignKey(foreign_key)

    if dialect_info["is_postgresql"]:
        return Column(
            column_name,
            postgresql.UUID(as_uuid=True),
            fk_constraint,
            primary_key=primary_key,
            nullable=nullable,
            unique=unique,
            index=index,
            server_default=text("gen_random_uuid()") if not nullable and not foreign_key else None,
        )
    else:
        # For SQLite, use String(36) and handle UUID generation in Python
        return Column(column_name, sa.String(36), fk_constraint, primary_key=primary_key, nullable=nullable, unique=unique, index=index)


def create_datetime_column(column_name: str, nullable: bool = True, default_now: bool = False, update_now: bool = False) -> Column:
    """
    Create a DateTime column compatible with both PostgreSQL and SQLite.

    Args:
        column_name: Name of the column
        nullable: Whether the column can be null
        default_now: Whether to set default to current timestamp
        update_now: Whether to update to current timestamp on update

    Returns:
        SQLAlchemy Column object
    """
    dialect_info = get_dialect_info()

    if dialect_info["is_postgresql"]:
        # noinspection PyTypeChecker
        kwargs = {"nullable": nullable}
        if default_now:
            # noinspection PyTypeChecker
            kwargs["server_default"] = text("now()")
        if update_now:
            # noinspection PyTypeChecker
            kwargs["onupdate"] = text("now()")

        return Column(column_name, sa.DateTime(timezone=True), **kwargs)
    else:
        # For SQLite, use regular DateTime and handle defaults in Python
        kwargs = {"nullable": nullable}
        # SQLite doesn't support server_default with functions, handle in Python

        return Column(column_name, sa.DateTime(), **kwargs)


def create_varchar_column(
    column_name: str,
    length: int = 255,
    nullable: bool = True,
    unique: bool = False,
    index: bool = False,
    server_default: str | None = None,
) -> Column:
    """
    Create a VARCHAR column compatible with both PostgreSQL and SQLite.

    Args:
        column_name: Name of the column
        length: Maximum length of the varchar
        nullable: Whether the column can be null
        unique: Whether the column should be unique
        index: Whether to create an index on this column
        server_default: Default value for the column

    Returns:
        SQLAlchemy Column object
    """
    kwargs = {
        "nullable": nullable,
        "unique": unique,
        "index": index,
    }

    if server_default is not None:
        # noinspection PyTypeChecker
        kwargs["server_default"] = server_default

    return Column(column_name, get_varchar_column_type(length), **kwargs)


def safe_drop_constraint(table_name: str, constraint_name: str, type_="foreignkey") -> None:
    """
    Safely drop a constraint, handling differences between PostgreSQL and SQLite.

    Args:
        table_name: Base table name without schema
        constraint_name: Name of the constraint to drop
        type_: Type of constraint (foreignkey, unique, etc.)
    """
    dialect_info = get_dialect_info()
    qualified_table = get_table_name(table_name)

    # SQLite doesn't support dropping constraints directly
    if not dialect_info["is_postgresql"]:
        logger.info("Skipping constraint drop for SQLite: %s on %s", constraint_name, table_name)
        return

    try:
        op.drop_constraint(constraint_name, qualified_table, type_=type_)
        logger.info("Dropped constraint %s from %s", constraint_name, qualified_table)
    except Exception as e:
        logger.warning("Could not drop constraint %s from %s: %%s", constraint_name, qualified_table, e)
        # Try with a direct SQL command as a fallback
        try:
            op.execute(f"ALTER TABLE {qualified_table} DROP CONSTRAINT IF EXISTS {constraint_name}")
            logger.info("Dropped constraint %s from %s using direct SQL", constraint_name, qualified_table)
        except Exception as e2:
            logger.warning("Could not drop constraint using direct SQL either: %s", e2)


# noinspection SqlResolve
def enum_exists(enum_name: str) -> bool:
    """
    Check if a PostgreSQL enum type exists.

    Args:
        enum_name: Name of the enum type to check

    Returns:
        True if the enum type exists, False otherwise
    """
    dialect_info = get_dialect_info()

    # Only PostgreSQL supports enum types
    if not dialect_info["is_postgresql"]:
        logger.info("Enum check skipped for non-PostgreSQL database: %s", enum_name)
        return False

    try:
        conn = op.get_bind()
        # noinspection PyTypeChecker
        result = conn.execute(text("SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = :enum_name)"), {"enum_name": enum_name})
        # noinspection PyTypeChecker
        exists = result.scalar()
        logger.info("Enum type %s exists: %s", enum_name, exists)
        return exists
    except Exception as e:
        logger.warning("Error checking if enum %s exists: %%s", enum_name, e)
        return False
