"""
Global singleton cache for embedding models.

This module provides a system-wide cache for embedding models to avoid
reloading the same model multiple times. Since embedding models are determined
by CPU/GPU detection (not user-specific), we cache them globally.
"""

from langchain_core.embeddings import Embeddings

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class EmbeddingCache:
    """
    Singleton cache for embedding models.

    Embedding models are system-level resources (not user-specific) and are
    determined by CPU/GPU detection. This cache ensures we only load one
    embedding model instance that is shared across all users and retrievers.
    """

    _instance: "EmbeddingCache | None" = None
    _embedding_model: Embeddings | None = None
    _model_name: str | None = None

    def __new__(cls):
        """Ensure only one instance exists (singleton pattern)."""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    @classmethod
    def get_instance(cls) -> "EmbeddingCache":
        """Get the singleton instance."""
        if cls._instance is None:
            cls._instance = cls()
        instance = cls._instance
        assert instance is not None
        return instance

    def set_embedding_model(self, model: Embeddings, model_name: str) -> None:
        """
        Set the global embedding model.

        This should be called once at startup after determining the correct
        model based on CPU/GPU detection.

        Args:
            model: The embedding model instance
            model_name: The name of the model (for logging)
        """
        self._embedding_model = model
        self._model_name = model_name
        logger.info("Global embedding model cached: %s", model_name)

    def get_embedding_model(self) -> Embeddings | None:
        """
        Get the cached embedding model.

        Returns:
            The cached embedding model, or None if not yet initialized
        """
        return self._embedding_model

    def get_model_name(self) -> str | None:
        """
        Get the name of the cached model.

        Returns:
            The model name, or None if not yet initialized
        """
        return self._model_name

    def is_initialized(self) -> bool:
        """
        Check if the embedding model has been cached.

        Returns:
            True if a model is cached, False otherwise
        """
        return self._embedding_model is not None

    def clear(self) -> None:
        """Clear the cached embedding model (for testing or reinitialization)."""
        self._embedding_model = None
        self._model_name = None
        logger.info("Global embedding model cache cleared")


# Global singleton instance
_embedding_cache = EmbeddingCache.get_instance()


def get_embedding_cache() -> EmbeddingCache:
    """
    Get the global embedding cache instance.

    Returns:
        The singleton EmbeddingCache instance
    """
    return _embedding_cache
