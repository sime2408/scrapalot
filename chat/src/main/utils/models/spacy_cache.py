"""
Global singleton cache for spaCy NLP models.

spaCy models are expensive to load (the medium English model is ~100 MB
of vectors), so we keep them in process memory and share the loaded
object across every entity-extraction call.
"""

from __future__ import annotations

from typing import Any

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class SpacyCache:
    """In-memory cache for spaCy NLP models (singleton)."""

    _instance: SpacyCache | None = None

    def __new__(cls) -> SpacyCache:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._models = {}
        return cls._instance

    def __init__(self) -> None:
        # ``__new__`` already populated ``_models`` on first construction; the
        # explicit annotation here keeps type checkers happy without
        # re-initialising on every call.
        self._models: dict[str, Any]

    @classmethod
    def get_instance(cls) -> SpacyCache:
        """Return (and lazily create) the singleton instance."""
        return cls._instance or cls()

    def get_model(self, model_name: str):
        """Return a cached spaCy ``nlp`` object, loading it on first request."""
        cached = self._models.get(model_name)
        if cached is not None:
            logger.debug("Using cached spaCy model: %s", model_name)
            return cached

        try:
            import spacy
        except ImportError:
            logger.exception("spaCy is not installed; cannot load model %s", model_name)
            raise

        logger.info("Loading spaCy model: %s", model_name)
        try:
            nlp = spacy.load(model_name)
        except OSError:
            logger.exception("Failed to load spaCy model %s", model_name)
            raise

        self._models[model_name] = nlp
        logger.info("Cached spaCy model: %s", model_name)
        return nlp

    def is_cached(self, model_name: str) -> bool:
        """Return ``True`` when ``model_name`` is already in the cache."""
        return model_name in self._models

    def clear(self) -> None:
        """Drop every cached model (use sparingly — re-loading is slow)."""
        self._models.clear()
        logger.info("Cleared all cached spaCy models")


# Eagerly create the singleton so callers can ``from … import get_spacy_cache``.
_spacy_cache = SpacyCache.get_instance()


def get_spacy_cache() -> SpacyCache:
    """Return the process-wide singleton ``SpacyCache``."""
    return _spacy_cache
