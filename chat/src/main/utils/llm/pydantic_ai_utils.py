"""
Pydantic AI Utilities

Provides utilities for converting LangChain LLM objects to Pydantic AI compatible models.
"""

from typing import Any

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_DEEPSEEK_SAFE_MODEL_CLASS = None


def _deepseek_safe_model(model_name: str, provider):
    """Build an OpenAIChatModel for DeepSeek that never sends an empty assistant message.

    DeepSeek rejects any request whose history contains an assistant message with
    neither content nor tool_calls ("Invalid assistant message: content or
    tool_calls must be set"). Pydantic AI produces exactly that when the model
    returns an empty completion and then retries with it in the history — OpenAI /
    gpt-4o-mini tolerated it, but DeepSeek 400s, which stalled deep-research
    synthesis in a retry loop (the run froze at ~77% hammering the API). Wrap the
    model so every assistant turn that has no text and no tool call gets a minimal
    placeholder before the request is sent.
    """
    global _DEEPSEEK_SAFE_MODEL_CLASS
    from pydantic_ai.models.openai import OpenAIChatModel

    if _DEEPSEEK_SAFE_MODEL_CLASS is None:
        from dataclasses import replace

        from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart

        def _sanitize(messages):
            out = []
            for m in messages:
                if isinstance(m, ModelResponse):
                    has_content = any(isinstance(p, ToolCallPart) or (isinstance(p, TextPart) and (p.content or "").strip()) for p in m.parts)
                    if not has_content:
                        m = replace(m, parts=[*m.parts, TextPart(content=" ")])
                out.append(m)
            return out

        class _DeepSeekSafeModel(OpenAIChatModel):
            async def request(self, messages, model_settings, model_request_parameters):
                return await super().request(_sanitize(messages), model_settings, model_request_parameters)

            def request_stream(self, messages, model_settings, model_request_parameters, run_context=None):
                return super().request_stream(_sanitize(messages), model_settings, model_request_parameters, run_context)

        _DEEPSEEK_SAFE_MODEL_CLASS = _DeepSeekSafeModel

    # noinspection PyTypeChecker
    return _DEEPSEEK_SAFE_MODEL_CLASS(model_name, provider=provider)


def get_agentic_model_string(llm, api_key: str = None, provider_type: str = None) -> str | Any:
    """Convert a LangChain LLM object to an agentic AI compatible model.

    Agentic AI expects model strings like "openai:gpt-4o" or model instances.
    This function extracts the model name, provider, and API key from LangChain LLM objects
    and returns a properly configured model for agentic use.

    Args:
        llm: A LangChain LLM instance (ChatOpenAI, ChatAnthropic, etc.) or wrapper
        api_key: Optional API key to use (from model_providers table)
        provider_type: Optional provider type (openai, anthropic, etc.)

    Returns:
        A Pydantic AI compatible model (model instance with API key or string for Ollama)
    """
    # Unwrap if the LLM is wrapped in a delegation class
    actual_llm = _unwrap_llm(llm)

    # Try to get model name from various LangChain LLM attributes
    model_name = _extract_model_name(actual_llm)

    # Use provided provider_type or determine from LLM
    provider = provider_type.lower() if provider_type else _determine_provider(actual_llm, model_name)

    # Use provided API key or try to extract from LLM
    if not api_key:
        # noinspection PyTypeChecker
        api_key = _extract_api_key(actual_llm)

    logger.debug(
        "Pydantic AI model conversion: provider=%s, model=%s, api_key_found=%s",
        provider,
        model_name,
        api_key is not None,
    )

    # Create Pydantic AI model with API key via provider
    # Pydantic AI 1.77.0 uses Provider pattern: Model('name', provider=Provider(api_key=...))
    try:
        if provider == "openai" and api_key:
            from pydantic_ai.models.openai import OpenAIChatModel
            from pydantic_ai.providers.openai import OpenAIProvider

            logger.debug("Creating OpenAI model for Pydantic AI: %s", model_name)
            openai_provider = OpenAIProvider(api_key=api_key)
            # noinspection PyTypeChecker
            return OpenAIChatModel(model_name, provider=openai_provider)

        elif provider == "anthropic" and api_key:
            from pydantic_ai.models.anthropic import AnthropicModel
            from pydantic_ai.providers.anthropic import AnthropicProvider

            logger.debug("Creating Anthropic model for Pydantic AI: %s", model_name)
            anthropic_provider = AnthropicProvider(api_key=api_key)
            return AnthropicModel(model_name, provider=anthropic_provider)

        elif provider == "google" and api_key:
            from pydantic_ai.models.google import GoogleModel
            from pydantic_ai.providers.google import GoogleProvider

            logger.debug("Creating Google/Gemini model for Pydantic AI: %s", model_name)
            google_provider = GoogleProvider(api_key=api_key)
            return GoogleModel(model_name, provider=google_provider)

        elif provider == "deepseek" and api_key:
            # DeepSeek is OpenAI-compatible. Without this branch the function fell
            # through to the string fallback ("deepseek:model"), which drops the
            # api_key and relies on a DEEPSEEK_API_KEY env var we don't set — so
            # every string-path agent (deep-research synthesis/curation, paper gen)
            # got a 401. Build a keyed OpenAI client against DeepSeek's endpoint,
            # mirroring AgentModelConfig.get_pydantic_ai_model().
            from pydantic_ai.models.openai import OpenAIChatModel
            from pydantic_ai.providers.openai import OpenAIProvider

            logger.debug("Creating DeepSeek (OpenAI-compatible) model for Pydantic AI: %s", model_name)
            deepseek_provider = OpenAIProvider(api_key=api_key, base_url="https://api.deepseek.com")
            # Wrap so empty assistant messages never reach DeepSeek (see _deepseek_safe_model).
            return _deepseek_safe_model(model_name, deepseek_provider)

        elif provider == "ollama":
            # Ollama doesn't need API key, use string format
            pydantic_model_string = f"ollama:{model_name}"
            logger.debug("Using Ollama model string for Pydantic AI: %s", pydantic_model_string)
            return pydantic_model_string

        else:
            # Fallback to string format (will use environment variables)
            pydantic_model_string = f"{provider}:{model_name}"
            logger.warning(
                "No API key found for provider %s, using string format (requires env var): %s",
                provider,
                pydantic_model_string,
            )
            return pydantic_model_string

    except ImportError as e:
        logger.warning("Could not import Pydantic AI model class: %s. Falling back to string format.", str(e))
        return f"{provider}:{model_name}"


def _unwrap_llm(llm):
    """Unwrap LLM from wrapper classes that delegate to an inner LLM instance."""
    # Check for wrapper classes that store the actual LLM in a .client attribute
    if hasattr(llm, "client") and hasattr(llm.client, "model_name"):
        logger.debug("Unwrapping LLM from wrapper class: %s", llm.__class__.__name__)
        return llm.client

    # Check for other wrapper patterns
    if hasattr(llm, "_llm"):
        # noinspection PyProtectedMember
        return llm._llm
    if hasattr(llm, "llm"):
        return llm.llm

    return llm


def _extract_model_name(llm) -> str:
    """Extract model name from LangChain LLM."""
    # Try various attribute names used by different LangChain classes
    for attr in ["model_name", "model", "name"]:
        if hasattr(llm, attr):
            value = getattr(llm, attr)
            if value:
                return value

    return "gpt-4o-mini"  # Fallback default


def _determine_provider(llm, model_name: str) -> str:
    """Determine the provider based on LLM class and model name."""
    class_name = llm.__class__.__name__.lower()

    # Check class name first
    if "openai" in class_name or "chatopenai" in class_name:
        return "openai"
    elif "anthropic" in class_name:
        return "anthropic"
    elif "google" in class_name or "gemini" in class_name:
        return "google"
    elif "ollama" in class_name:
        return "ollama"

    # Infer from model name
    if model_name:
        model_lower = model_name.lower()
        if "gpt" in model_lower or "o1" in model_lower or "o3" in model_lower:
            return "openai"
        elif "claude" in model_lower:
            return "anthropic"
        elif "gemini" in model_lower:
            return "google"

    return "openai"  # Default


def _extract_api_key(llm) -> str | None:
    """Extract API key from LangChain LLM."""
    # List of possible API key attribute names
    api_key_attrs = [
        "openai_api_key",
        "api_key",
        "anthropic_api_key",
        "google_api_key",
    ]

    for attr in api_key_attrs:
        if hasattr(llm, attr):
            value = getattr(llm, attr)
            extracted = _extract_secret_value(value)
            if extracted:
                logger.debug("Found API key in attribute: %s", attr)
                return extracted

    # Check if there's a nested client with API key
    if hasattr(llm, "client") and hasattr(llm.client, "api_key"):
        extracted = _extract_secret_value(llm.client.api_key)
        if extracted:
            logger.debug("Found API key in nested client")
            return extracted

    logger.warning("Could not extract API key from LLM: %s", llm.__class__.__name__)
    return None


def _extract_secret_value(value) -> str | None:
    """Extract string value from SecretStr or return string directly."""
    if value is None:
        return None

    # Handle Pydantic SecretStr
    if hasattr(value, "get_secret_value"):
        return value.get_secret_value()

    # Handle string directly
    if isinstance(value, str):
        return value

    # Try to convert to string
    # noinspection PyBroadException
    try:
        return str(value)
    except Exception:
        return None


# Backward-compatible alias (deprecated - use get_agentic_model_string)
get_pydantic_ai_model_string = get_agentic_model_string
