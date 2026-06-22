"""
GGUF Embeddings Module

This module provides an embedding wrapper for GGUF models using llama-cpp-python.
It implements the LangChain Embedding interface for compatibility with the existing codebase.
"""

import os

from langchain_core.embeddings import Embeddings

from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class GGUFEmbeddings(Embeddings):
    """
    Embedding wrapper for GGUF models using llama-cpp-python.

    This class provides an interface to load and use GGUF embedding models
    from local disk storage, compatible with the LangChain Embeddings interface.
    """

    def __init__(self, model_path: str, model_name: str, n_ctx: int = 2048, n_batch: int = 512, verbose: bool = False, **kwargs):
        """
        Initialize the GGUF embeddings model.

        Args:
            model_path: Full path to the GGUF model file
            model_name: Name of the model for logging purposes
            n_ctx: Context size for the model
            n_batch: Batch size for processing
            verbose: Whether to enable verbose logging
            **kwargs: Additional arguments passed to llama-cpp-python
        """
        self.model_path = model_path
        self.model_name = model_name
        self.n_ctx = n_ctx
        self.n_batch = n_batch
        self.verbose = verbose
        self.kwargs = kwargs
        self._model = None

        # Validate model file exists
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"GGUF model file not found: {model_path}")

        logger.info("Initializing GGUF embeddings with model: %s at %s", model_name, model_path)

    def _load_model(self):
        """Lazy load the llama-cpp model."""
        if self._model is None:
            try:
                from llama_cpp import Llama

                # Initialize the model with embedding-specific parameters
                self._model = Llama(
                    model_path=self.model_path,
                    n_ctx=self.n_ctx,
                    n_batch=self.n_batch,
                    embedding=True,  # Enable embedding mode
                    verbose=self.verbose,
                    **self.kwargs,
                )
                logger.info("Successfully loaded GGUF embedding model: %s", self.model_name)

            except ImportError as e:
                logger.warning("llama-cpp-python not available for GGUF embeddings: %s", str(e))
                raise ImportError("llama-cpp-python is required for GGUF embeddings. Install with 'pip install llama-cpp-python'") from e
            except Exception as e:
                logger.error("Failed to load GGUF model %s: %s", self.model_path, str(e))
                raise RuntimeError(f"Failed to load GGUF embedding model: {e!s}") from e

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """
        Embed a list of documents.

        Args:
            texts: List of text documents to embed

        Returns:
            List of embedding vectors (one per document)
        """
        self._load_model()

        embeddings = []
        for text in texts:
            try:
                # Get embedding for the text
                embedding = self._model.embed(text)
                embeddings.append(embedding)

            except Exception as e:
                logger.error("Failed to embed text: %s", str(e))
                # Return a zero vector as fallback
                # This maintains compatibility but indicates failure
                embedding_dim = getattr(self._model, "n_embd", 768)  # Default dimension
                embeddings.append([0.0] * embedding_dim)

        logger.debug("Generated embeddings for %s documents using %s", len(texts), self.model_name)
        return embeddings

    def embed_query(self, text: str) -> list[float]:
        """
        Embed a single query text.

        Args:
            text: Query text to embed

        Returns:
            Embedding vector for the query
        """
        self._load_model()

        try:
            embedding = self._model.embed(text)
            logger.debug("Generated embedding for query using %s", self.model_name)
            return embedding

        except Exception as e:
            logger.error("Failed to embed query: %s", str(e))
            # Return a zero vector as fallback
            embedding_dim = getattr(self._model, "n_embd", 768)  # Default dimension
            return [0.0] * embedding_dim


def create_gguf_embeddings(model_name: str, models_base_path: str = None, **kwargs) -> GGUFEmbeddings:
    """
    Create a GGUF embeddings instance for a given model.

    Args:
        model_name: Name of the model (should match directory name in models/embeddings/gguf/)
        models_base_path: Base path to models directory (defaults to models/embeddings/gguf)
        **kwargs: Additional arguments passed to GGUFEmbeddings

    Returns:
        GGUFEmbeddings instance

    Raises:
        ImportError: If local AI is disabled in configuration
        FileNotFoundError: If model directory or GGUF file not found
        ValueError: If multiple or no GGUF files found in model directory
    """
    # Check if local AI is enabled before attempting to create GGUF embeddings
    local_ai_enabled = resolved_config.get("llm", {}).get("local_ai", {}).get("enabled", False)
    if not local_ai_enabled:
        logger.info("Local AI is disabled, cannot create GGUF embeddings for model: %s", model_name)
        raise ImportError("Local AI is disabled in configuration")

    if models_base_path is None:
        # Use an absolute path to models directory - embeddings are in models/embeddings/gguf
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(str(__file__))))))
        models_base_path = os.path.abspath(os.path.join(str(project_root), "models", "embeddings", "gguf"))

    # Remove "local/" prefix from model name if present
    clean_model_name = model_name.replace("local/", "").replace("local\\", "")

    model_dir = os.path.abspath(os.path.join(models_base_path, clean_model_name))

    if not os.path.exists(model_dir):
        raise FileNotFoundError(f"Model directory not found: {model_dir}")

    # Find GGUF files in the model directory
    gguf_files = [f for f in os.listdir(model_dir) if f.endswith(".gguf")]

    if not gguf_files:
        raise ValueError(f"No GGUF files found in model directory: {model_dir}")

    if len(gguf_files) > 1:
        logger.warning("Multiple GGUF files found in %s: %s. Using the first one.", model_dir, gguf_files)

    # Use the first GGUF file found
    gguf_file = gguf_files[0]
    model_path = os.path.join(model_dir, gguf_file)

    logger.info("Creating GGUF embeddings for %s using file: %s", model_name, gguf_file)

    return GGUFEmbeddings(model_path=model_path, model_name=model_name, **kwargs)
