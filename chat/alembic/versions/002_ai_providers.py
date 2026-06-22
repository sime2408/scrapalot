"""AI/LLM Provider Configuration Tables

Revision ID: 00002
Revises: 00001
Create Date: 2025-12-05

Creates AI provider configuration tables:
- model_providers (AI provider configurations: OpenAI, Anthropic, etc.)
- model_provider_models (available models catalog)
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

revision = '002'
down_revision = '001'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create AI provider tables."""
    dialect_info = db_utils.get_dialect_info()
    is_postgres = dialect_info["is_postgresql"]
    json_type = db_utils.get_json_column_type()

    # === MODEL_PROVIDERS TABLE ===
    # Columns match sqlmodel_providers.py ModelProvider class
    if not db_utils.table_exists("model_providers"):
        op.create_table(
            db_utils.get_table_name("model_providers"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("user_id", foreign_key="users.id", on_delete="CASCADE", nullable=True, index=True),
            # Provider identification
            db_utils.create_varchar_column("name", 100, nullable=False),  # openai, anthropic, etc.
            db_utils.create_varchar_column("provider_type", 50, nullable=False, server_default="local"),  # local, cloud, hybrid
            # Configuration
            db_utils.create_varchar_column("api_key", 255, nullable=True),
            db_utils.create_varchar_column("api_base", 255, nullable=True),  # Custom endpoint
            db_utils.create_varchar_column("description", 500, nullable=True),
            # Display settings
            sa.Column("show_models", sa.Boolean(), nullable=False, server_default=text("true" if is_postgres else "1")),
            # Status and validation
            db_utils.create_varchar_column("status", 50, nullable=False, server_default="active"),
            db_utils.create_varchar_column("validation_status", 50, nullable=True, server_default="unknown"),
            sa.Column("validation_error", sa.Text(), nullable=True),
            db_utils.create_varchar_column("last_validation_at", 50, nullable=True),  # ISO datetime string
            db_utils.create_varchar_column("last_successful_validation_at", 50, nullable=True),  # ISO datetime string
            # Additional configuration
            sa.Column("settings", json_type, nullable=True),
        )

    # === MODEL_PROVIDER_MODELS TABLE ===
    if not db_utils.table_exists("model_provider_models"):
        op.create_table(
            db_utils.get_table_name("model_provider_models"),
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_datetime_column("created_at"),
            db_utils.create_datetime_column("updated_at"),
            db_utils.create_uuid_column("provider_id", foreign_key="model_providers.id", on_delete="CASCADE", nullable=False, index=True),
            db_utils.create_varchar_column("model_name", 100, nullable=False),
            db_utils.create_varchar_column("display_name", 100, nullable=True),
            db_utils.create_varchar_column("model_type", 50, nullable=False),
            db_utils.create_varchar_column("model_namespace", 100, nullable=True),
            sa.Column("context_window", sa.Integer(), nullable=True),
            sa.Column("max_tokens", sa.Integer(), nullable=True),
            sa.Column("dimensions", sa.Integer(), nullable=True),
            sa.Column("temperature_default", sa.Float(), nullable=True),
            sa.Column("min_gpu_memory_mb", sa.Integer(), nullable=True),
            sa.Column("min_cpu_memory_mb", sa.Integer(), nullable=True),
            sa.Column("min_disk_space_mb", sa.Integer(), nullable=True),
            sa.Column("input_cost", sa.Float(), nullable=True),
            sa.Column("output_cost", sa.Float(), nullable=True),
            sa.Column("supports_tools", sa.Boolean(), nullable=False, server_default=text("false" if is_postgres else "0")),
            sa.Column("supports_streaming", sa.Boolean(), nullable=False, server_default=text("false" if is_postgres else "0")),
            sa.Column("supports_function_calling", sa.Boolean(), nullable=False, server_default=text("false" if is_postgres else "0")),
            sa.Column("supports_vision", sa.Boolean(), nullable=False, server_default=text("false" if is_postgres else "0")),
        )

    # Create indexes for performance
    db_utils.safe_create_index("ix_model_providers_name", "model_providers", ["name"])
    db_utils.safe_create_index("ix_model_providers_user_id", "model_providers", ["user_id"])
    db_utils.safe_create_index("ix_model_provider_models_model_name", "model_provider_models", ["model_name"])
    db_utils.safe_create_index("ix_model_provider_models_provider_id", "model_provider_models", ["provider_id"])


def downgrade() -> None:
    """Drop AI provider tables."""
    if db_utils.table_exists("model_provider_models"):
        op.drop_table(db_utils.get_table_name("model_provider_models"))

    if db_utils.table_exists("model_providers"):
        op.drop_table(db_utils.get_table_name("model_providers"))
