"""
Agent Model Utilities Module.

Provides utilities for retrieving the Pydantic AI agent model configuration.
All Pydantic AI agents use these utilities to get their LLM configuration.

Priority order for agent model resolution:
1. Environment variables (AGENT_MODEL_NAME, AGENT_PROVIDER_TYPE) — dev/testing override
2. Database server_settings (key: system_agent_config) — admin-configurable via UI
3. Config file (configs/config.yaml → llm.agents) — initial defaults only

API keys are loaded from the database (server_settings.system_agent_config),
configured via Settings > General > System AI Agent Provider in the admin UI.
"""

from dataclasses import dataclass
import os

from src.main.utils.config.loader import get_resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Roles that GENERATE the user-facing chat answer in FREE TEXT — the deterministic
# RAG synthesis ("rag_answer") and the post-answer model-insight reflection
# ("reflection"). With a two-model "Scrapalot AI" these run on the configured
# synthesis model (e.g. DeepSeek V4-Flash); every other role runs on the agent
# model (gpt-4o-mini).
#
# IMPORTANT: this set must contain ONLY free-text generation roles. The synthesis
# model may be a thinking model (DeepSeek V4-Flash) that REJECTS `tool_choice`,
# so any STRUCTURED-OUTPUT agent (classifiers, extractors, pydantic-ai output
# types) must NOT be listed here — it would 400. The generic legacy token
# "synthesis" is deliberately NOT in this set: dozens of structured callers
# (citation stance classifier, notes transforms, paper/podcast/tutor, deep
# research) already pass agent_type="synthesis" and must keep running on the
# reliable tool-calling agent model.
# "collection_digest" is free-text synthesis (aggregating book summaries into a
# bounded collection memory), so it belongs on the synthesis model — NOT a
# structured-output call.
SYNTHESIS_AGENT_TYPES = frozenset({"rag_answer", "reflection", "collection_digest"})


@dataclass
class AgentModelConfig:
    """Configuration for an agent's LLM model."""

    provider_type: str  # openai, anthropic, google, ollama, etc.
    model_name: str  # gpt-4o-mini, claude-sonnet-4, etc.
    api_key: str | None = None  # API key for the provider
    api_base: str | None = None  # Custom API base URL (for self-hosted)
    context_window: int = 128000  # Model context window in tokens (default: 128K)
    provider_version: str | None = None  # Backend version (Ollama "0.5.7", ...) — for structured-output gating

    def get_pydantic_ai_model_string(self) -> str:
        """
        Get the model string formatted for Pydantic AI.

        Returns:
            Model string in format "provider:model" (e.g., "openai:gpt-4o-mini")
        """
        return f"{self.provider_type}:{self.model_name}"

    def get_pydantic_ai_model(self):
        """
        Get a properly configured Pydantic AI model object with API key.

        Returns a model object (not string) that includes the API key.
        This is required because Pydantic AI string models expect API keys in
        environment variables, but we may have them in secrets.yaml.

        Returns:
            Pydantic AI model object or string (for ollama/local)
        """
        try:
            if self.provider_type == "openai" and self.api_key:
                from pydantic_ai.models.openai import OpenAIChatModel
                from pydantic_ai.providers.openai import OpenAIProvider

                openai_provider = OpenAIProvider(api_key=self.api_key)
                # noinspection PyTypeChecker
                return OpenAIChatModel(self.model_name, provider=openai_provider)

            elif self.provider_type == "anthropic" and self.api_key:
                from pydantic_ai.models.anthropic import AnthropicModel
                from pydantic_ai.providers.anthropic import AnthropicProvider

                anthropic_provider = AnthropicProvider(api_key=self.api_key)
                return AnthropicModel(self.model_name, provider=anthropic_provider)

            elif self.provider_type == "google" and self.api_key:
                from pydantic_ai.models.google import GoogleModel
                from pydantic_ai.providers.google import GoogleProvider

                google_provider = GoogleProvider(api_key=self.api_key)
                return GoogleModel(self.model_name, provider=google_provider)

            elif self.provider_type == "ollama":
                # Ollama uses OpenAI-compatible API with custom base URL
                if self.api_base:
                    from pydantic_ai.models.openai import OpenAIChatModel
                    from pydantic_ai.providers.openai import OpenAIProvider

                    openai_provider = OpenAIProvider(
                        api_key="ollama",
                        base_url=f"{self.api_base.rstrip('/')}/v1",
                    )
                    # noinspection PyTypeChecker
                    return OpenAIChatModel(self.model_name, provider=openai_provider)
                return f"ollama:{self.model_name}"

            elif self.provider_type in ("vllm", "lmstudio") and self.api_base:
                # vLLM and LMStudio use OpenAI-compatible API
                from pydantic_ai.models.openai import OpenAIChatModel
                from pydantic_ai.providers.openai import OpenAIProvider

                openai_provider = OpenAIProvider(
                    api_key=self.api_key or "none",
                    base_url=self.api_base.rstrip("/"),
                )
                # noinspection PyTypeChecker
                return OpenAIChatModel(self.model_name, provider=openai_provider)

            elif self.provider_type == "deepseek" and self.api_key:
                # DeepSeek exposes an OpenAI-compatible API; reuse the OpenAI
                # client with DeepSeek's base URL (defaults to the public
                # endpoint when api_base is not set).
                from pydantic_ai.models.openai import OpenAIChatModel
                from pydantic_ai.providers.openai import OpenAIProvider

                openai_provider = OpenAIProvider(
                    api_key=self.api_key,
                    base_url=(self.api_base or "https://api.deepseek.com").rstrip("/"),
                )
                # noinspection PyTypeChecker
                return OpenAIChatModel(self.model_name, provider=openai_provider)

            else:
                # Fallback to string (will use environment variables)
                return self.get_pydantic_ai_model_string()

        except ImportError as e:
            logger.warning("Could not import Pydantic AI model: %s. Falling back to string.", str(e))
            return self.get_pydantic_ai_model_string()


def _get_provider_version(provider_type: str) -> str | None:
    """Look up backend version stored on the matching ModelProvider row.

    Returns the version string (e.g. ``"0.5.7"``) or ``None`` when no provider
    matches or no version has been recorded yet (e.g. before the first sync).
    """
    try:
        from src.main.config.database import SessionLocal
        from src.main.models.sqlmodel_providers import ModelProvider

        db = SessionLocal()
        try:
            row = (
                db.query(ModelProvider.provider_version)
                .filter(
                    ModelProvider.provider_type == provider_type,
                    ModelProvider.provider_version.isnot(None),
                )
                .first()
            )
            return row[0] if row and row[0] else None
        finally:
            db.close()
    except Exception as e:
        logger.debug("Could not load provider_version for %s: %s", provider_type, str(e))
        return None


def _get_db_agent_config() -> dict | None:
    """
    Load system agent configuration from the server_settings table.

    Returns:
        Config dict with provider_type, model_name, api_key, api_base, model_overrides
        or None if not configured in DB.
    """
    try:
        from src.main.config.database import SessionLocal
        from src.main.models.sqlmodel_settings import ServerSetting

        db = SessionLocal()
        try:
            setting = (
                db.query(ServerSetting)
                .filter(
                    ServerSetting.setting_key == "system_agent_config",
                )
                .first()
            )

            if setting and setting.setting_value:
                return setting.setting_value
            return None
        finally:
            db.close()
    except Exception as e:
        logger.debug("Could not load system_agent_config from DB: %s", str(e))
        return None


def get_system_agent_model(
    db=None,  # Optional database session for context_window lookup
    agent_type: str | None = None,
) -> AgentModelConfig:
    """
    Get the Pydantic AI agent model configuration.

    Priority order:
    1. Environment variables: AGENT_MODEL_NAME, AGENT_PROVIDER_TYPE
    2. Database: server_settings → system_agent_config (admin-configurable via UI)
    3. Config file: llm.agents.default_provider, llm.agents.default_model
    4. Agent-specific overrides from DB config or llm.agents.model_overrides

    Context window resolution:
    1. Database: model_provider_models.context_window (if db session provided)
    2. Config: llm.agents.context_window
    3. Default: 128000 tokens

    Args:
        db: Optional database session for context_window lookup from model_provider_models
        agent_type: Optional agent type for model overrides (e.g., "strategy_router", "synthesis")

    Returns:
        AgentModelConfig with provider, model, API key, api_base, and context_window
    """
    config = get_resolved_config()
    agents_config = config.get("llm", {}).get("agents", {})

    # Default values from config.yaml
    default_provider = agents_config.get("default_provider", "openai")
    default_model = agents_config.get("default_model", "gpt-4o-mini")
    default_context_window = agents_config.get("context_window", 128000)
    api_base = None

    # 1. Check environment variables (highest priority)
    env_provider = os.environ.get("AGENT_PROVIDER_TYPE")
    env_model = os.environ.get("AGENT_MODEL_NAME")

    if env_provider and env_model:
        provider = env_provider
        model = env_model
        logger.info("Using agent model from environment: %s:%s", provider, model)
    else:
        # 2. Check database server_settings
        db_config = _get_db_agent_config()
        if db_config and db_config.get("provider_type") and db_config.get("model_name"):
            # Two-model "Scrapalot AI": the answer-generating roles (synthesis +
            # the model reflection) can run on a SEPARATE provider/model/key from
            # the tool-calling agents — e.g. gpt-4o-mini for agents (reliable tool
            # calls) and DeepSeek for synthesis. The optional "synthesis" sub-config
            # overrides provider/model/key/base for those roles only.
            role_config = db_config
            if agent_type in SYNTHESIS_AGENT_TYPES and isinstance(db_config.get("synthesis"), dict):
                syn = db_config["synthesis"]
                if syn.get("provider_type") and syn.get("model_name"):
                    role_config = syn
                    logger.info("Using SYNTHESIS model config for agent '%s'", agent_type)

            provider = role_config["provider_type"]
            model = role_config["model_name"]
            api_base = role_config.get("api_base") or None
            logger.info("Using agent model from database: %s:%s", provider, model)

            # Agent-specific model-name override (base agent config only — the
            # synthesis sub-config already specifies its own model).
            if agent_type and role_config is db_config:
                db_overrides = db_config.get("model_overrides", {})
                if override_model := db_overrides.get(agent_type):
                    model = override_model
                    logger.debug("Using DB model override for agent '%s': %s", agent_type, override_model)

            # Get API key: prefer the role config, then env/secrets
            api_key: str | None = role_config.get("api_key") or _get_api_key_for_provider(provider)
            # noinspection PyTypeChecker
            context_window = _get_context_window_for_model(db, provider, model, default_context_window)

            # noinspection PyTypeChecker
            return AgentModelConfig(
                provider_type=provider,
                model_name=model,
                api_key=api_key,
                api_base=api_base,
                context_window=context_window,
                provider_version=_get_provider_version(provider),
            )
        else:
            # 3. Fall back to config.yaml defaults
            provider = default_provider
            model = default_model
            logger.debug("Using agent model from config: %s:%s", provider, model)

    # Check for agent-specific model override from config.yaml
    if agent_type:
        model_overrides = agents_config.get("model_overrides", {})
        if override_model := model_overrides.get(agent_type):
            model = override_model
            logger.debug("Using config model override for agent '%s': %s", agent_type, override_model)

    # Get API key for the provider
    api_key = _get_api_key_for_provider(provider)

    # Get context_window from database if available
    context_window = _get_context_window_for_model(db, provider, model, default_context_window)

    return AgentModelConfig(
        provider_type=provider,
        model_name=model,
        api_key=api_key,
        api_base=api_base,
        context_window=context_window,
        provider_version=_get_provider_version(provider),
    )


def _get_api_key_for_provider(provider_type: str) -> str | None:
    """
    Get API key for a specific LLM provider from the database.

    The single source of truth is server_settings (key: system_agent_config),
    configured via the admin UI under Settings > General > System AI Agent Provider.

    Args:
        provider_type: Provider type (openai, anthropic, google, etc.)

    Returns:
        API key if found, None otherwise
    """
    db_config = _get_db_agent_config()
    if db_config and db_config.get("api_key"):
        # Return the key if provider matches OR if it's the only configured provider
        if db_config.get("provider_type", "").lower() == provider_type.lower():
            logger.debug("API key for %s loaded from database", provider_type)
            return db_config["api_key"]

    # Fallback: try model_providers table (system provider like "Scrapalot AI")
    try:
        from src.main.config.database import SessionLocal
        from src.main.models.sqlmodel_providers import ModelProvider

        fallback_db = SessionLocal()
        try:
            system_provider = (
                fallback_db.query(ModelProvider)
                .filter(
                    ModelProvider.provider_type == "system",
                )
                .first()
            )
            if system_provider and system_provider.api_key:
                logger.info("API key for %s loaded from system model_provider: %s", provider_type, system_provider.name)
                return system_provider.api_key
        finally:
            fallback_db.close()
    except Exception as e:
        logger.debug("Could not load API key from model_providers: %s", str(e))

    logger.warning(
        "No API key found for provider %s in database. Configure it via Settings > General > System AI Agent Provider.",
        provider_type,
    )
    return None


def _get_context_window_for_model(
    db,
    provider_type: str,
    model_name: str,
    default_context_window: int,
) -> int:
    """
    Get context window for a model from database or use default.

    Priority:
    1. Database: model_provider_models.context_window
    2. Default from config

    Args:
        db: Database session (can be None)
        provider_type: Provider type (openai, anthropic, etc.)
        model_name: Model name (gpt-4o-mini, claude-sonnet-4, etc.)
        default_context_window: Default context window from config

    Returns:
        Context window in tokens
    """
    if db is None:
        logger.debug("No db session provided, using default context_window: %d", default_context_window)
        return default_context_window

    try:
        from src.main.models.sqlmodel_providers import ModelProvider, ModelProviderModel

        # Look up model in database
        model_record = (
            db.query(ModelProviderModel)
            .join(ModelProvider, ModelProviderModel.provider_id == ModelProvider.id)
            .filter(
                ModelProvider.provider_type == provider_type,
                ModelProviderModel.model_name == model_name,
            )
            .first()
        )

        if model_record and model_record.context_window:
            logger.debug(
                "Found context_window=%d for %s:%s in database",
                model_record.context_window,
                provider_type,
                model_name,
            )
            return model_record.context_window

        logger.debug(
            "No context_window found in database for %s:%s, using default: %d",
            provider_type,
            model_name,
            default_context_window,
        )
        return default_context_window

    except Exception as e:
        logger.warning("Error looking up context_window from database: %s", str(e))
        return default_context_window


def get_agent_model_string(
    _db=None,  # Kept for backwards compatibility but NOT used
    agent_type: str | None = None,
) -> str:
    """
    Get the Pydantic AI model string for agents.

    Convenience function that returns just the model string for Pydantic AI.

    Args:
        _db: Deprecated, kept for backwards compatibility (not used)
        agent_type: Optional agent type for model overrides

    Returns:
        Model string formatted for Pydantic AI (e.g., "openai:gpt-4o-mini")
    """
    config = get_system_agent_model(agent_type=agent_type)
    return config.get_pydantic_ai_model_string()


def get_agent_api_key(
    _db=None,  # Kept for backwards compatibility but NOT used
    provider_type: str | None = None,
) -> str | None:
    """
    Get the API key for agents.

    Args:
        _db: Deprecated, kept for backwards compatibility (not used)
        provider_type: Optional provider type override

    Returns:
        API key if found, None otherwise
    """
    if not provider_type:
        config = get_system_agent_model()
        provider_type = config.provider_type

    return _get_api_key_for_provider(provider_type or "")
