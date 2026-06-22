"""
SQLModel models for AI model providers and configurations.
"""

from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import ForeignKey, Text
from sqlmodel import JSON, Column, Field, Relationship

from src.main.models.sqlmodel_base import BaseModel, ScrapalotUUID

if TYPE_CHECKING:
    pass

# =============================================================================
# AI MODEL PROVIDER MODELS
# =============================================================================


class ModelProvider(BaseModel, table=True, extend_existing=True):
    """
    AI model provider configuration (OpenAI, Anthropic, local models, etc.).

    Stores API keys, endpoints, and provider-specific settings for each user.
    """

    __tablename__ = "model_providers"

    # User ID (plain UUID, no FK constraint; nullable for system-wide providers)
    user_id: UUID | None = Field(sa_column=Column(ScrapalotUUID(), nullable=True, index=True), default=None)

    # Provider identification - matching actual database columns
    name: str = Field(max_length=100)  # openai, anthropic, google, ollama, etc.
    provider_type: str = Field(max_length=50, default="local")  # CRITICAL: This was missing!

    # Configuration - matching actual database columns
    api_key: str | None = Field(max_length=255, default=None)  # Encrypted API key
    api_base: str | None = Field(max_length=255, default=None)  # Custom endpoint (note: api_base not api_base_url)
    description: str | None = Field(max_length=500, default=None)

    # Backend semantic version (e.g. Ollama "0.5.7"). Populated at provider sync time
    # so the structured-output router can gate features behind a minimum version
    # (Ollama gained native format=schema enforcement in 0.5.0).
    provider_version: str | None = Field(max_length=64, default=None)

    # Display settings
    show_models: bool = Field(default=True)

    # Status and validation - matching actual database columns
    status: str = Field(max_length=50, default="active")  # CRITICAL: This was missing!
    validation_status: str = Field(max_length=50, default="unknown")
    validation_error: str | None = Field(default=None, sa_column=Column(Text))
    last_validation_at: str | None = Field(default=None)  # ISO datetime string
    last_successful_validation_at: str | None = Field(default=None)  # ISO datetime string

    # Additional configuration
    settings: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))

    # Relationships
    models: list["ModelProviderModel"] = Relationship(back_populates="provider", cascade_delete=True)


class ModelProviderModel(BaseModel, table=True, extend_existing=True):
    """
    Individual AI model details with pricing and capabilities.

    Stores information about specific models available from each provider,
    including pricing, context windows, and feature support.
    """

    __tablename__ = "model_provider_models"

    # Foreign key to provider
    provider_id: UUID = Field(sa_column=Column(ScrapalotUUID(), ForeignKey("model_providers.id", ondelete="CASCADE"), nullable=False, index=True))

    # Model identification - matching actual database columns
    model_name: str = Field(max_length=100)  # gpt-4o, claude-3-sonnet, etc.
    display_name: str | None = Field(max_length=100, default=None)  # Display name
    model_type: str = Field(max_length=50)  # CRITICAL: This was missing! (chat, embeddings, etc.)
    model_namespace: str | None = Field(max_length=100, default=None)

    # Model capabilities - matching actual database columns
    context_window: int | None = Field(default=None)  # Maximum tokens
    max_tokens: int | None = Field(default=None)  # Maximum output tokens
    dimensions: int | None = Field(default=None)  # For embedding models
    temperature_default: float | None = Field(default=None)

    # System requirements
    min_gpu_memory_mb: int | None = Field(default=None)
    min_cpu_memory_mb: int | None = Field(default=None)
    min_disk_space_mb: int | None = Field(default=None)

    # Pricing information - matching actual database columns
    input_cost: float | None = Field(default=None)  # Note: float not Decimal in database
    output_cost: float | None = Field(default=None)

    # Feature support
    supports_tools: bool = Field(default=False)  # Function calling support
    supports_streaming: bool = Field(default=True)
    supports_function_calling: bool = Field(default=False)
    supports_vision: bool = Field(default=False)
    supports_image_generation: bool = Field(default=False)  # dall-e-*, gpt-image-1, flux-*, stable-diffusion-*
    supports_audio_input: bool = Field(default=False)  # whisper-*, gpt-4o-audio-* (input modality)
    supports_audio_output: bool = Field(default=False)  # tts-*, gpt-4o-audio-* (output modality)
    supports_realtime: bool = Field(default=False)  # gpt-4o-realtime-* and equivalents

    # Relationships
    provider: ModelProvider = Relationship(back_populates="models")


# Update forward references
ModelProvider.model_rebuild()
ModelProviderModel.model_rebuild()
