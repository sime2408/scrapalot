"""
Provider compatibility constants for LLM integrations.

This module centralizes provider compatibility lists to avoid duplication
across the codebase.
"""

# Native Pydantic AI providers (direct support)
PYDANTIC_AI_NATIVE_PROVIDERS = [
    "openai",
    "anthropic",
    "google",
    "ollama",
]

# OpenAI-compatible providers (use OpenAI API format)
OPENAI_COMPATIBLE_PROVIDERS = [
    "deepseek",
    "openrouter",
    "vllm",
    "lmstudio",
]

# All supported providers for agentic routing
AGENTIC_ROUTING_SUPPORTED_PROVIDERS = PYDANTIC_AI_NATIVE_PROVIDERS + OPENAI_COMPATIBLE_PROVIDERS


def is_pydantic_ai_native(provider: str) -> bool:
    """
    Check if a provider is natively supported by Pydantic AI.

    Args:
        provider: Provider name (case-insensitive)

    Returns:
        True if Pydantic AI natively supports the provider
    """
    return provider.lower() in PYDANTIC_AI_NATIVE_PROVIDERS


def is_openai_compatible(provider: str) -> bool:
    """
    Check if a provider uses OpenAI-compatible API.

    Args:
        provider: Provider name (case-insensitive)

    Returns:
        True if the provider uses OpenAI-compatible API
    """
    return provider.lower() in OPENAI_COMPATIBLE_PROVIDERS


def is_agentic_routing_supported(provider: str) -> bool:
    """
    Check if a provider is supported for agentic routing.

    Args:
        provider: Provider name (case-insensitive)

    Returns:
        True if the provider is supported for agentic routing
    """
    return provider.lower() in AGENTIC_ROUTING_SUPPORTED_PROVIDERS


def get_routing_model_prefix(provider: str) -> str:
    """
    Get the model prefix for agentic routing based on the provider.

    Args:
        provider: Provider name (case-insensitive)

    Returns:
        Model prefix (e.g., "openai:", "anthropic:")

    Raises:
        ValueError: If the provider is not supported for agentic routing
    """
    provider_lower = provider.lower()

    if is_pydantic_ai_native(provider_lower):
        return f"{provider_lower}:"
    elif is_openai_compatible(provider_lower):
        return "openai:"
    else:
        raise ValueError(
            f"Provider '{provider}' is not supported for agentic routing. Supported providers: {', '.join(AGENTIC_ROUTING_SUPPORTED_PROVIDERS)}"
        )
