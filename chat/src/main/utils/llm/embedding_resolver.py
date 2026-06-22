"""
Centralized service for resolving to embed models from config and database.

This module provides a single source of truth for embedding model resolution,
eliminating hardcoded model names throughout the codebase.
"""

import logging
from typing import Any

from sqlalchemy.orm import Session

from src.main.utils.config.loader import resolved_config

logger = logging.getLogger(__name__)


class EmbeddingModelResolver:
    """
    Centralized service for resolving to embed models from config and database.

    Embedding models are managed by existing providers (local, OpenAI, ollama, etc.)
    and are downloaded once to the huggingface directory for shared use across all users.
    This resolver identifies embedding models by their model_type=EMBEDDING or name patterns.
    """

    @staticmethod
    def get_default_embedding_model() -> str:
        """Get the default embedding model from config"""
        return resolved_config.get("defaults", {}).get("embedding", {}).get("embedding_model", "sentence-transformers/all-MiniLM-L6-v2")

    @staticmethod
    def get_cpu_fallback_model() -> str:
        """Get CPU fallback model from config"""
        return resolved_config.get("defaults", {}).get("embedding", {}).get("cpu_fallback_model", "sentence-transformers/all-MiniLM-L6-v2")

    @staticmethod
    def get_preferred_models() -> list[str]:
        """Get a list of preferred models from config"""
        preferred = resolved_config.get("defaults", {}).get("embedding", {}).get("preferred_models", [])
        if not preferred:
            # Fallback to default and CPU models
            return [
                EmbeddingModelResolver.get_default_embedding_model(),
                EmbeddingModelResolver.get_cpu_fallback_model(),
            ]
        return preferred

    @staticmethod
    def _is_model_available(model_name: str, db: Session) -> bool:
        """Check if a model is available in the database or config defaults"""
        try:
            # First check if it's a config default model
            preferred_models = EmbeddingModelResolver.get_preferred_models()
            if model_name in preferred_models:
                logger.debug("Model %s found in config defaults", model_name)
                return True

            # Check for embedding models across all provider types
            # Embedding models can be provided by local, OpenAI, ollama, etc.
            from sqlalchemy import text

            model_exists = db.execute(
                text("""
                    SELECT 1 FROM model_provider_models m
                    JOIN model_providers p ON m.provider_id = p.id
                    WHERE m.model_name = :model_name
                    AND m.model_type = 'EMBEDDING'
                    AND (
                        p.provider_type IN ('local', 'ollama', 'vllm')
                        OR (p.api_key IS NOT NULL AND p.api_key != '')
                    )
                    AND p.status IN ('active', 'enabled')
                    LIMIT 1
                """),
                {"model_name": model_name},
            ).fetchone()

            return model_exists is not None
        except Exception as e:
            logger.warning("Error checking model availability for %s: %s", model_name, e)
            return False

    @staticmethod
    def _get_database_default(db: Session) -> str | None:
        """Get the first available embedding model from a database"""
        try:
            # First try to get config defaults
            preferred_models = EmbeddingModelResolver.get_preferred_models()
            if preferred_models:
                return preferred_models[0]

            # Look for embedding models across all provider types
            # Prioritize local models first, then others
            from sqlalchemy import text

            result = db.execute(
                text("""
                    SELECT m.model_name FROM model_provider_models m
                    JOIN model_providers p ON m.provider_id = p.id
                    WHERE m.model_type = 'EMBEDDING'
                    AND (
                        p.provider_type IN ('local', 'ollama', 'vllm')
                        OR (p.api_key IS NOT NULL AND p.api_key != '')
                    )
                    AND p.status IN ('active', 'enabled')
                    ORDER BY CASE WHEN p.provider_type = 'local' THEN 0 ELSE 1 END, m.model_name
                    LIMIT 1
                """)
            ).fetchone()

            return result[0] if result else None
        except Exception as e:
            logger.warning("Error getting database default model: %s", e)
            return None

    @staticmethod
    def _has_gpu_available() -> bool:
        """Check if GPU is available on the system"""
        try:
            from src.main.utils.gpu.devices import get_device_type

            device_type = get_device_type()
            has_gpu = device_type in ["cuda", "mps", "rocm"]
            logger.debug("GPU availability check: device_type=%s, has_gpu=%s", device_type, has_gpu)
            return has_gpu
        except Exception as e:
            logger.warning("Error checking GPU availability: %s", e)
            return False

    @staticmethod
    def resolve_embedding_model(
        preferred_model: str | None = None,
        db: Session | None = None,
        use_fallback: bool = True,
        context: str = "general",
        auto_select_for_hardware: bool = True,
    ) -> str:
        """
        Resolve embedding model with comprehensive fallback logic and GPU-aware selection

        Args:
            preferred_model: Specific model requested
            db: Database session for validation
            use_fallback: Whether to use CPU fallback if needed
            context: Context for logging (e.g., "chunking", "retrieval")
            auto_select_for_hardware: If True and no preferred_model, auto-select based on GPU availability

        Returns:
            Resolved model name

        Resolution order:
        1. Use preferred_model if provided and valid in a database
        2. Auto-select GPU or CPU optimized model based on hardware (if enabled)
        3. Try config default model if valid in a database
        4. Use the first available model from a database
        5. Use config by default (without database validation)
        6. Use CPU fallback if you use_fallback=True
        """
        logger.debug("Resolving embedding model for context: %s", context)

        # Try the preferred model first
        if preferred_model:
            if db and EmbeddingModelResolver._is_model_available(preferred_model, db):
                logger.info("Using preferred model: %s (context: %s)", preferred_model, context)
                return preferred_model
            elif not db:
                # No database validation, accept preferred model
                logger.info("Using preferred model without validation: %s (context: %s)", preferred_model, context)
                return preferred_model
            else:
                logger.warning("Preferred model %s not available in database (context: %s)", preferred_model, context)

        # Auto-select based on hardware if no preferred model specified
        if auto_select_for_hardware and not preferred_model:
            has_gpu = EmbeddingModelResolver._has_gpu_available()
            preferred_models = EmbeddingModelResolver.get_preferred_models()

            if has_gpu and len(preferred_models) > 0:
                # Use first preferred model (GPU-optimized)
                gpu_model = preferred_models[0]
                if not db or EmbeddingModelResolver._is_model_available(gpu_model, db):
                    logger.info("Auto-selected GPU-optimized model: %s (context: %s)", gpu_model, context)
                    return gpu_model
            elif not has_gpu and len(preferred_models) > 1:
                # Use second preferred model (CPU-optimized) or CPU fallback
                cpu_model = preferred_models[1] if len(preferred_models) > 1 else EmbeddingModelResolver.get_cpu_fallback_model()
                if not db or EmbeddingModelResolver._is_model_available(cpu_model, db):
                    logger.info("Auto-selected CPU-optimized model: %s (context: %s)", cpu_model, context)
                    return cpu_model

        # Try config default model
        config_default = EmbeddingModelResolver.get_default_embedding_model()
        if db and EmbeddingModelResolver._is_model_available(config_default, db):
            logger.info("Using config default model: %s (context: %s)", config_default, context)
            return config_default

        # Try the first available model from a database
        if db:
            db_default = EmbeddingModelResolver._get_database_default(db)
            if db_default:
                logger.info("Using first available database model: %s (context: %s)", db_default, context)
                return db_default

        # Use config by default without database validation
        if not use_fallback:
            logger.info("Using config default without validation: %s (context: %s)", config_default, context)
            return config_default

        # Final fallback to CPU model
        cpu_fallback = EmbeddingModelResolver.get_cpu_fallback_model()
        logger.warning("Using CPU fallback model: %s (context: %s)", cpu_fallback, context)
        return cpu_fallback

    @staticmethod
    def resolve_with_fallback_chain(preferred_models: list[str] | None = None, db: Session | None = None, context: str = "general") -> str:
        """
        Resolve embedding a model with a chain of fallbacks

        Args:
            preferred_models: List of models to try in order
            db: Database session for validation
            context: Context for logging

        Returns:
            First available model from the chain
        """
        if not preferred_models:
            preferred_models = EmbeddingModelResolver.get_preferred_models()

        logger.debug("Trying model chain: %s (context: %s)", preferred_models, context)

        for model in preferred_models or []:
            if not db or EmbeddingModelResolver._is_model_available(model, db):
                logger.info("Resolved to model: %s from chain (context: %s)", model, context)
                return model

        # If none from chain work, use standard resolution
        logger.warning("No models from chain available, using standard resolution (context: %s)", context)
        return EmbeddingModelResolver.resolve_embedding_model(db=db, use_fallback=True, context=context)

    @staticmethod
    def get_model_config(model_name: str) -> dict[str, Any]:
        """Get configuration for a specific model"""
        # This could be extended to include model-specific settings
        # like dimensions, max_tokens, etc.
        model_configs = resolved_config.get("embedding_models", {})
        return model_configs.get(model_name, {})

    @staticmethod
    def normalize_model_name(model_name: str) -> str:
        """
        Normalize the model name by using database lookup instead of hardcoded mappings.

        This delegates to the main normalize_model_name function to avoid duplication.
        """
        if not model_name:
            return model_name

        # Import and use the main normalize_model_name function
        from src.main.utils.llm.model_utils import normalize_model_name as main_normalize

        # noinspection PyTypeChecker
        return main_normalize(model_name, purpose="display_to_model")
