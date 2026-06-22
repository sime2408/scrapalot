from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class AutoTitleGenerateMode(str, Enum):
    LOCAL = "LOCAL"
    REMOTE = "REMOTE"


class ModelProviderModelBase(BaseModel):
    model_name: str
    display_name: str | None = None
    model_type: str | None = "NORMAL"
    model_namespace: str | None = None
    context_window: int | None = None
    max_tokens: int | None = None
    dimensions: int | None = None
    temperature_default: float | None = None
    min_gpu_memory_mb: int | None = None
    min_cpu_memory_mb: int | None = None
    min_disk_space_mb: int | None = None
    icon: str | None = None
    provider_type: str | None = None  # CRITICAL: Provider type for frontend auto-selection logic
    provider_id: UUID | None = None


class ModelProviderModelCreate(ModelProviderModelBase):
    pass


class ModelProviderModelResponse(ModelProviderModelBase):
    id: UUID
    provider_id: UUID
    created_at: datetime
    # noinspection PyUnusedName
    model_config = {"from_attributes": True}


class ModelProviderBase(BaseModel):
    name: str
    provider_type: str  # Provider type (local, ollama, vllm, openai, anthropic, google)
    api_base: str | None = None
    description: str | None = None
    show_models: bool = True  # Whether to show models from this provider
    status: str = "active"  # Provider status (active or disabled)
    is_local: bool = False  # Flag to indicate if this is a local AI provider


class ModelProviderCreate(ModelProviderBase):
    api_key: str | None = None
    models: list[ModelProviderModelCreate] = []


class ModelProviderUpdate(BaseModel):
    name: str | None = None
    provider_type: str | None = None
    api_key: str | None = None
    api_base: str | None = None
    description: str | None = None
    show_models: bool | None = None
    status: str | None = None
    models: list[ModelProviderModelCreate] | None = None


class PaginationMetadata(BaseModel):
    current_page: int
    total_models: int
    has_more: bool
    models_per_page: int


class ModelProviderResponse(ModelProviderBase):
    id: UUID
    user_id: UUID | None = None  # Allow None for system providers
    created_at: datetime
    updated_at: datetime | None = None
    api_key: str | None = None
    models: list[ModelProviderModelResponse] = []
    pagination: PaginationMetadata | None = None
    # noinspection PyUnusedName
    model_config = {"from_attributes": True}


class UserSettingBase(BaseModel):
    setting_key: str  # Required for key-value approach
    setting_value: dict[str, Any] | None = None


class UserSettingResponse(UserSettingBase):
    id: UUID | None = None  # Optional for cases where default values are returned without a saved setting
    user_id: UUID
    created_at: datetime
    updated_at: datetime | None = None
    # noinspection PyUnusedName
    model_config = {"from_attributes": True}


# Combined settings object for frontend


class UserSettings(BaseModel):
    general: dict[str, Any] = Field(default_factory=dict)
    providers: list[ModelProviderResponse] = Field(default_factory=list)


# Provider with sensitive fields masked


class ModelProviderPublic(ModelProviderBase):
    id: UUID
    models: list[str] = []

    model_config = {"from_attributes": True}


# General settings DTO


class GeneralSettings(BaseModel):
    language: str = "en"
    auto_title_generate: AutoTitleGenerateMode = AutoTitleGenerateMode.LOCAL
    rendering_engine: str = "new"
    thinking_tokens: bool = True
    rendering_modules: list[str] = ["MARKDOWN", "GITHUB_MARKDOWN", "CODE_HIGHLIGHTING", "COLLAPSE_TAGS"]
    links_in_chat: bool = True
    proxy: str = ""  # Proxy address setting
    theme: str = "dark"
    theme_accent: str = "blue"
    font_style: str = "sans"
    theme_code: str = "github-dark"
    font_size: str = "md"
    rag_strategy: str | None = None  # Will be set to DEFAULT_RAG_STRATEGY in controller
    rag_orchestrator: str | None = None  # Will be set to DEFAULT_RAG_ORCHESTRATOR in controller
    use_orchestrator: bool = True  # Default to using orchestrator
    use_agentic_routing: bool = False  # Default to manual collection selection

    @field_validator("auto_title_generate", mode="before")
    @classmethod
    def convert_bool_to_enum(cls, v):
        """Convert old boolean format to new enum format for backwards compatibility."""
        if isinstance(v, bool):
            return AutoTitleGenerateMode.LOCAL if v else AutoTitleGenerateMode.REMOTE
        if isinstance(v, str):
            return AutoTitleGenerateMode(v.upper())
        return v

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary with all fields"""
        return self.model_dump()


# DTO for provider model information returned by list_provider_models


class ProviderModelDTO(BaseModel):
    id: str
    model_name: str  # API identifier for provider calls (required)
    display_name: str | None = None  # Human-readable display name (optional - UI can fallback to model_name)
    provider_id: str
    provider_type: str
    provider_name: str
    model_type: str
    is_embedding_model: bool = False
    is_active: bool = False
    is_system_model: bool = False  # True if provider.user_id IS NULL (system-wide provider)
    dimensions: int | None = None
    hardware_optimization: str | None = None  # 'gpu', 'cpu', or None for unknown

    # noinspection PyUnusedName
    model_config = {"from_attributes": True}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ProviderModelDTO":
        """Create instance from dictionary"""
        return cls(**data)


# DTO for grouped provider with models


class GroupedProviderDTO(BaseModel):
    id: str | None = None
    provider_type: str
    name: str
    models: list[ProviderModelDTO] = Field(default_factory=list)

    # noinspection PyUnusedName
    model_config = {"from_attributes": True}


# DTO for the complete grouped provider models response


class GroupedProviderModelsResponse(BaseModel):
    data: list[GroupedProviderDTO] = Field(default_factory=list)
    total: int = 0
    page: int | None = None
    limit: int | None = None
    has_more: bool = False

    # noinspection PyUnusedName
    model_config = {"from_attributes": True}
