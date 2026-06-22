"""
Base database model definition that can be imported by all model files.
This prevents circular imports between model files.
"""

from sqlalchemy.orm import registry as sa_registry
from sqlmodel import SQLModel

# Define common naming conventions for constraints to ensure compatibility across DB engines
naming_convention = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

# Use SQLModel's metadata to ensure all models share the same metadata
metadata = SQLModel.metadata
metadata.naming_convention = naming_convention

# CRITICAL FIX: Create a registry using SQLModel's metadata
# This ensures both Base (traditional SQLAlchemy) and SQLModel models share the same registry
# for forward reference resolution (e.g., "Workspace", "Note" string references)
mapper_registry = sa_registry(metadata=metadata)
Base = mapper_registry.generate_base()
