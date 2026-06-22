"""LLM Factory Module

This module provides factory functions for creating Language Learning Model (LLM) instances
from various providers like OpenAI, Anthropic, Google, Ollama, and local models.

The factory handles:
- Provider-specific configuration and authentication
- User-specific model providers and API keys
- Model availability checking and validation
- Dynamic loading of different LLM implementations
"""

import asyncio
from collections.abc import Callable
from functools import lru_cache
import inspect
import os
from typing import Any, cast

# HTTPException is optional - workers use standard exceptions
try:
    from fastapi import HTTPException
except ImportError:
    # Fallback for workers without fastapi
    class HTTPException(Exception):
        """Fallback HTTP exception for workers without fastapi"""

        def __init__(self, status_code: int = 500, detail: str = ""):
            self.status_code = status_code
            self.detail = detail
            super().__init__(detail)


import httpx
from langchain_community.callbacks import get_openai_callback
from langchain_core.language_models import BaseChatModel

# Handle optional openai import - workers may not need it
try:
    import openai
except ImportError:
    openai = None  # Will be checked at runtime if needed

# Handle optional langchain provider imports - workers may not have all providers
try:
    from langchain_google_genai import ChatGoogleGenerativeAI
except ImportError:

    class ChatGoogleGenerativeAI:
        """Placeholder for ChatGoogleGenerativeAI when not installed"""


try:
    from langchain_ollama.chat_models import ChatOllama
    from langchain_ollama.llms import OllamaLLM
except ImportError:

    class ChatOllama:
        """Placeholder for ChatOllama when not installed"""

    class OllamaLLM:
        """Placeholder for OllamaLLM when not installed"""


try:
    from langchain_openai import ChatOpenAI
except ImportError:

    class ChatOpenAI:
        """Placeholder for ChatOpenAI when not installed"""


from pydantic import SecretStr
from sqlalchemy import and_, text
from sqlalchemy.orm import Session

from src.main.models.sqlmodel_providers import ModelProvider
from src.main.service.llm.llm_embedding_factory import (
    get_embeddings,
    get_embeddings_async,
)
from src.main.utils.config.loader import get_model_config, resolved_config
from src.main.utils.core.logger import get_logger
from src.main.utils.llm.model_utils import get_api_key, get_ollama_base_url

from .token_metrics import TokenMetricsTracker
from .token_metrics_callback import TokenMetricsCallback

# Handle potential import error with langchain_anthropic
try:
    from langchain_anthropic import ChatAnthropic
except ImportError:

    class ChatAnthropic:
        def __init__(self, *args, **kwargs):
            raise ImportError("ChatAnthropic could not be imported") from None


logger = get_logger(__name__)


def _get_model_temperature(model_name: str, requested_temp: float = 0.1) -> float:
    """
    Determine the appropriate temperature for a model.

    Some models (like gpt-5-* and reasoning models) only support the default temperature (1.0)
    and will return 400 errors if custom values are provided.

    Args:
        model_name: The name of the model
        requested_temp: The requested temperature value (default 0.1)

    Returns:
        The appropriate temperature value for the model
    """
    if not isinstance(model_name, str):
        model_name = getattr(model_name, "model_name", "") or "unknown"
    model_lower = model_name.lower()

    # Models that only support default temperature (1.0)
    # GPT-5 models and reasoning models don't support custom temperature
    temperature_restricted_patterns = [
        "gpt-5",  # GPT-5 series
        "o1-",  # OpenAI o1 reasoning models
        "o3-",  # OpenAI o3 reasoning models (if released)
    ]

    for pattern in temperature_restricted_patterns:
        if pattern in model_lower:
            logger.debug(
                "Model %s only supports default temperature (1.0), ignoring requested value %s",
                model_name,
                requested_temp,
            )
            return 1.0

    return requested_temp


# Exported functions
__all__ = [
    "get_embeddings",
    "get_embeddings_async",
    "get_embeddings_model",
    "get_embeddings_model_async",
    "get_llm",
    "get_llm_model",
]

# Type aliases for better readability
ProviderConfig = dict[str, Any]
ModelConfig = dict[str, Any]
ProviderFactory = Callable[..., BaseChatModel]


class LLMFactoryError(Exception):
    """Custom exception for LLM factory errors."""


@lru_cache(maxsize=128)
def _get_cached_provider_type(provider_type: str | None) -> str:
    """Cache provider type normalization for performance."""
    return (provider_type or "local").lower()


def _safe_run_coroutine(coro) -> Any:
    """Safely run a coroutine in any context with modern Python patterns."""
    if not inspect.iscoroutine(coro):
        logger.debug("Object is not a coroutine, returning as is")
        return coro

    try:
        if (loop := asyncio.get_event_loop()).is_running():
            logger.debug("Creating task for coroutine (event loop is running)")
            if (task := asyncio.ensure_future(coro)).done():
                return task.result()
            return task
        return loop.run_until_complete(coro)
    except RuntimeError:
        return asyncio.new_event_loop().run_until_complete(coro)


async def get_llm(
    model_name: str,
    provider_type: str | None = None,
    db: Session | None = None,
    user_id: str | None = None,
    message_id: str | None = None,
    enable_metrics: bool = True,
    **kwargs,
) -> BaseChatModel:
    """
    Factory function to get an LLM instance based on the model name and provider.
    Handles user-specific providers from the database.

    Args:
        model_name: The name of the model to use (e.g., "gpt-4o-mini", "llama3.1:8b").
                   This should be a human-readable model name, NOT a UUID.
        provider_type: Optional name of the provider (e.g., "openai", "ollama", user-defined name).
        db: Optional database session for retrieving API keys / endpoints.
        user_id: Optional user ID for user - specific settings.
        message_id: Optional message ID for token metrics tracking.
        enable_metrics: Whether to enable token metrics tracking (default: True).
        **kwargs: Additional keyword arguments to pass to the model.

    Returns:
        An instance of a BaseChatModel.
    """
    original_provider_type = provider_type
    user_provider_config = None

    # Get user provider configuration if available
    if db and user_id:
        try:
            user_provider_config, model_name = await _find_user_model_config(db, user_id, model_name, provider_type)

            if not user_provider_config and provider_type:
                user_provider_config = await _find_user_provider_config(db, user_id, provider_type, original_provider_type)

            # Only fall back to default provider if NO provider type was specified
            # If user explicitly requested a provider that doesn't exist, that's an error
            if not user_provider_config and not provider_type:
                user_provider_config = await _find_default_active_provider(db, user_id)
            elif not user_provider_config and provider_type:
                # User requested a specific provider, but it wasn't found - don't fall back
                logger.error("Requested provider '%s' not found or not active for user %s", provider_type, user_id)
                raise ValueError(
                    f"Provider '{provider_type}' is not active or configured. "
                    f"Please activate the provider in settings or choose a different provider."
                )

        except Exception as ex:
            logger.error("Error fetching user provider config: %s", ex)
            # Roll back the transaction if it's in a failed state
            try:
                db.rollback()
                logger.info("Database transaction rolled back due to error")
            except Exception as rollback_ex:
                logger.warning("Failed to rollback transaction: %s", rollback_ex)

    elif db and provider_type == "system":
        # Handle system provider without user_id
        try:
            # noinspection PyTypeChecker
            user_provider_config = await _find_user_provider_config(db, None, str(provider_type), original_provider_type)
            if not user_provider_config:
                logger.error("System AI provider configuration not found in database. Please configure it via UI Settings.")
                raise ValueError("System AI provider configuration not found in database. Please configure it via UI Settings.")

        except Exception as ex:
            logger.error("Error fetching system provider config: %s", ex)
            # Roll back the transaction if it's in a failed state
            try:
                db.rollback()
                logger.info("Database transaction rolled back due to error")
            except Exception as rollback_ex:
                logger.warning("Failed to rollback transaction: %s", rollback_ex)

    # Determine provider type using modern Python patterns
    provider_type = _determine_provider_type(user_provider_config, provider_type)

    # Set db and user_id in kwargs for API key retrieval
    if db:
        kwargs["db"] = db
    if user_id:
        kwargs["user_id"] = user_id

    try:
        # Create an LLM instance using a factory pattern
        llm_instance = await _create_llm_instance(
            provider_type or "local",
            model_name,
            user_provider_config,
            original_provider_type,
            **kwargs,
        )

        # Add token metrics callback if enabled
        if enable_metrics and db and message_id:
            metrics_tracker = TokenMetricsTracker()
            is_system_provider = user_provider_config.get("user_id") is None if user_provider_config else (user_id is None)
            callback = TokenMetricsCallback(
                metrics_tracker=metrics_tracker,
                db=db,
                provider=provider_type or "local",
                model=model_name,
                message_id=message_id,
                user_id=user_id,
                is_system_provider=is_system_provider,
            )

            # For OpenAI providers, wrap with get_openai_callback to capture real costs
            if provider_type == "openai":
                # Store reference to get_openai_callback for cost extraction
                callback._openai_callback = get_openai_callback()
                # The callback will be used during LLM invocation to capture costs

            # Add callback to the LLM instance
            if hasattr(llm_instance, "callbacks"):
                if llm_instance.callbacks is None:
                    llm_instance.callbacks = []
                # noinspection PyUnresolvedReferences
                llm_instance.callbacks.append(callback)
            else:
                llm_instance.callbacks = [callback]

        return llm_instance
    except Exception as e:
        logger.warning("Error initializing LLM (%s): %s", model_name, str(e))
        raise HTTPException(status_code=500, detail=f"Error initializing LLM: {e!s}") from e


async def _find_user_model_config(db: Session, user_id: str, model_name: str, provider_type: str | None) -> tuple[ProviderConfig | None, str]:
    """Find user model configuration with exact model matching."""
    # Check if model_name looks like a UUID (36 chars with 4 hyphens)
    is_uuid_format = model_name and len(model_name) == 36 and model_name.count("-") == 4

    if is_uuid_format:
        # If it's a UUID format, search by m.id (SQLite compatible - no casting needed)
        exact_model_query = """
            SELECT p.id, p.provider_type, p.api_base, p.api_key, p.status, p.show_models, m.model_name, m.model_type, p.user_id
            FROM model_providers p
            JOIN model_provider_models m ON p.id = m.provider_id
            WHERE (p.user_id = :user_id OR p.user_id IS NULL) AND p.status = 'active'
            AND (m.id = :model_name OR m.model_name = :model_name OR m.display_name = :model_name)
            AND m.model_type != 'EMBEDDING'
            AND (:provider_type IS NULL OR p.provider_type = :provider_type OR p.name = :provider_type)
            ORDER BY p.user_id DESC NULLS LAST, p.updated_at DESC LIMIT 1
        """
    else:
        # If it's not a UUID format, search by model_name or display_name
        exact_model_query = """
            SELECT p.id, p.provider_type, p.api_base, p.api_key, p.status, p.show_models, m.model_name, m.model_type, p.user_id
            FROM model_providers p
            JOIN model_provider_models m ON p.id = m.provider_id
            WHERE (p.user_id = :user_id OR p.user_id IS NULL) AND p.status = 'active'
            AND (m.model_name = :model_name OR m.display_name = :model_name)
            AND m.model_type != 'EMBEDDING'
            AND (:provider_type IS NULL OR p.provider_type = :provider_type OR p.name = :provider_type)
            ORDER BY p.user_id DESC NULLS LAST, p.updated_at DESC LIMIT 1
        """

    try:
        logger.debug(
            "Searching for model: user_id=%s, model_name=%s, provider_type=%s",
            user_id,
            model_name,
            provider_type,
        )
        if exact_match := db.execute(
            text(exact_model_query),
            {
                "user_id": user_id,
                "model_name": model_name,
                "provider_type": provider_type,
            },
        ).first():
            actual_model_name = exact_match[6]
            model_type = exact_match[7]

            logger.info(
                "Found exact model match: UUID=%s, actual_model=%s",
                model_name,
                actual_model_name,
            )
            logger.info("Model type: %s", model_type)
            logger.debug("Provider API key present: %s", bool(exact_match[3]))

            config = {
                "id": exact_match[0],
                "provider_type": exact_match[1],
                "api_base": exact_match[2],
                "api_key": exact_match[3],
                "status": exact_match[4],
                "show_models": exact_match[5],
                "user_id": exact_match[8],
            }
            return config, actual_model_name
        else:
            logger.warning(
                "No model found for user_id=%s, model_name=%s, provider_type=%s",
                user_id,
                model_name,
                provider_type,
            )
    except Exception as e:
        logger.error("Database error in _find_user_model_config: %s", str(e))
        try:
            db.rollback()
            logger.info("Database transaction rolled back in _find_user_model_config")
        except Exception as rollback_ex:
            logger.warning(
                "Failed to rollback transaction in _find_user_model_config: %s",
                rollback_ex,
            )

    return None, model_name


async def _find_user_provider_config(db: Session, user_id: str, provider_type: str, original_provider_type: str | None) -> ProviderConfig | None:
    """Find user provider configuration by type or name."""
    try:
        from sqlalchemy import or_

        # Special handling for "system" provider_type
        # The system provider is identified by user_id IS NULL AND provider_type = 'system'
        if provider_type == "system":
            # noinspection PyTypeChecker,PyUnresolvedReferences
            provider_obj = (
                db.query(ModelProvider)
                .filter(
                    and_(
                        ModelProvider.user_id.is_(None),
                        ModelProvider.provider_type == "system",
                        ModelProvider.status == "active",
                    )
                )
                .first()
            )
            if provider_obj:
                logger.info(
                    "Found system provider: %s (Type: %s)",
                    provider_obj.name,
                    provider_obj.provider_type,
                )
                return {
                    "id": str(provider_obj.id),
                    "provider_type": provider_obj.provider_type,
                    "api_base": provider_obj.api_base,
                    "api_key": provider_obj.api_key,
                    "status": provider_obj.status,
                    "show_models": provider_obj.show_models,
                    "user_id": None,
                }
            return None

        for field, value in [
            (ModelProvider.provider_type, provider_type),
            (ModelProvider.name, provider_type),
        ]:
            # For system-wide providers (local, ollama, vllm, lmstudio), check user_id OR NULL
            # For other providers, only check user_id
            if provider_type in ["local", "ollama", "vllm", "lmstudio"]:
                # noinspection PyTypeChecker,PyUnresolvedReferences
                provider_obj = (
                    db.query(ModelProvider)
                    .filter(
                        and_(
                            or_(
                                ModelProvider.user_id == user_id,
                                ModelProvider.user_id.is_(None),
                            ),
                            field == value,
                            ModelProvider.status == "active",
                        )
                    )
                    .first()
                )
            else:
                # For cloud providers, check user-specific first, then fall back to system-wide
                # noinspection PyTypeChecker,PyUnresolvedReferences
                provider_obj = (
                    db.query(ModelProvider)
                    .filter(
                        and_(
                            or_(
                                ModelProvider.user_id == user_id,
                                ModelProvider.user_id.is_(None),
                            ),
                            field == value,
                            ModelProvider.status == "active",
                        )
                    )
                    .first()
                )

            if provider_obj:
                logger.info(
                    "Found provider: %s (Type: %s, User-specific: %s)",
                    provider_obj.name,
                    provider_obj.provider_type,
                    provider_obj.user_id is not None,
                )
                return {
                    "id": provider_obj.id,
                    "provider_type": provider_obj.provider_type,
                    "api_base": provider_obj.api_base,
                    "api_key": provider_obj.api_key,
                    "status": provider_obj.status,
                    "show_models": provider_obj.show_models,
                    "user_id": provider_obj.user_id,
                }
    except Exception as e:
        logger.error("Database error in _find_user_provider_config: %s", str(e))
        try:
            db.rollback()
            logger.info("Database transaction rolled back in _find_user_provider_config")
        except Exception as rollback_ex:
            logger.warning(
                "Failed to rollback transaction in _find_user_provider_config: %s",
                rollback_ex,
            )
        return None

    # Only allow fallback for local model providers (local, ollama, lmstudio, vllm)
    # For cloud providers (openai, anthropic, google, etc.) and system provider, raise an error
    if original_provider_type not in ["local", "ollama", "lmstudio", "vllm"]:
        safe_provider = original_provider_type or "unknown"
        logger.error(
            "Requested provider '%s' is not active or doesn't exist. No fallback allowed for this provider type.",
            safe_provider,
        )
        raise ValueError(
            f"Provider '{safe_provider}' is not active or configured. Please activate the provider in settings or choose a different provider."
        )

    return None


async def _find_default_active_provider(db: Session, user_id: str) -> ProviderConfig | None:
    """Find any active provider with models as fallback."""
    active_provider_query = """
        SELECT p.id, p.provider_type, p.api_base, p.api_key, p.status, p.show_models
        FROM model_providers p
        WHERE p.user_id = :user_id AND p.status = 'active'
        AND EXISTS (SELECT 1 FROM model_provider_models m WHERE m.provider_id = p.id AND m.model_type != 'EMBEDDING')
        ORDER BY p.updated_at DESC LIMIT 1
    """

    try:
        if active_provider := db.execute(text(active_provider_query), {"user_id": user_id}).first():
            logger.info("Using user's default active provider: %s", active_provider[1])
            return {
                "id": active_provider[0],
                "provider_type": active_provider[1],
                "api_base": active_provider[2],
                "api_key": active_provider[3],
                "status": active_provider[4],
                "show_models": active_provider[5],
                "user_id": user_id,
            }
    except Exception as e:
        logger.error("Database error in _find_default_active_provider: %s", str(e))
        try:
            db.rollback()
            logger.info("Database transaction rolled back in _find_default_active_provider")
        except Exception as rollback_ex:
            logger.warning(
                "Failed to rollback transaction in _find_default_active_provider: %s",
                rollback_ex,
            )

    return None


def _filter_provider_kwargs(kwargs: dict, excluded_keys: list | None = None) -> dict:
    """Filter out internal kwargs and provider-specific excluded keys."""
    default_excluded = [
        "db",
        "user_id",
        "temperature",
        "timeout",
        "max_retries",
        "streaming",
        "subscription_tier",
        "estimated_tokens",
        "system_provider_config",
    ]
    if excluded_keys:
        default_excluded.extend(excluded_keys)

    return {k: v for k, v in kwargs.items() if k not in default_excluded}


def _determine_provider_type(user_provider_config: ProviderConfig | None, provider_type: str | None) -> str:
    """Determine the final provider type using walrus operator for efficiency."""
    if user_provider_config and (config_type := user_provider_config.get("provider_type")):
        logger.info("Using provider type from user config: %s", config_type)
        # noinspection PyUnresolvedReferences
        return str(config_type).lower()

    # If we have an explicit provider_type passed in, use it instead of defaulting to 'local'
    if provider_type:
        final_type = provider_type.lower()
        logger.info("Using explicit provider type: %s", final_type)
        return final_type

    # Only fall back to cached/default logic if no provider_type is specified
    final_type = _get_cached_provider_type(provider_type)
    logger.info("Using default provider type: %s", final_type)
    return final_type


async def _create_llm_instance(
    provider_type: str,
    model_name: str,
    user_provider_config: ProviderConfig | None,
    original_provider_type: str | None,
    **kwargs,
) -> BaseChatModel:
    """Create LLM instance using a factory pattern with provider-specific handlers."""
    # Define sync factories (return LLM instances directly)
    sync_factories = {
        "openai": lambda: _create_openai_instance(model_name, **kwargs),
        "anthropic": lambda: _create_anthropic_instance(model_name, **kwargs),
        "google": lambda: _create_google_instance(model_name, **kwargs),
        "openrouter": lambda: _create_openrouter_instance(model_name, user_provider_config, **kwargs),
        "groq": lambda: _create_groq_instance(model_name, user_provider_config, **kwargs),
        "deepseek": lambda: _create_deepseek_instance(model_name, user_provider_config, **kwargs),
        "ollama": lambda: _create_ollama_instance(model_name, user_provider_config, **kwargs),
        "lmstudio": lambda: _create_lmstudio_instance(model_name, user_provider_config, **kwargs),
        "system": lambda: _create_system_instance(model_name, user_provider_config, **kwargs),
    }

    # Define async factories (return coroutines that need to be awaited)
    async_factories = {
        "vllm": lambda: _create_vllm_instance(model_name, user_provider_config, **kwargs),
        "local": lambda: _create_local_instance(model_name, **kwargs),
    }

    # Try sync factories first
    if factory := sync_factories.get(provider_type):
        return factory()

    # Then try async factories
    if factory := async_factories.get(provider_type):
        return await factory()

    safe_provider = original_provider_type or "local"
    raise ValueError(f"Unsupported or unknown provider type: {safe_provider}")


def _create_openai_instance(model_name: str, **kwargs) -> ChatOpenAI:
    """Create an OpenAI chat instance with API key validation and streaming usage tracking.

    Note: Only chat-compatible models are synced from OpenAI API. Completion/instruct models
    are filtered out during model sync in remote_model_sync.py, so we only use ChatOpenAI here.
    """
    # Check if this is being called from the system provider
    provider_type = kwargs.get("provider_type")
    api_key = None

    # If called from system provider, get API key from system_provider_config
    if provider_type == "system":
        if system_provider_config := kwargs.get("system_provider_config"):
            # noinspection PyUnresolvedReferences
            api_key = system_provider_config.get("api_key")
            if not api_key:
                raise ValueError("System provider configuration is missing API key")
            logger.info("Using OpenAI API key from system provider configuration")
        else:
            raise ValueError("System provider called but system_provider_config is missing")

    # If not from system provider or no API key yet, use regular lookup
    if not api_key:
        api_key = get_api_key("openai", kwargs.get("db"), kwargs.get("user_id"))
        if not api_key:
            raise ValueError("OpenAI API key is missing")

    # Exclude base_url and api_base - OpenAI always uses official endpoint
    filtered_kwargs = _filter_provider_kwargs(kwargs, excluded_keys=["base_url", "api_base", "provider_type", "system_provider_config"])

    # Get appropriate temperature for this model (some models only support default)
    requested_temp = kwargs.get("temperature", 0.1)
    temperature = _get_model_temperature(model_name, requested_temp)

    # Import enhanced retry utility
    from src.main.utils.llm.openai_retry import create_openai_with_enhanced_retry

    # Create an OpenAI instance with enhanced retry configuration
    # Uses the OpenAI SDK's built-in retry with exponential backoff
    return create_openai_with_enhanced_retry(
        model_name=model_name,
        api_key=SecretStr(api_key),
        temperature=temperature,
        timeout=kwargs.get("timeout", 120.0),  # 120 second timeout for connection attempts
        disable_streaming=not kwargs.get("streaming", True),
        stream_usage=True,  # Enable streaming token usage tracking
        **filtered_kwargs,
    )


def _create_anthropic_instance(model_name: str, **kwargs) -> ChatAnthropic:
    """Create Anthropic chat instance with API key validation.

    Standard LangChain usage - just pass the API key to ChatAnthropic.
    Anthropic always uses the official API endpoint (api.anthropic.com).
    """
    # Check if this is being called from the system provider
    provider_type = kwargs.get("provider_type")
    api_key = None

    # If called from system provider, get API key from system_provider_config
    if provider_type == "system":
        if system_provider_config := kwargs.get("system_provider_config"):
            # noinspection PyUnresolvedReferences
            api_key = system_provider_config.get("api_key")
            if not api_key:
                raise ValueError("System provider configuration is missing API key")
            logger.info("Using Anthropic API key from system provider configuration")
        else:
            raise ValueError("System provider called but system_provider_config is missing")

    # If not from system provider, use regular lookup
    if not api_key:
        api_key = get_api_key("anthropic", kwargs.get("db"), kwargs.get("user_id"))
        if not api_key:
            raise ValueError("Anthropic API key is missing")

    # Exclude base_url and api_base - Anthropic always uses official endpoint
    filtered_kwargs = _filter_provider_kwargs(kwargs, excluded_keys=["base_url", "api_base", "provider_type", "system_provider_config"])

    # Standard LangChain ChatAnthropic initialization
    return ChatAnthropic(
        model_name=model_name,
        api_key=SecretStr(api_key),
        temperature=kwargs.get("temperature", 0.1),
        timeout=kwargs.get("timeout", 60.0),
        max_retries=kwargs.get("max_retries", 3),
        **filtered_kwargs,
    )


def _create_google_instance(model_name: str, **kwargs) -> ChatGoogleGenerativeAI:
    """Create Google Generative AI chat instance with API key validation."""
    # Check if this is being called from the system provider
    provider_type = kwargs.get("provider_type")
    api_key = None

    # If called from system provider, get API key from system_provider_config
    if provider_type == "system":
        if system_provider_config := kwargs.get("system_provider_config"):
            # noinspection PyUnresolvedReferences
            api_key = system_provider_config.get("api_key")
            if not api_key:
                raise ValueError("System provider configuration is missing API key")
            logger.info("Using Google API key from system provider configuration")
        else:
            raise ValueError("System provider called but system_provider_config is missing")

    # If not from system provider or no API key yet, use regular lookup
    if not api_key:
        api_key = get_api_key("google", kwargs.get("db"), kwargs.get("user_id"))
        if not api_key:
            raise ValueError("Google API key is missing")

    # Exclude base_url and api_base - Google always uses official endpoint
    filtered_kwargs = _filter_provider_kwargs(kwargs, excluded_keys=["base_url", "api_base", "provider_type", "system_provider_config"])

    return ChatGoogleGenerativeAI(
        model=model_name,
        api_key=SecretStr(api_key),
        temperature=kwargs.get("temperature", 0.1),
        timeout=kwargs.get("timeout", 60.0),
        max_retries=kwargs.get("max_retries", 3),
        disable_streaming=not kwargs.get("streaming", True),
        **filtered_kwargs,
    )


def _create_openrouter_instance(model_name: str, user_provider_config: ProviderConfig | None, **kwargs) -> ChatOpenAI:
    """Create OpenRouter chat instance with reasoning support and optimized initialization."""
    base_url = "https://openrouter.ai/api/v1"

    if user_provider_config and (api_key := user_provider_config.get("api_key")):
        if custom_base := user_provider_config.get("api_base"):
            base_url = custom_base
        logger.info("Using OpenRouter API key from user provider config")
    elif not (api_key := get_api_key("openrouter", kwargs.get("db"), kwargs.get("user_id"))):
        raise ValueError("OpenRouter API key is missing")
    else:
        logger.info("Using OpenRouter API key from global config")

    model_kwargs = {}
    # Note: OpenRouter reasoning models don't need special parameters in the OpenAI client
    # The reasoning capability is handled server-side by OpenRouter and detected via <think> tags
    logger.info("OpenRouter model: %s (reasoning detection via content analysis)", model_name)

    filtered_kwargs = _filter_provider_kwargs(
        kwargs,
        excluded_keys=["http_referer", "x_title", "api_key", "base_url", "model"],
    )

    # Create an optimized HTTP client for faster initialization
    import httpx

    http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(10.0),  # 10-second timeout for initialization
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        follow_redirects=True,
    )

    # Optimize initialization parameters to reduce delay
    return ChatOpenAI(
        model=model_name,
        api_key=SecretStr(api_key),
        base_url=base_url,
        temperature=kwargs.get("temperature", 0.1),
        timeout=kwargs.get("timeout", 60.0),
        max_retries=kwargs.get("max_retries", 3),
        disable_streaming=not kwargs.get("streaming", True),
        model_kwargs=model_kwargs,
        default_headers={
            "HTTP-Referer": kwargs.get("http_referer", "https://scrapalot.app"),
            "X-Title": kwargs.get("x_title", "scrapalot-chat"),
        },
        # Use an optimized HTTP client for faster initialization
        http_async_client=http_client,
        **filtered_kwargs,
    )


def _create_ollama_instance(model_name: str, user_provider_config: ProviderConfig | None, **kwargs) -> ChatOllama:
    """Create Ollama chat instance with base URL configuration.

    Supports both local Ollama and Ollama Cloud (https://ollama.com).
    For Ollama Cloud, the API key is sent as a Bearer token in the Authorization header.
    """
    if model_name.lower().startswith("ollama:"):
        model_name = model_name[7:]

    base_url = get_ollama_base_url(user_provider_config)
    logger.info("Using Ollama endpoint: %s", base_url)

    # Filter out internal kwargs and unsupported parameters (timeout, max_retries not supported)
    clean_kwargs = _filter_provider_kwargs(kwargs, excluded_keys=["base_url"])

    # Ollama Cloud requires Bearer token authentication
    api_key = user_provider_config.get("api_key") if user_provider_config else None
    if api_key and "ollama.com" in base_url.lower():
        clean_kwargs["headers"] = {"Authorization": f"Bearer {api_key}"}

    return ChatOllama(
        model=model_name,
        base_url=base_url,
        keep_alive="1h",
        temperature=kwargs.get("temperature", 0.1),
        disable_streaming=not kwargs.get("streaming", True),
        **clean_kwargs,
    )


def _create_groq_instance(model_name: str, user_provider_config: ProviderConfig | None, **kwargs) -> ChatOpenAI:
    """Create Groq chat instance using OpenAI-compatible API."""
    if model_name.lower().startswith("groq:"):
        model_name = model_name[5:]

    api_key = user_provider_config.get("api_key") if user_provider_config else None
    if not api_key:
        api_key = os.environ.get("GROQ_API_KEY", "")

    base_url = "https://api.groq.com/openai/v1"
    if user_provider_config and user_provider_config.get("api_base"):
        base_url = user_provider_config["api_base"]

    logger.info("Using Groq endpoint: %s", base_url)

    clean_kwargs = _filter_provider_kwargs(kwargs, excluded_keys=["base_url", "api_key"])

    return ChatOpenAI(
        model=model_name,
        api_key=SecretStr(str(api_key)) if api_key else None,
        base_url=base_url,
        temperature=kwargs.get("temperature", 0.1),
        streaming=kwargs.get("streaming", True),
        **clean_kwargs,
    )


def _create_deepseek_instance(model_name: str, user_provider_config: ProviderConfig | None = None, **kwargs) -> ChatOpenAI:
    """Create a DeepSeek chat instance (OpenAI-compatible API with a custom base URL).

    Works both for a directly-typed ``deepseek`` provider and for the system
    provider whose underlying sub-provider is DeepSeek (config arrives via
    ``system_provider_config`` in kwargs).
    """
    cfg = kwargs.get("system_provider_config") or user_provider_config or {}
    api_key = cfg.get("api_key") or get_api_key("deepseek", kwargs.get("db"), kwargs.get("user_id"))
    if not api_key:
        raise ValueError("DeepSeek API key is missing")

    base_url = (cfg.get("api_base") or "https://api.deepseek.com").rstrip("/")
    logger.info("Using DeepSeek endpoint: %s", base_url)

    temperature = _get_model_temperature(model_name, kwargs.get("temperature", 0.1))
    clean_kwargs = _filter_provider_kwargs(
        kwargs,
        excluded_keys=["base_url", "api_base", "api_key", "provider_type", "system_provider_config"],
    )

    return ChatOpenAI(
        model=model_name,
        api_key=SecretStr(str(api_key)),
        base_url=base_url,
        temperature=temperature,
        timeout=kwargs.get("timeout", 120.0),
        disable_streaming=not kwargs.get("streaming", True),
        stream_usage=True,
        **clean_kwargs,
    )


def _create_lmstudio_instance(model_name: str, user_provider_config: ProviderConfig | None, **kwargs) -> ChatOpenAI:
    """Create LM Studio chat instance using OpenAI-compatible API."""
    # Get the base URL from user provider config
    base_url = "http://localhost:1234/v1"  # Default LM Studio endpoint

    if user_provider_config and user_provider_config.get("api_base"):
        base_url = user_provider_config["api_base"]
        # Ensure it ends with /v1 for LM Studio compatibility
        if not base_url.endswith("/v1"):
            base_url = base_url.rstrip("/") + "/v1"

    logger.info("Using LM Studio endpoint: %s", base_url)

    # Filter out internal kwargs and unsupported parameters
    clean_kwargs = _filter_provider_kwargs(kwargs, excluded_keys=["base_url", "api_key"])

    # LM Studio doesn't require an API key, but ChatOpenAI expects one
    # Use a dummy key to satisfy the requirement
    return ChatOpenAI(
        model=model_name,
        base_url=base_url,
        api_key=SecretStr("lm-studio"),  # Dummy API key for LM Studio
        temperature=kwargs.get("temperature", 0.1),
        timeout=30.0,  # 30 second timeout for connection attempts
        max_retries=1,  # Only retry once to fail fast when API is unreachable
        **clean_kwargs,
    )


def _create_system_instance(model_name: str, user_provider_config: ProviderConfig | None, **kwargs) -> BaseChatModel:
    """
    Create system AI chat instance using the provider configuration from database.

    This uses the provider_type, api_base, and api_key from the database configuration.
    The system provider is identified by user_id=NULL in the model_providers table.
    """
    # A resolved per-role config (server_settings.system_agent_config) takes
    # precedence over the model_providers card. This is how the answer-generating
    # roles (synthesis/reflection) run on DeepSeek while the card stays the base
    # provider — both come from the SAME single source of truth, resolved upstream
    # in LLMManager.get_llm by agent_type.
    override = kwargs.pop("system_provider_config_override", None)
    if override and override.get("provider_type") and override.get("api_key"):
        user_provider_config = override

    # Check if provider is active in database
    if not user_provider_config:
        raise ValueError("System AI provider configuration not found in database. Please configure it via UI Settings.")

    if user_provider_config.get("status") != "active":
        raise ValueError("System AI provider is not active. Please activate it via UI Settings.")

    # Get the provider type from database (e.g., "anthropic", "openai", etc.)
    provider_type = user_provider_config.get("provider_type", "anthropic")

    # Get the api_base from database configuration (optional for some providers like Anthropic)
    base_url = user_provider_config.get("api_base")

    # Get API key from database
    api_key = user_provider_config.get("api_key")

    logger.info(
        "Using System AI provider: %s (base_url: %s, has_api_key: %s)",
        provider_type,
        base_url if base_url else "default",
        bool(api_key),
    )

    # Create a provider config for the system provider
    system_provider_config = {
        "provider_type": provider_type,
        "api_base": base_url,
        "api_key": api_key,
        "status": "active",
        "show_models": True,
    }

    # Delegate to the appropriate provider handler based on database provider_type
    # Add system_provider_config to kwargs for all provider functions
    kwargs["system_provider_config"] = system_provider_config
    # Add provider_type to kwargs so handlers know they're called from system provider
    kwargs["provider_type"] = "system"

    if provider_type == "anthropic":
        return _create_anthropic_instance(model_name, **kwargs)
    elif provider_type == "openai":
        return _create_openai_instance(model_name, **kwargs)
    elif provider_type == "deepseek":
        return _create_deepseek_instance(model_name, **kwargs)
    elif provider_type == "google":
        return _create_google_instance(model_name, **kwargs)
    elif provider_type == "lmstudio":
        return _create_lmstudio_instance(model_name, **kwargs)
    elif provider_type == "ollama":
        return _create_ollama_instance(model_name, **kwargs)
    elif provider_type == "vllm":
        # vllm handler is async, so we need to handle it specially
        import asyncio

        # noinspection PyInvalidCast
        return cast(BaseChatModel, asyncio.create_task(_create_vllm_instance(model_name, **kwargs)))
    elif provider_type == "system":
        # For generic "system" provider type, auto-detect based on model name and API base
        # noinspection PyUnresolvedReferences
        api_base = base_url.lower() if base_url else ""

        # Detect provider type based on model name patterns
        if "claude" in model_name.lower():
            # Claude models -> Anthropic provider
            return _create_anthropic_instance(model_name, **kwargs)
        elif "gpt" in model_name.lower() or "o1" in model_name.lower():
            # GPT/OpenAI models -> OpenAI provider
            return _create_openai_instance(model_name, **kwargs)
        elif "gemini" in model_name.lower():
            # Gemini models -> Google provider
            return _create_google_instance(model_name, **kwargs)
        elif ":1234" in api_base or "lmstudio" in api_base:
            # LMStudio default port -> LMStudio provider
            return _create_lmstudio_instance(model_name, **kwargs)
        elif ":11434" in api_base or "ollama" in api_base:
            # Ollama default port -> Ollama provider
            return _create_ollama_instance(model_name, **kwargs)
        elif "deepseek" in api_base or model_name.lower().startswith("deepseek"):
            # DeepSeek (OpenAI-compatible) -> dedicated handler with custom base URL
            return _create_deepseek_instance(model_name, **kwargs)
        else:
            # Default to LMStudio for unknown system providers
            logger.warning("Unknown system provider configuration, defaulting to LMStudio handler")
            return _create_lmstudio_instance(model_name, **kwargs)
    else:
        raise ValueError(
            f"Unsupported provider type for system AI: {provider_type}. "
            f"Please update the system provider in the database to use a supported provider."
        )


def _create_lmstudio_instance_with_fallback(
    model_name: str, user_provider_config: ProviderConfig | None, fallback_config: dict, **kwargs
) -> ChatOpenAI:
    """
    Create LM Studio chat instance with connection testing and fallback capability.

    Tests connection to LMStudio before creating the instance. If connection fails
    and fallback is enabled, raises exception to trigger fallback logic.
    """
    # Get the base URL from user provider config
    base_url = "http://localhost:1234/v1"  # Default LM Studio endpoint

    if user_provider_config and user_provider_config.get("api_base"):
        base_url = user_provider_config["api_base"]
        # Ensure it ends with /v1 for LM Studio compatibility
        if not base_url.endswith("/v1"):
            base_url = base_url.rstrip("/") + "/v1"

    # Test connection to LMStudio with configurable timeout
    connection_timeout = fallback_config.get("connection_timeout", 10)
    max_retries = fallback_config.get("max_retries", 1)

    logger.info("Testing LMStudio connection at %s (timeout: %ds, retries: %d)", base_url, connection_timeout, max_retries)

    import time

    import httpx

    # Test connection with retry logic
    for attempt in range(max_retries + 1):
        try:
            test_start = time.time()

            # Test the /models endpoint to verify LMStudio is accessible
            with httpx.Client(timeout=connection_timeout) as client:
                response = client.get(f"{base_url.rstrip('/v1')}/v1/models")

                if response.status_code == 200:
                    test_duration = time.time() - test_start
                    logger.info("LMStudio connection successful (%.2fs)", test_duration)
                    break
                else:
                    raise httpx.HTTPStatusError(f"LMStudio returned status {response.status_code}", request=response.request, response=response)

        except (httpx.ConnectError, httpx.TimeoutException, httpx.HTTPStatusError, Exception) as e:
            if attempt < max_retries:
                logger.warning("LMStudio connection attempt %d/%d failed: %s (retrying...)", attempt + 1, max_retries + 1, str(e))
                time.sleep(1)  # Brief pause between retries
                continue
            else:
                logger.error("LMStudio connection failed after %d attempts: %s", max_retries + 1, str(e))
                # Raise with original exception for fallback handling
                raise ConnectionError(f"LMStudio unreachable at {base_url}: {e!s}") from e

    logger.info("Creating LMStudio instance for model: %s", model_name)

    # Filter out internal kwargs and unsupported parameters
    clean_kwargs = _filter_provider_kwargs(kwargs, excluded_keys=["base_url", "api_key"])

    # LM Studio doesn't require an API key, but ChatOpenAI expects one
    # Use a dummy key to satisfy the requirement
    return ChatOpenAI(
        model=model_name,
        base_url=base_url,
        api_key=SecretStr("lm-studio"),  # Dummy API key for LM Studio
        temperature=kwargs.get("temperature", 0.1),
        timeout=30.0,  # 30 second timeout for actual LLM requests
        max_retries=1,  # Only retry once for LLM requests
        **clean_kwargs,
    )


def _create_openai_fallback_instance(fallback_config: dict, **kwargs) -> ChatOpenAI:
    """
    Create OpenAI chat instance for fallback when primary system provider fails.

    Uses configuration from system_ai.fallback in config.yaml.
    API key should be configured via Settings > General > System AI Agent Provider.
    """
    fallback_model = fallback_config.get("model", "gpt-4o-mini")
    api_key = fallback_config.get("api_key")

    if not api_key:
        # Try to get from database
        # noinspection PyProtectedMember,PyUnresolvedReferences
        from src.main.utils.llm.agent_model_utils import _get_api_key_for_provider

        api_key = _get_api_key_for_provider("openai")

    if not api_key:
        raise ValueError("OpenAI fallback API key is missing. Configure it via Settings > General > System AI Agent Provider.")

    logger.info("Creating OpenAI fallback instance with model: %s", fallback_model)

    # Filter out internal kwargs and unsupported parameters
    clean_kwargs = _filter_provider_kwargs(kwargs, excluded_keys=["base_url", "api_key", "model_name"])

    # Get appropriate temperature for this model
    requested_temp = kwargs.get("temperature", 0.1)
    temperature = _get_model_temperature(fallback_model, requested_temp)

    return ChatOpenAI(
        model=fallback_model,
        api_key=SecretStr(str(api_key)),
        temperature=temperature,
        timeout=kwargs.get("timeout", 60.0),  # Shorter timeout for fallback
        max_retries=kwargs.get("max_retries", 2),  # Standard retries for OpenAI
        disable_streaming=not kwargs.get("streaming", True),
        stream_usage=True,  # Enable streaming token usage tracking
        **clean_kwargs,
    )


async def _create_local_instance(model_name: str, **kwargs) -> BaseChatModel:
    """Create a local model instance with Ollama fallback."""
    try:
        from src.main.service.local_models.create_model_utils import (
            create_local_model_for_factory,
        )

        logger.info("Delegating to local_models for model: %s", model_name)
        return _safe_run_coroutine(create_local_model_for_factory(model_name, **kwargs))
    except ValueError as embedding_error:
        if "EMBEDDING model" in str(embedding_error):
            logger.error(
                "Cannot load embedding model %s as chat model: %s",
                model_name,
                str(embedding_error),
            )
            raise embedding_error from embedding_error
        logger.warning(
            "Local model loading failed: %s. Trying Ollama fallback.",
            str(embedding_error),
        )
        return _create_ollama_fallback(model_name, embedding_error, **kwargs)
    except Exception as local_error:
        logger.warning("Local model loading failed: %s. Trying Ollama fallback.", str(local_error))
        return _create_ollama_fallback(model_name, local_error, **kwargs)


def _create_ollama_fallback(model_name: str, original_error: Exception, **kwargs) -> ChatOllama:
    """Create Ollama fallback instance when local model fails."""
    try:
        if not OllamaLLM:
            raise original_error

        ollama_base_url = resolved_config.get("llm", {}).get("models", {}).get("ollama", {}).get("base_url", "http://localhost:11434")
        logger.info("Falling back to Ollama provider with base URL: %s", ollama_base_url)

        if inspect.iscoroutine(original_error.__cause__):
            try:
                if (loop := asyncio.get_event_loop()).is_running():
                    logger.warning("Event loop is already running, cannot await coroutine")
                else:
                    loop.run_until_complete(original_error.__cause__)
            except Exception as e:
                logger.warning("Error awaiting coroutine: %s", str(e))

        return ChatOllama(
            model=model_name,
            base_url=ollama_base_url,
            temperature=kwargs.get("temperature", 0.1),
        )
    except Exception as e:
        logger.error("Both local and Ollama providers failed: %s", str(e))
        raise original_error from e


async def _create_vllm_instance(model_name: str, user_provider_config: ProviderConfig | None, **kwargs) -> ChatOpenAI:
    """Create vLLM instance with OpenAI-compatible API."""
    model_name_param = model_name[5:] if model_name.lower().startswith("vllm_") else model_name

    if user_provider_config and (base_url := user_provider_config.get("api_base")):
        logger.info("Using custom vLLM endpoint from user settings: %s", base_url)
    elif (
        model_config := await get_model_config(
            model_name=model_name,
            provider="vllm",
            user_id=kwargs.get("user_id"),
            db=kwargs.get("db"),
        )
    ) and (base_url := model_config.get("base_url")):
        logger.info("Using vLLM endpoint from config: %s", base_url)
    else:
        raise ValueError("No vLLM endpoint URL available")

    logger.info("Initializing OpenAI-compatible client for vLLM with URL: %s", base_url)

    client_params = {
        "api_key": "EMPTY",
        "base_url": base_url,
        "http_client": httpx.Client(verify=False),
    }

    client_params.update(_filter_provider_kwargs(kwargs, excluded_keys=["model", "api_key", "base_url", "max_tokens"]))

    chat_params = {
        "model": model_name_param,
        "temperature": kwargs.get("temperature", 0.1),
        "timeout": kwargs.get("timeout", 60.0),
        "max_retries": kwargs.get("max_retries", 3),
        "max_tokens": kwargs.get("max_tokens", 800),
        "disable_streaming": not kwargs.get("streaming", True),
    }

    try:
        for env_var in ["OPENAI_API_BASE", "OPENAI_API_KEY"]:
            if env_var in os.environ:
                if env_var == "OPENAI_API_KEY":
                    os.environ[env_var] = "PLACEHOLDER_KEY_FOR_VLLM"
                    logger.info(
                        "Temporarily overriding %s to prevent using production OpenAI",
                        env_var,
                    )
                else:
                    del os.environ[env_var]
                    logger.info(
                        "Clearing %s environment variable to prevent URL conflicts",
                        env_var,
                    )

        # noinspection PyUnresolvedReferences
        client = openai.OpenAI(**client_params)
        return ChatOpenAI(client=client, base_url=str(base_url), **chat_params)

    except Exception as e:
        logger.error("Error initializing vLLM OpenAI client: %s", str(e))
        raise HTTPException(status_code=500, detail=f"Error initializing LLM: {e!s}") from e


# Backward compatibility
get_embeddings_model = get_embeddings
get_embeddings_model_async = get_embeddings_async
get_llm_model = get_llm
