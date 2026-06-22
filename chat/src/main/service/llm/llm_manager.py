"""
Manages the lifecycle and caching of Language Model instances.
"""

import asyncio

from langchain_core.language_models import BaseChatModel

from src.main.config.database import SessionLocal
from src.main.service.llm.llm_factory import get_llm
from src.main.utils.core.logger import get_logger
from src.main.utils.gpu.devices import get_device_type, get_system_capabilities, is_gpu_available

logger = get_logger(__name__)


class LLMManager:
    """Manages the initialization and caching of Language Models."""

    def __init__(self):
        """Initializes the LLMManager with an empty cache."""
        self._llm_cache: dict[str, BaseChatModel] = {}
        self._initialization_locks: dict[str, asyncio.Lock] = {}
        self._device_type = get_device_type()
        self._is_gpu_available = is_gpu_available()
        self._system_capabilities = get_system_capabilities()
        logger.info("LLMManager initialized with device type: %s, GPU available: %s", self._device_type, self._is_gpu_available)

    @property
    def device_type(self) -> str:
        """
        Get the device type for processing (cuda, mps, rocm, opencl, cpu).
        This is calculated once during initialization.

        Returns:
                str: Device type
        """
        return self._device_type

    @property
    def is_gpu_available(self) -> bool:
        """
        Check if GPU is available for processing.
        This is calculated once during initialization.

        Returns:
                bool: True if GPU is available, False otherwise
        """
        return self._is_gpu_available

    @property
    def system_capabilities(self) -> dict:
        """
        Get comprehensive system GPU capabilities and memory availability.
        This is calculated once during initialization.

        Returns:
                Dict: System capabilities information
        """
        return self._system_capabilities

    async def _get_lock(self, cache_key: str) -> asyncio.Lock:
        """Gets or creates an asyncio Lock for a given cache key."""
        if cache_key not in self._initialization_locks:
            self._initialization_locks[cache_key] = asyncio.Lock()
        return self._initialization_locks[cache_key]

    async def get_llm_from_request(
        self, request: object | dict, _db: object | None = None, user_id: str | None = None, **kwargs
    ) -> BaseChatModel | None:
        """
        Centralized LLM orchestration method that extracts parameters from request object
        and handles all LLM initialization logic in one place.

        Args:
                request: ChatRequest object or dict containing model parameters
                _db: Database session (optional, will create one if not provided)
                user_id: Optional user ID for user-specific settings
                **kwargs: Additional arguments passed to the LLM factory

        Returns:
                The initialized BaseChatModel instance, or None if initialization fails
        """
        # Extract parameters from request object
        if hasattr(request, "model_name"):
            # Handle ChatRequest object
            model_name = getattr(request, "model_name", None)
            provider_type = getattr(request, "provider_type", None)
        elif isinstance(request, dict):
            # Handle dictionary request
            model_name = request.get("model_name")
            provider_type = request.get("provider_type")
        else:
            logger.error("Invalid request object type: %s", type(request))
            return None

        # Apply safe fallbacks for missing parameters
        if not model_name:
            logger.error("No model_name provided in request")
            return None

        provider_type = provider_type or "local"

        logger.info("🎯 Centralized LLM orchestration - Model: %s, Provider: %s", model_name, provider_type)

        # Delegate to existing get_llm method with extracted parameters
        return await self.get_llm(model_name=str(model_name), provider_type=provider_type, user_id=user_id, **kwargs)

    async def get_llm(self, model_name: str, provider_type: str | None = None, user_id: str | None = None, **kwargs) -> BaseChatModel | None:
        """
        Retrieves a cached LLM instance or initializes, caches, and returns a new one.

        Args:
                model_name: The name of the model (e.g., 'gpt-4o-mini', 'llama3.1:8b', 'lmstudio-model').
                provider_type: Optional name of the provider ('openai', 'ollama', 'local', etc.).
                user_id: Optional user ID for user - specific settings.
                **kwargs: Additional arguments passed to the LLM factory.

        Returns:
                The initialized BaseChatModel instance, or None if initialization fails.
        """
        # `agent_type` selects a per-agent model override (e.g. "reflection" ->
        # a thinking model) from system_agent_config; it must not reach the LLM
        # factory / ChatOpenAI, so pop it here.
        agent_type = kwargs.pop("agent_type", None)

        # The system provider is driven by a SINGLE source of truth — the admin
        # "System AI Agent Provider" config (server_settings.system_agent_config).
        # Callers must NOT hardcode a model for it (e.g. the OpenAI shim used to
        # pin "gpt-4o-mini"); resolve the real model here so switching the system
        # provider/model from the UI is the only thing that ever changes it.
        if (provider_type or "").lower() == "system":
            try:
                from src.main.utils.llm.agent_model_utils import get_system_agent_model

                # Resolve the FULL config (provider + model + base + key) for this
                # role. Synthesis/answer roles map to the DeepSeek "synthesis"
                # sub-config; every other role stays on the base (gpt-4o-mini).
                # Resolving only the model name is not enough — a deepseek model
                # built from the OpenAI card's key/base would 401. We therefore
                # inject the resolved provider config so the factory builds the
                # right instance from the SAME single source of truth.
                cfg = get_system_agent_model(agent_type=agent_type)
                if cfg.model_name and cfg.model_name != model_name:
                    logger.info("Resolved system model from system_agent_config (agent=%s): %s -> %s", agent_type, model_name, cfg.model_name)
                    model_name = cfg.model_name
                kwargs["system_provider_config_override"] = {
                    "provider_type": cfg.provider_type,
                    "api_base": cfg.api_base or None,
                    "api_key": cfg.api_key,
                    "status": "active",
                    "show_models": True,
                }
            except Exception as e:
                logger.warning("Could not resolve system config from system_agent_config, using '%s': %s", model_name, str(e))

        # Autoload user model settings from DB if user_id provided and no explicit overrides
        if user_id and "temperature" not in kwargs:
            try:
                user_kwargs = self._load_user_model_settings(user_id)
                # User settings are defaults; explicit kwargs take precedence
                kwargs = {**user_kwargs, **kwargs}
            except Exception as e:
                logger.warning("Failed to load user model settings for %s: %s", user_id, e)

        # Create a unique cache key based on relevant parameters
        cache_key = self._create_cache_key(model_name, provider_type, user_id, kwargs)

        # Check if the model is already cached
        if cache_key in self._llm_cache:
            logger.debug("Using cached LLM instance for key: %s", cache_key)
            return self._llm_cache[cache_key]

        # Acquire a lock to prevent concurrent initialization of the same model
        lock = await self._get_lock(cache_key)
        async with lock:
            # Check again after acquiring the lock in case another task initialized it
            if cache_key in self._llm_cache:
                logger.debug("Using cached LLM instance for key: %s (after lock)", cache_key)
                return self._llm_cache[cache_key]

            # Initialize the LLM
            logger.info("🚀 Starting LLM initialization for model: %s, provider: %s", model_name, provider_type)
            try:
                # Get a database session for API key retrieval
                db = SessionLocal()
                try:
                    # Remove 'db' from kwargs if it exists to avoid duplicate parameter
                    filtered_kwargs = {k: v for k, v in kwargs.items() if k != "db"}

                    # Initialize the LLM with the factory function
                    result = await get_llm(model_name=model_name, provider_type=provider_type, db=db, user_id=user_id, **filtered_kwargs)

                    # Handle possible coroutine or Task result
                    import asyncio
                    import inspect

                    if inspect.iscoroutine(result) or isinstance(result, asyncio.Task):
                        logger.debug("⏳ Awaiting async LLM initialization for model: %s", model_name)
                        llm = await result
                        logger.debug("Async LLM initialization completed for model: %s", model_name)
                    else:
                        llm = result
                        logger.debug("Sync LLM initialization completed for model: %s", model_name)

                    # Cache the initialized LLM
                    self._llm_cache[cache_key] = llm
                    logger.info("💾 Successfully cached LLM for key: %s", cache_key)
                    return llm
                finally:
                    # Always close the database session
                    db.close()
            except Exception as e:
                logger.error("❌ Failed to initialize LLM for model %s (key: %s): %s", model_name, cache_key, str(e))
                return None

    @staticmethod
    def _load_user_model_settings(user_id: str) -> dict:
        """Load user model settings from DB and return as LLM factory kwargs."""
        from src.main.service.user_settings_service import UserSettingsService

        db = SessionLocal()
        try:
            svc = UserSettingsService(db)
            settings = svc.get_model_settings(user_id)
            if not settings:
                return {}

            kwargs = {}
            # Map settings to LLM factory kwargs (values are stored as strings)
            _float_keys = {"temperature", "top_p", "frequency_penalty", "presence_penalty"}
            _int_keys = {"max_output_tokens", "top_k", "gpu_layers"}

            for key in _float_keys:
                if key in settings:
                    try:
                        kwargs[key] = float(settings[key])
                    except (ValueError, TypeError) as e:
                        logger.debug("Ignoring non-float setting %s=%r: %s", key, settings[key], e)

            for key in _int_keys:
                if key in settings:
                    try:
                        val = int(float(settings[key]))
                        # max_output_tokens → max_tokens for LLM factory
                        if key == "max_output_tokens":
                            kwargs["max_tokens"] = val
                        else:
                            kwargs[key] = val
                    except (ValueError, TypeError) as e:
                        logger.debug("Ignoring non-int setting %s=%r: %s", key, settings[key], e)

            return kwargs
        finally:
            db.close()

    @staticmethod
    def _create_cache_key(model_name: str, provider_type: str | None, user_id: str | None, kwargs: dict) -> str:
        """
        Creates a unique cache key for an LLM configuration.

        Args:
                model_name: The name of the model.
                provider_type: Optional name of the provider.
                user_id: Optional user ID.
                kwargs: Additional arguments that affect the LLM behavior.

        Returns:
                A string key that uniquely identifies this LLM configuration.
        """
        # Extract only the kwargs that affect the LLM behavior
        relevant_kwargs = {
            k: v
            for k, v in kwargs.items()
            if k in ["temperature", "max_tokens", "top_p", "frequency_penalty", "presence_penalty", "streaming", "timeout"]
        }

        # Create a key that includes all relevant parameters
        key_parts = [f"model={model_name}", f"provider={provider_type or 'default'}", f"user={user_id or 'default'}"]

        # Add relevant kwargs to the key
        for k, v in sorted(relevant_kwargs.items()):
            key_parts.append(f"{k}={v}")

        return "|".join(key_parts)

    def clear_cache(self, model_name: str | None = None, provider_type: str | None = None, user_id: str | None = None):
        """
        Clears the LLM cache, optionally filtering by model, provider, or user.

        Args:
                model_name: Optional model name to filter by.
                provider_type: Optional provider name to filter by.
                user_id: Optional user ID to filter by.
        """
        if not any([model_name, provider_type, user_id]):
            # If no filters provided, clear the entire cache
            logger.info("Clearing entire LLM cache (%d entries)", len(self._llm_cache))
            self._llm_cache.clear()
            return

        # Filter keys to remove
        keys_to_remove = []
        for key in self._llm_cache:
            if self._should_clear_key(key, model_name, provider_type, user_id):
                keys_to_remove.append(key)

        # Remove the filtered keys
        for key in keys_to_remove:
            del self._llm_cache[key]

        logger.info("Cleared %d entries from LLM cache", len(keys_to_remove))

    @staticmethod
    def _should_clear_key(key: str, model_name: str | None, provider_type: str | None, user_id: str | None) -> bool:
        """
        Determines if a cache key should be cleared based on the provided filters.

        Args:
                key: The cache key to check.
                model_name: Optional model name to filter by.
                provider_type: Optional provider name to filter by.
                user_id: Optional user ID to filter by.

        Returns:
                True if the key matches the filters and should be cleared, False otherwise.
        """
        # Parse the key to extract its components
        key_parts = dict(part.split("=", 1) for part in key.split("|") if "=" in part)

        # Check if the key matches all provided filters
        if model_name and key_parts.get("model") != model_name:
            return False

        if provider_type and key_parts.get("provider") != provider_type:
            return False

        if user_id and key_parts.get("user") != user_id:
            return False

        # If we get here, the key matches all provided filters
        return True

    def is_user_models_loaded(self, user_id: str) -> bool:
        """
        Checks if any models are already loaded for a specific user.

        Args:
                user_id: The user ID to check.

        Returns:
                True if at least one model is loaded for the user, False otherwise.
        """
        if not user_id:
            return False

        # Check if any cache key contains this user ID
        for key in self._llm_cache:
            key_parts = dict(part.split("=", 1) for part in key.split("|") if "=" in part)
            if key_parts.get("user") == user_id:
                logger.debug("Found existing model for user %s: %s", user_id, key)
                return True

        logger.debug("No models found for user %s", user_id)
        return False


# Singleton instance
llm_manager = LLMManager()
