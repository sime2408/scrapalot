"""
Manages the lifecycle and caching of Retriever instances.
"""

import asyncio

from src.main.service.retriever.retriever import Retriever
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class RetrieverManager:
    """Manages the initialization and caching of Retrievers."""

    def __init__(self):
        """Initializes the RetrieverManager with an empty cache."""
        self._retriever_cache: dict[str, Retriever] = {}
        self._initialization_locks: dict[str, asyncio.Lock] = {}
        self._config = None
        self._resolved_secrets = None

    async def initialize(self, config: dict, resolved_secrets: dict):
        """
        Initialize the RetrieverManager with configuration and secrets.

        Args:
                config: Application configuration dictionary
                resolved_secrets: Dictionary containing resolved secrets
        """
        self._config = config
        self._resolved_secrets = resolved_secrets
        logger.info("RetrieverManager configuration initialized.")

    async def _get_lock(self, cache_key: str) -> asyncio.Lock:
        """Gets or creates an asyncio Lock for a given cache key."""
        if cache_key not in self._initialization_locks:
            self._initialization_locks[cache_key] = asyncio.Lock()
        return self._initialization_locks[cache_key]

    async def get_retriever(self, user_id: str, retriever_type: str = "pgvector", **kwargs) -> Retriever | None:
        """
        Retrieves a cached Retriever instance or initializes, caches, and returns a new one.

        Args:
                user_id: The user ID for user-specific retriever settings.
                retriever_type: Type of retriever ('pgvector', 'neo4j', 'ensemble').
                **kwargs: Additional arguments passed to the retriever factory.

        Returns:
                The initialized Retriever instance, or None if initialization fails.
        """
        if not self._config or not self._resolved_secrets:
            logger.error("RetrieverManager not properly initialized. Call initialize() first.")
            return None

        # Auto-populate embedding model and provider from per-type active models if not provided
        if "embedding_model" not in kwargs or "provider" not in kwargs:
            try:
                from src.main.config.database import get_db as get_db_session
                from src.main.models.sqlmodel_providers import ModelProvider

                # Use the generator properly - get_db() yields a session
                db_generator = get_db_session()
                db = next(db_generator)
                try:
                    # Get an active local provider
                    # noinspection PyTypeChecker
                    # noinspection PyUnresolvedReferences
                    active_provider = (
                        db.query(ModelProvider)
                        .filter(
                            ModelProvider.status == "active",
                            ModelProvider.provider_type == "local",
                            ModelProvider.show_models.is_(True),
                        )
                        .first()
                    )

                    if active_provider:
                        # Active model concept removed - no auto-selection of embedding models
                        if "provider" not in kwargs:
                            kwargs["provider"] = active_provider.name
                            logger.debug("Using provider: %s", active_provider.name)
                finally:
                    # Properly close the database session
                    db.close()
            except Exception as e:
                logger.warning("Failed to auto-select active embedding model: %s", str(e))

        # Create a unique cache key based on relevant parameters
        cache_key = self._create_cache_key(user_id, retriever_type, kwargs)

        # Check if the retriever is already cached
        if cache_key in self._retriever_cache:
            logger.debug("Using cached Retriever instance for key: %s", cache_key)
            return self._retriever_cache[cache_key]

        # Acquire a lock to prevent concurrent initialization of the same retriever
        lock = await self._get_lock(cache_key)
        async with lock:
            # Check again after acquiring the lock in case another task initialized it
            if cache_key in self._retriever_cache:
                logger.debug("Using cached Retriever instance for key: %s (after lock)", cache_key)
                return self._retriever_cache[cache_key]

            # Initialize the Retriever
            logger.info("Initializing new Retriever instance for user: %s, type: %s", user_id, retriever_type)
            try:
                retriever = await self._create_retriever(user_id, retriever_type, **kwargs)

                if retriever:
                    # Cache the initialized Retriever
                    self._retriever_cache[cache_key] = retriever
                    logger.info("Successfully initialized and cached Retriever for key: %s", cache_key)
                    return retriever
                else:
                    logger.error("Failed to create retriever for user %s, type %s", user_id, retriever_type)
                    return None

            except Exception as e:
                logger.error("Failed to initialize Retriever for key %s: %s", cache_key, str(e))
                return None

    async def _create_retriever(self, user_id: str, retriever_type: str, **kwargs) -> Retriever | None:
        """
        Create a retriever instance based on type and user preferences.

        Args:
                user_id: The user ID
                retriever_type: Type of retriever to create
                **kwargs: Additional arguments

        Returns:
                Retriever instance or None if creation fails
        """
        try:
            # Add null check for retriever_type
            if not retriever_type:
                logger.error("Retriever type is None or empty")
                return None

            retriever_type_lower = retriever_type.lower()

            if retriever_type_lower == "neo4j":
                # Create Neo4j retriever - use resolved_secrets directly
                if not self._resolved_secrets or "neo4j_password" not in self._resolved_secrets:
                    logger.warning("Neo4j password not found in resolved_secrets, skipping Neo4j retriever creation")
                    return None

                retriever = await Retriever.create_retriever("neo4j", config=self._config, resolved_secrets=self._resolved_secrets, **kwargs)

            elif retriever_type_lower == "ensemble":
                # Create an ensemble retriever with both pgvector and neo4j
                retrievers = []

                # Create PGVector retriever
                try:
                    pg_retriever = await Retriever.create_retriever(
                        "pgvector", config=self._config, resolved_secrets=self._resolved_secrets, **kwargs
                    )
                    if pg_retriever:
                        retrievers.append(pg_retriever)
                except Exception as e:
                    logger.warning("Failed to create PGVector retriever for ensemble: %s", str(e))

                # Create Neo4j retriever - use resolved_secrets directly
                try:
                    if self._resolved_secrets and "neo4j_password" in self._resolved_secrets:
                        neo4j_retriever = await Retriever.create_retriever(
                            "neo4j", config=self._config, resolved_secrets=self._resolved_secrets, **kwargs
                        )
                        if neo4j_retriever:
                            retrievers.append(neo4j_retriever)
                    else:
                        logger.warning("Neo4j password not found in resolved_secrets, skipping Neo4j retriever for ensemble")
                except Exception as e:
                    logger.warning("Failed to create Neo4j retriever for ensemble: %s", str(e))

                if retrievers:
                    retriever = await Retriever.create_retriever("ensemble", config=self._config, retrievers=retrievers, **kwargs)
                else:
                    logger.error("No retrievers available for ensemble")
                    return None

            else:
                # Default to pgvector
                retriever = await Retriever.create_retriever("pgvector", config=self._config, resolved_secrets=self._resolved_secrets, **kwargs)

            logger.info("Successfully created %s retriever for user %s", retriever_type, user_id)
            return retriever

        except Exception as e:
            logger.error("Failed to create %s retriever for user %s: %s", retriever_type, user_id, str(e))
            return None

    @staticmethod
    def _create_cache_key(user_id: str, retriever_type: str, kwargs: dict) -> str:
        """
        Creates a unique cache key for a Retriever configuration.

        Args:
                user_id: The user ID.
                retriever_type: Type of retriever.
                kwargs: Additional arguments that affect the retriever behavior.

        Returns:
                A string key that uniquely identifies this Retriever configuration.
        """
        # Extract only the kwargs that affect the retriever behavior
        relevant_kwargs = {k: v for k, v in kwargs.items() if k in ["embedding_model", "provider", "collection_ids"]}

        # Create a key that includes all relevant parameters
        key_parts = [
            f"user={user_id}",
            f"type={retriever_type.lower()}",
        ]

        # Add relevant kwargs to the key
        for k, v in sorted(relevant_kwargs.items()):
            key_parts.append(f"{k}={v}")

        return "|".join(key_parts)

    def clear_cache(self, user_id: str | None = None, retriever_type: str | None = None):
        """
        Clears the Retriever cache, optionally filtering by user or retriever type.

        Args:
                user_id: Optional user ID to filter by.
                retriever_type: Optional retriever type to filter by.
        """
        if not any([user_id, retriever_type]):
            # If no filters provided, clear the entire cache
            logger.info("Clearing entire Retriever cache (%d entries)", len(self._retriever_cache))
            self._retriever_cache.clear()
            return

        # Filter keys to remove
        keys_to_remove = []
        for key in self._retriever_cache:
            if self._should_clear_key(key, user_id, retriever_type):
                keys_to_remove.append(key)

        # Remove the filtered keys
        for key in keys_to_remove:
            del self._retriever_cache[key]

        logger.info("Cleared %d entries from Retriever cache", len(keys_to_remove))

    @staticmethod
    def _should_clear_key(key: str, user_id: str | None, retriever_type: str | None) -> bool:
        """
        Determines if a cache key should be cleared based on the provided filters.

        Args:
                key: The cache key to check.
                user_id: Optional user ID to filter by.
                retriever_type: Optional retriever type to filter by.

        Returns:
                True if the key matches the filters and should be cleared, False otherwise.
        """
        # Parse the key to extract its components
        key_parts = dict(part.split("=", 1) for part in key.split("|") if "=" in part)

        # Check if the key matches all provided filters
        if user_id and key_parts.get("user") != user_id:
            return False

        if retriever_type and key_parts.get("type") != retriever_type.lower():
            return False

        # If we get here, the key matches all provided filters
        return True

    def is_user_retrievers_loaded(self, user_id: str) -> bool:
        """
        Checks if any retrievers are already loaded for a specific user.

        Args:
                user_id: The user ID to check.

        Returns:
                True if at least one retriever is loaded for the user, False otherwise.
        """
        if not user_id:
            return False

        # Check if any cache key contains this user ID
        for key in self._retriever_cache:
            key_parts = dict(part.split("=", 1) for part in key.split("|") if "=" in part)
            if key_parts.get("user") == user_id:
                logger.debug("Found existing retriever for user %s: %s", user_id, key)
                return True

        logger.debug("No retrievers found for user %s", user_id)
        return False

    async def pre_warm_embedding_models(self):
        """
        Pre - warm embedding models in the background to speed up first chat requests.
        This creates actual retriever instances and caches them for faster user access.
        """
        if self._config is None:
            logger.warning("RetrieverManager not properly initialized (missing config). Cannot pre - warm models.")
            return

        if self._resolved_secrets is None:
            logger.warning("RetrieverManager not properly initialized (missing resolved_secrets). Cannot pre - warm models.")
            return

        logger.info(" Pre - warming embedding models by creating retriever instances...")

        try:
            # Create a temporary user ID for pre-warming
            temp_user_id = "background_preload"

            # Determine which retriever types we can pre-warm based on available secrets
            available_types = []

            # PGVector is usually available if we have postgres_password
            if "postgres_password" in self._resolved_secrets:
                available_types.append("pgvector")
            else:
                logger.info(" Skipping pgvector pre - warming - postgres_password not available")

            # Neo4j requires neo4j_password
            if "neo4j_password" in self._resolved_secrets:
                available_types.append("neo4j")
            else:
                logger.info(" Skipping neo4j pre - warming - neo4j_password not available")

            # Ensemble requires at least one of the above
            if len(available_types) > 0:
                available_types.append("ensemble")

            if not available_types:
                logger.warning(" No retriever types can be pre - warmed - missing required secrets")
                return

            logger.info(" Pre - warming %s retriever types: %s", len(available_types), available_types)
            successful_preloads = 0

            for retriever_type in available_types:
                try:
                    logger.info(" Pre - warming %s retriever...", retriever_type)

                    # Create retriever instance using existing factory method
                    retriever = await self._create_retriever(temp_user_id, retriever_type)

                    if retriever:
                        # Cache it for potential reuse
                        cache_key = self._create_cache_key(temp_user_id, retriever_type, {})
                        self._retriever_cache[cache_key] = retriever
                        logger.info(" %s retriever pre - warmed and cached", retriever_type)
                        successful_preloads += 1
                    else:
                        logger.warning(" Failed to create %s retriever during pre - warming", retriever_type)

                except Exception as e:
                    logger.warning(" Failed to pre - warm %s retriever: %s", retriever_type, str(e))
                    # Continue with other types even if one fails

            if successful_preloads > 0:
                logger.info(
                    " Successfully pre - warmed %s/%s retriever types - user requests will be faster",
                    successful_preloads,
                    len(available_types),
                )
            else:
                logger.warning(" No retrievers were successfully pre - warmed")

        except Exception as e:
            logger.warning(" Failed to pre - warm embedding models: %s", str(e))
            # Don't raise - this is a background task and shouldn't affect operation

    async def shutdown(self):
        """
        Gracefully shut down all cached retrievers and release resources.
        """
        try:
            # Close all cached retrievers
            shutdown_tasks = []
            for cache_key, retriever in self._retriever_cache.items():
                if hasattr(retriever, "close") and callable(retriever.close):

                    async def close_retriever(r, key):
                        try:
                            await r.close()
                            logger.debug("Closed retriever for key: %s", key)
                        except Exception as ex:
                            logger.error("Error closing retriever for key %s: %s", key, str(ex))

                    shutdown_tasks.append(close_retriever(retriever, cache_key))

            if shutdown_tasks:
                # Execute all shutdown tasks concurrently with timeout
                try:
                    await asyncio.wait_for(asyncio.gather(*shutdown_tasks, return_exceptions=True), timeout=10.0)
                    logger.info("All retrievers closed successfully.")
                except TimeoutError:
                    logger.warning("Retriever shutdown timed out after 10 seconds.")

            # Clear the cache
            self._retriever_cache.clear()
            self._initialization_locks.clear()

            logger.info("RetrieverManager shutdown completed.")

        except Exception as e:
            logger.error("Error during RetrieverManager shutdown: %s", str(e))


# Singleton instance
retriever_manager = RetrieverManager()
