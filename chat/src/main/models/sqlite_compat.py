"""
SQLite's compatibility layer for database models.
Provides utilities to create database-agnostic models that work with both PostgreSQL and SQLite.
"""

from datetime import UTC, datetime
import json
from typing import Any
import uuid

from sqlalchemy import Column, DateTime, TypeDecorator, event, text
from sqlalchemy.dialects.postgresql import JSON, JSONB, UUID
from sqlalchemy.ext.declarative import declared_attr
from sqlalchemy.types import CHAR, Text

from src.main.config.database import DB_TYPE


class ScrapalotUUID(TypeDecorator):
    """Platform-independent UUID type that adapts to each database's optimal format."""

    impl = CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "sqlite":
            return dialect.type_descriptor(CHAR(36))
        elif dialect.name == "postgresql":
            return dialect.type_descriptor(UUID(as_uuid=True))
        else:
            return dialect.type_descriptor(CHAR(36))

    def process_bind_param(self, value, dialect):
        if value is None:
            return value
        elif dialect.name == "sqlite":
            return str(value)
        elif dialect.name == "postgresql":
            return value
        else:
            return str(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return value
        elif dialect.name == "sqlite":
            # Convert string back to a UUID object for consistency
            return uuid.UUID(value) if isinstance(value, str) else value
        elif dialect.name == "postgresql":
            return value  # PostgreSQL returns UUID objects natively
        else:
            # For other dialects, convert string to a UUID object
            return uuid.UUID(value) if isinstance(value, str) else value


def get_uuid_column_type():
    """Get the appropriate UUID column type for the current database."""
    return ScrapalotUUID()


def get_datetime_column_type():
    """Get the appropriate DateTime column type for the current database."""
    if DB_TYPE == "postgresql":
        return DateTime(timezone=True)
    else:
        return DateTime()


def get_server_default_uuid():
    """Get the appropriate server default for UUID columns."""
    if DB_TYPE == "postgresql":
        return text("gen_random_uuid()")
    else:
        return None  # SQLite handles this via event listeners


def get_server_default_now():
    """Get the appropriate server default for timestamp columns."""
    if DB_TYPE == "postgresql":
        return text("now()")
    else:
        return None  # SQLite handles this via event listeners


class ScrapalotJSON(TypeDecorator):
    """Platform-independent JSON type that adapts to each database's optimal format."""

    impl = Text
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(JSON())
        else:
            return dialect.type_descriptor(Text())

    def process_bind_param(self, value, dialect):
        if value is None:
            return value
        elif dialect.name == "postgresql":
            return value  # PostgreSQL handles JSON natively
        else:
            # For SQLite, serialize to JSON string
            return json.dumps(value) if value is not None else None

    def process_result_value(self, value, dialect):
        if value is None:
            return value
        elif dialect.name == "postgresql":
            return value  # PostgreSQL returns dict objects natively
        else:
            # For SQLite, deserialize from JSON string
            try:
                return json.loads(value) if isinstance(value, str) else value
            except (json.JSONDecodeError, TypeError):
                return value


def get_json_column_type():
    """Get the appropriate JSON column type for the current database."""
    return ScrapalotJSON()


class ScrapalotJSONB(TypeDecorator):
    """Platform-independent JSONB type that adapts to each database's optimal format.

    Uses JSONB for PostgreSQL (binary JSON with indexing support) and Text for SQLite.
    """

    impl = Text
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(JSONB())
        else:
            return dialect.type_descriptor(Text())

    def process_bind_param(self, value, dialect):
        if value is None:
            return value
        elif dialect.name == "postgresql":
            return value  # PostgreSQL handles JSONB natively
        else:
            # For SQLite, serialize to JSON string
            return json.dumps(value) if value is not None else None

    def process_result_value(self, value, dialect):
        if value is None:
            return value
        elif dialect.name == "postgresql":
            return value  # PostgreSQL returns dict objects natively
        else:
            # For SQLite, deserialize from JSON string
            try:
                return json.loads(value) if isinstance(value, str) else value
            except (json.JSONDecodeError, TypeError):
                return value


def get_jsonb_column_type():
    """Get the appropriate JSONB column type for the current database."""
    return ScrapalotJSONB()


def create_uuid_column(primary_key=False, nullable=False, index=False, **kwargs):
    """Create a UUID column that works with both PostgreSQL and SQLite."""
    if DB_TYPE == "postgresql":
        return Column(
            get_uuid_column_type(),
            primary_key=primary_key,
            nullable=nullable,
            index=index,
            server_default=text("gen_random_uuid()") if not nullable else None,
            **kwargs,
        )
    else:
        # For SQLite, we'll handle UUID generation in Python
        return Column(get_uuid_column_type(), primary_key=primary_key, nullable=nullable, index=index, **kwargs)


def create_datetime_column(nullable=True, default_now=False, update_now=False, **kwargs):
    """Create a DateTime column that works with both PostgreSQL and SQLite."""
    if DB_TYPE == "postgresql":
        column_kwargs: dict[str, Any] = {"nullable": nullable, **kwargs}
        if default_now:
            column_kwargs["server_default"] = text("now()")
        if update_now:
            column_kwargs["onupdate"] = text("now()")
        return Column(get_datetime_column_type(), **column_kwargs)
    else:
        # For SQLite, we'll handle datetime defaults in Python
        column_kwargs = {"nullable": nullable, **kwargs}
        return Column(get_datetime_column_type(), **column_kwargs)


class SQLiteCompatMixin:
    """Mixin class that provides SQLite compatibility for models."""

    # noinspection PyMethodParameters
    @declared_attr
    def id(cls):
        """Create an ID column that works with both PostgreSQL and SQLite."""
        return create_uuid_column(primary_key=True, index=True)

    # noinspection PyMethodParameters
    @declared_attr
    def created_at(cls):
        """Create a created_at column that works with both PostgreSQL and SQLite."""
        return create_datetime_column(nullable=False, default_now=True)

    # noinspection PyMethodParameters
    @declared_attr
    def updated_at(cls):
        """Create an updated_at column that works with both PostgreSQL and SQLite."""
        return create_datetime_column(nullable=True, update_now=True)


def setup_sqlite_event_listeners():
    """Set up event listeners to handle UUID and datetime defaults for SQLite."""
    if DB_TYPE != "sqlite":
        return

    # String already imported at line 11
    # Fix Python 3.12 SQLite datetime adapter deprecation warning
    # datetime already imported at line 5
    import sqlite3

    from src.main.models.base import Base

    def adapt_datetime_iso(val):
        """Custom datetime adapter for Python 3.12+ to replace deprecated default."""
        return val.isoformat()

    def convert_datetime(val):
        """Custom datetime converter for Python 3.12+ to replace deprecated default."""
        try:
            return datetime.fromisoformat(val.decode())
        except (ValueError, AttributeError):
            # Fallback for different datetime formats
            try:
                return datetime.strptime(val.decode(), "%Y-%m-%d %H:%M:%S")
            except (ValueError, AttributeError):
                return val

    # Register custom adapters to replace deprecated ones
    sqlite3.register_adapter(datetime, adapt_datetime_iso)
    sqlite3.register_converter("datetime", convert_datetime)
    sqlite3.register_converter("DATETIME", convert_datetime)
    sqlite3.register_converter("timestamp", convert_datetime)
    sqlite3.register_converter("TIMESTAMP", convert_datetime)

    @event.listens_for(Base, "before_insert", propagate=True)
    def before_insert(_mapper, _connection, target):
        """Handle UUID and datetime defaults before insert for SQLite."""
        # Generate UUID for a primary key if not set
        if hasattr(target, "id") and target.id is None:
            target.id = str(uuid.uuid4())

        # Set created_at if not set
        if hasattr(target, "created_at") and target.created_at is None:
            target.created_at = datetime.now(UTC)

        # Set updated_at if not set
        if hasattr(target, "updated_at") and target.updated_at is None:
            target.updated_at = datetime.now(UTC)

    @event.listens_for(Base, "before_update", propagate=True)
    def before_update(_mapper, _connection, target):
        """Handle datetime updates before update for SQLite."""
        # Always update updated_at on updates
        if hasattr(target, "updated_at"):
            target.updated_at = datetime.now(UTC)


def create_foreign_key_column(referenced_table: str, nullable: bool = False, index: bool = True, **kwargs):
    """Create a foreign key column that works with both PostgreSQL and SQLite."""
    from sqlalchemy import ForeignKey

    return Column(
        ScrapalotUUID(),
        ForeignKey(f"{referenced_table}.id", ondelete="CASCADE"),
        nullable=nullable,
        index=index,
        **kwargs,
    )
