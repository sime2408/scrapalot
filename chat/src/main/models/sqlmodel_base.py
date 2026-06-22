"""
SQLModel base configuration for the Scrapalot application.

This module provides SQLModel-compatible base classes while maintaining
compatibility with existing Alembic migrations and SQLAlchemy patterns.
"""

from datetime import UTC, datetime
from uuid import UUID, uuid4

from pydantic import ConfigDict
from sqlalchemy import Column, DateTime, MetaData, func

# noinspection PyPep8Naming
from sqlalchemy.dialects.postgresql import UUID as PostgresUUID
from sqlalchemy.types import CHAR, TypeDecorator
from sqlmodel import Field, SQLModel

# Define common naming conventions for constraints to ensure compatibility across DB engines
naming_convention = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

# Create metadata with custom naming conventions (no schema for now to avoid conflicts)
metadata = MetaData(naming_convention=naming_convention)


class ScrapalotUUID(TypeDecorator):
    """
    Database-agnostic UUID type.
    Uses PostgreSQL UUID for PostgreSQL, CHAR(36) for SQLite.
    Maintains compatibility with existing database structure.
    """

    impl = CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PostgresUUID())
        else:
            return dialect.type_descriptor(CHAR(36))

    def process_bind_param(self, value, dialect):
        if value is None:
            return value
        elif dialect.name == "postgresql":
            return str(value)
        else:
            if not isinstance(value, UUID):
                return str(value)
            return str(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return value
        else:
            if not isinstance(value, UUID):
                return UUID(str(value))
            return value


class BaseModel(SQLModel):
    """
    Base SQLModel class with common fields and functionality.

    Provides:
    - UUID primary key
    - Created/updated timestamps
    - Proper schema configuration
    - Database-agnostic types
    """

    model_config = ConfigDict(
        from_attributes=True,  # Enable ORM mode for Pydantic compatibility
        use_enum_values=True,  # Use enum values for serialization
        populate_by_name=True,  # Allow population by field name
    )

    # Common fields for all models
    # Note: Using sa_column_kwargs instead of sa_column to avoid conflicts with extend_existing
    # noinspection PyTypeChecker
    id: UUID | None = Field(default_factory=uuid4, primary_key=True, sa_type=ScrapalotUUID())

    # noinspection PyTypeChecker
    created_at: datetime | None = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_type=DateTime(timezone=True),
        sa_column_kwargs={"server_default": func.now(), "nullable": False},
    )

    # noinspection PyTypeChecker
    updated_at: datetime | None = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_type=DateTime(timezone=True),
        sa_column_kwargs={"server_default": func.now(), "onupdate": func.now(), "nullable": False},
    )


# Schema configuration for SQLModel
def configure_sqlmodel_metadata():
    """
    Configure SQLModel metadata.
    Return SQLModel's default metadata for compatibility.
    """
    # Use SQLModel's default metadata to avoid conflicts
    return SQLModel.metadata


# Database-agnostic utility functions
def get_uuid_column(nullable: bool = False, primary_key: bool = False):
    """Create a database-agnostic UUID column"""
    return Column(ScrapalotUUID(), primary_key=primary_key, nullable=nullable, default=uuid4)


def get_datetime_column(nullable: bool = False, server_default=None, onupdate=None):
    """Create a database-agnostic datetime column with timezone support"""
    return Column(DateTime(timezone=True), nullable=nullable, server_default=server_default, onupdate=onupdate)


def get_schema_name() -> str:
    """Get the schema name for the current database"""
    return "scrapalot"


# Ensure metadata is properly configured
configure_sqlmodel_metadata()
