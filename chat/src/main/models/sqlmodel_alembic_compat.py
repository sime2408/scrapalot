"""
SQLModel compatibility layer for Alembic migrations.

This module ensures that Alembic can properly detect and generate migrations
for SQLModel models while maintaining backward compatibility with existing
SQLAlchemy models.
"""

from sqlmodel import SQLModel

from src.main.models.sqlmodel_base import configure_sqlmodel_metadata

# NOTE: Models are imported inside get_sqlmodel_metadata() to avoid conflicts


def get_sqlmodel_metadata():
    """Get SQLModel metadata for Alembic autogenerate"""
    # Ensure SQLModel metadata is properly configured
    configure_sqlmodel_metadata()
    return SQLModel.metadata


# Configure metadata for Alembic - use SQLModel only
target_metadata = get_sqlmodel_metadata()
