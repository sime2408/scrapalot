from enum import Enum

from src.main.service.web_search.duckduckgo_provider import DuckDuckGoProvider
from src.main.service.web_search.search_provider_interface import SearchProvider, SearchProviderError
from src.main.service.web_search.serpapi_provider import SerpAPIProvider
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class ProviderType(Enum):
    """Enumeration of supported search providers."""

    DUCKDUCKGO = "duckduckgo"
    SERPAPI = "serpapi"


class SearchProviderFactory:
    """Factory class for creating and managing web search providers."""

    _providers: dict[str, SearchProvider] = {}
    _initialized = False

    @classmethod
    def initialize(cls) -> None:
        """Initialize the factory with available providers."""
        if cls._initialized:
            return

        try:
            web_config = resolved_config.get("web_search", {})

            # Initialize DuckDuckGo provider (always available, no API key required)
            try:
                ddg_provider = DuckDuckGoProvider(web_config)
                if ddg_provider.is_available():
                    cls._providers[ProviderType.DUCKDUCKGO.value] = ddg_provider
                    logger.info("DuckDuckGo search provider initialized successfully")
                else:
                    logger.warning("DuckDuckGo search provider is not available")
            except Exception as e:
                logger.error("Failed to initialize DuckDuckGo provider: %s", str(e))

            # Initialize SerpAPI provider (requires API key)
            try:
                serpapi_provider = SerpAPIProvider(web_config)
                if serpapi_provider.is_available():
                    cls._providers[ProviderType.SERPAPI.value] = serpapi_provider
                    logger.info("SerpAPI search provider initialized successfully")
                else:
                    logger.warning("SerpAPI search provider is not available (missing API key)")
            except Exception as e:
                logger.error("Failed to initialize SerpAPI provider: %s", str(e))

            cls._initialized = True
            logger.info("Search provider factory initialized with %d providers", len(cls._providers))

        except Exception as e:
            logger.error("Error initializing search provider factory: %s", str(e))
            cls._initialized = True  # Mark as initialized to prevent retry loops

    @classmethod
    def get_provider(cls, provider_name: str | None = None) -> SearchProvider:
        """
        Get a search provider by name or return the default provider.

        Args:
            provider_name: Name of the provider to get (optional)

        Returns:
            SearchProvider instance

        Raises:
            SearchProviderError: If no providers are available or requested provider not found
        """
        cls.initialize()

        if not cls._providers:
            raise SearchProviderError(message="No search providers are available", provider="Factory")

        # If no specific provider requested, use configured default or fallback
        if not provider_name:
            web_config = resolved_config.get("web_search", {})
            provider_name = web_config.get("provider", "duckduckgo")

        # Try to get the requested provider
        # noinspection PyTypeChecker
        provider = cls._providers.get(provider_name or "duckduckgo")
        if provider:
            logger.debug("Using search provider: %s", provider.provider_name)
            return provider

        # If requested provider not available, try fallback order
        fallback_order = [
            ProviderType.DUCKDUCKGO.value,
            ProviderType.SERPAPI.value,
        ]

        for fallback_provider in fallback_order:
            if fallback_provider in cls._providers:
                logger.warning("Requested provider '%s' not available, using fallback: %s", provider_name, fallback_provider)
                return cls._providers[fallback_provider]

        # No providers available
        raise SearchProviderError(
            message=f"Requested provider '{provider_name}' not available and no fallback providers found",
            provider="Factory",
        )

    @classmethod
    def get_available_providers(cls) -> list[str]:
        """
        Get list of available provider names.

        Returns:
            List of available provider names
        """
        cls.initialize()
        return list(cls._providers.keys())

    @classmethod
    def is_provider_available(cls, provider_name: str) -> bool:
        """
        Check if a specific provider is available.

        Args:
            provider_name: Name of the provider to check

        Returns:
            True if provider is available, False otherwise
        """
        cls.initialize()
        return provider_name in cls._providers

    @classmethod
    def get_default_provider_name(cls) -> str:
        """
        Get the name of the default provider.

        Returns:
            Name of the default provider
        """
        web_config = resolved_config.get("web_search", {})
        return web_config.get("provider", "duckduckgo")

    @classmethod
    def reset(cls) -> None:
        """Reset the factory (mainly for testing purposes)."""
        cls._providers.clear()
        cls._initialized = False
