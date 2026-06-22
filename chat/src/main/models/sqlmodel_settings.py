"""
SQLModel models for user and server settings.
"""

from typing import Any

from sqlmodel import JSON, Column, Field

from src.main.models.sqlmodel_base import BaseModel

# =============================================================================
# SETTINGS MODELS
# =============================================================================


class ServerSetting(BaseModel, table=True):
    """
    Global server settings and configuration.

    Stores system-wide configuration values that apply to all users.
    """

    __tablename__ = "server_settings"

    # Setting identification
    setting_key: str = Field(max_length=100, unique=True, index=True)  # Setting key

    # Setting value (JSON for flexibility)
    setting_value: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))


# Update forward references
ServerSetting.model_rebuild()
