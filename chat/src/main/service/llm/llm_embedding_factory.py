"""
Embedding Factory Module

This module provides functions to create and manage embedding functions for text embeddings.
It abstracts the complexity of selecting and initializing different embedding models.
"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import functools
import os
from typing import Any

# LangChain core imports
from langchain_core.embeddings import Embeddings
from pydantic import SecretStr
from sqlalchemy import text

from src.main.config.database import SessionLocal
from src.main.utils.config.loader import resolved_config

# Local imports
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Exported functions
__all__ = [
    "EmbeddingFactory",
    "get_embedding_function",
    "get_embeddings",
    "get_embeddings_async",
]

# Type aliases
EmbeddingProvider = str
EmbeddingModel = str


# noinspection SqlResolve
class EmbeddingFactory:
    """
    Factory class for creating embedding models based on provider and model name.

    This class encapsulates the logic for creating different types of embedding models
    and provides a unified interface for getting embeddings regardless of the underlying provider.
    """

    def __init__(self, config: dict[str, Any] | None = None):
        """
        Initialize the EmbeddingFactory with configuration.

        Args:
            config: Configuration dictionary, defaults to global config if None
        """
        self.config = config or resolved_config
        self._context = {}
        # Cache for initialized embedding models to avoid redundant initialization
        self._model_cache = {}
        # Thread pool for blocking model loading operations
        self._thread_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="embedding_loader")

    def _set_model_type_in_context(self, model_type: str):
        """Store model type in context for namespace normalization."""
        self._context["model_type"] = model_type

    def _get_model_type_from_context(self) -> str:
        """Get a model type from context."""
        return self._context.get("model_type", "")

    async def get_embedding_function_async(
        self, provider: EmbeddingProvider = "local", model_name: EmbeddingModel | None = None, **kwargs
    ) -> Embeddings:
        """
        Async version of get_embedding_function that runs blocking model loading in the thread pool.

        This prevents h5py model loading from blocking the main event loop.

        Args:
            provider: The embedding provider (e.g., "ollama", "openai", "local")
            model_name: The name of the embedding model to use
            **kwargs: Additional keyword arguments to pass to the embedding model

        Returns:
            An Embedding instance
        """
        loop = asyncio.get_running_loop()
        # Run the synchronous get_embedding_function in the thread pool
        fn = functools.partial(self.get_embedding_function, provider, model_name, **kwargs)
        # noinspection PyTypeChecker
        return await loop.run_in_executor(self._thread_pool, fn)

    def get_embedding_function(self, provider: EmbeddingProvider = "local", model_name: EmbeddingModel | None = None, **kwargs) -> Embeddings:
        """
        Create an embedding function based on the specified provider and model name.

        Args:
            provider: The embedding provider (e.g., "ollama", "openai", "local")
            model_name: The name of the embedding model to use
            **kwargs: Additional keyword arguments to pass to the embedding model

        Returns:
            An Embedding instance

        Raises:
            ValueError: If the provider is not supported, or required parameters are missing
            ImportError: If the required dependencies for the provider are not installed
        """
        try:
            # Get model_namespace from kwargs if provided
            model_namespace = kwargs.pop("model_namespace", None)

            # Handle None provider by defaulting to local
            if provider is None:
                provider = "local"
                logger.warning("Provider is None, defaulting to 'local'")

            # Log the provider and model being used
            logger.info("Creating embedding function with provider: %s, model: %s", provider, model_name)

            # Handle different providers
            if provider.lower() == "local":
                from src.main.utils.llm.embedding_resolver import EmbeddingModelResolver

                # Use resolver for a default model instead of hardcoded value
                default_model = EmbeddingModelResolver.get_cpu_fallback_model()
                resolved_model = model_name or default_model

                return self._create_local_embeddings(
                    model_name=resolved_model,
                    huggingface_token=kwargs.get("hf_token", os.environ.get("HUGGINGFACE_TOKEN")),
                    model_namespace=model_namespace,
                    **kwargs,
                )
            elif provider.lower() == "openai":
                return self._create_openai_embeddings(model_name or "", **kwargs)
            elif provider.lower() == "ollama":
                return self._create_ollama_embeddings(model_name or "", **kwargs)
            elif provider.lower() == "huggingface":
                return self._create_huggingface_embeddings(
                    model_name or "", huggingface_token=kwargs.get("hf_token", os.environ.get("HUGGINGFACE_TOKEN")), **kwargs
                )
            elif provider.lower() == "sentence-transformers":
                # Add the sentence-transformers namespace if not already specified
                if "model_namespace" not in kwargs:
                    kwargs["model_namespace"] = "sentence-transformers"
                return self._create_sentence_transformers_embeddings(model_name or "", **kwargs)
            elif provider.lower() == "vllm":
                return self._create_vllm_embeddings(model_name or "", **kwargs)
            elif provider.lower() == "anthropic":
                return self._create_anthropic_embeddings(model_name or "", **kwargs)
            elif provider.lower() == "google":
                return self._create_google_embeddings(model_name or "", **kwargs)
            else:
                logger.warning("Unknown provider: %s, falling back to get_embeddings()", provider)
                return self.get_embeddings(model_name=model_name or "", **kwargs)

        except Exception as e:
            return self._handle_embedding_error(e)

    def _handle_embedding_error(self, error: Exception) -> Embeddings:
        """Centralized error handling for embedding function creation."""
        logger.error("Error creating embedding function: %s", str(error))
        logger.warning("Falling back to default embedding model due to error")

        try:
            # Import here to avoid circular imports
            from langchain_huggingface import HuggingFaceEmbeddings

            # Detect device using proper GPU detection
            try:
                from src.main.utils.gpu.devices import get_device_type, is_gpu_available

                if is_gpu_available():
                    device_type = get_device_type()
                    if device_type == "cuda":
                        device = "cuda"
                    elif device_type == "mps":
                        device = "mps"
                    else:
                        device = "cpu"
                else:
                    device = "cpu"
            except ImportError:
                get_device_type = None
                is_gpu_available = None
                # Fallback to PyTorch detection
                try:
                    import torch

                    device = "cuda" if torch.cuda.is_available() else "cpu"
                except ImportError:
                    torch = None
                    device = "cpu"

            # Try to get a fallback embedding model from the database
            fallback_model = self.get_fallback_embedding_model()

            # If no fallback found in the database, use a reliable default
            if not fallback_model or "phi" in fallback_model.lower():  # Avoid using LLMs as embedding models
                fallback_model = "sentence-transformers/all-MiniLM-L6-v2"

            logger.info("Using fallback embedding model %s with device: %s", fallback_model, device)

            return HuggingFaceEmbeddings(model_name=fallback_model, model_kwargs={"device": device})
        except Exception as fallback_error:
            logger.error("Fallback embedding model failed: %s", str(fallback_error))
            raise ValueError(f"Failed to create embedding function: {error!s}. Fallback also failed: {fallback_error!s}") from fallback_error

    def _create_local_embeddings(
        self, model_name: str, huggingface_token: str | None = None, model_namespace: str | None = None, **kwargs
    ) -> Embeddings:
        """Create embeddings for a local provider based on a model type."""
        # Store model type in context for namespace normalization
        self._set_model_type_in_context("EMBEDDING")

        # Try to get the correct model name and namespace from the database first
        db_model_info = self._get_model_info_from_db(model_name)
        if db_model_info:
            db_model_name = db_model_info["model_name"]
            db_model_namespace = db_model_info["model_namespace"]

            # Fix incorrect "Local/" prefixes for sentence-transformers models
            if db_model_name.startswith("Local/") and "all-MiniLM" in db_model_name:
                # Extract the actual model name without the incorrect prefix
                actual_model_name = db_model_name.replace("Local/", "")
                model_name = f"sentence-transformers/{actual_model_name}"
                model_namespace = "sentence-transformers"
                logger.info("Fixed incorrect Local/ prefix: %s -> %s", db_model_name, model_name)
            else:
                model_name = db_model_name
                model_namespace = db_model_namespace

            logger.info("Found model in database: %s with namespace: %s", model_name, model_namespace)
        else:
            # For models not in database, apply proper namespace logic
            if model_name == "all-MiniLM-L6-v2" and not model_namespace:
                model_name = "sentence-transformers/all-MiniLM-L6-v2"
                model_namespace = "sentence-transformers"
                logger.info("Applied sentence-transformers namespace to: %s", model_name)
            else:
                # Normalize the model name to ensure correct paths
                model_name = self.normalize_model_name(model_name, model_namespace)

        logger.info("Creating embedding function with provider: local, model: %s, namespace: %s", model_name, model_namespace)

        # Check if this is a local GGUF model (model_namespace == 'local')
        if model_namespace == "local":
            try:
                from src.main.service.llm.gguf_embeddings import create_gguf_embeddings

                logger.info("Loading GGUF embedding model: %s", model_name)

                # Extract GGUF-specific parameters
                gguf_kwargs = {
                    "n_ctx": kwargs.pop("n_ctx", 2048),
                    "n_batch": kwargs.pop("n_batch", 512),
                    "verbose": kwargs.pop("verbose", False),
                }

                # Add any additional llama-cpp parameters
                for key, value in kwargs.items():
                    if key not in ["token", "base_url", "api_key", "device"]:
                        gguf_kwargs[key] = value

                return create_gguf_embeddings(model_name=model_name, **gguf_kwargs)

            except ImportError as e:
                create_gguf_embeddings = None
                logger.error("Failed to import GGUF embeddings: %s", str(e))
                # Fall through to HuggingFace embeddings as fallback

        # For HuggingFace models (with namespaces like nomic-ai, sentence-transformers, intfloat, etc.)
        if model_namespace and model_namespace != "local":
            try:
                from src.main.utils.models.huggingface import get_huggingface_downloader

                # Use intelligent downloader to ensure the model is available
                downloader = get_huggingface_downloader()
                local_model_path = downloader.ensure_model_available(model_name)

                if local_model_path:
                    logger.info("Using local HuggingFace model at: %s", local_model_path)
                    # Use the original model name, HuggingFace will automatically use the local cache
                    actual_model_name = model_name
                else:
                    logger.warning("Could not download model %s, using HuggingFace directly", model_name)
                    # Fall back to direct HuggingFace loading
                    actual_model_name = model_name

                # Create HuggingFace embeddings
                return self._create_huggingface_embeddings(actual_model_name, huggingface_token=huggingface_token, **kwargs)

            except Exception as e:
                logger.error("Failed to create HuggingFace embeddings for %s: %s", model_name, str(e))
                # Fall through to default handling

        # Handle HuggingFace/SentenceTransformers models (default behavior)
        try:
            from langchain_huggingface import HuggingFaceEmbeddings

            # Set default model kwargs
            model_kwargs = {}

            # Handle device selection properly
            device = kwargs.pop("device", None)
            if device is None or device == "auto":
                # Auto-detect device using comprehensive GPU detection
                try:
                    from src.main.utils.gpu.devices import get_device_type, is_gpu_available

                    if is_gpu_available():
                        device_type = get_device_type()
                        # Map our device types to PyTorch device names
                        if device_type == "cuda":
                            device = "cuda"
                        elif device_type == "mps":  # Apple Silicon
                            device = "mps"
                        elif device_type in ["rocm", "opencl"]:
                            # For AMD/Intel GPUs, try CUDA first, then fallback to CPU
                            try:
                                import torch

                                if torch.cuda.is_available():
                                    device = "cuda"
                                else:
                                    device = "cpu"
                                    logger.info("GPU detected (%s) but PyTorch CUDA not available, using CPU", device_type)
                            except ImportError:
                                torch = None
                                device = "cpu"
                                logger.info("GPU detected (%s) but PyTorch not available, using CPU", device_type)
                        else:
                            device = "cpu"
                    else:
                        device = "cpu"

                    logger.info("Auto-detected device for embeddings: %s", device)
                except ImportError:
                    get_device_type = None
                    is_gpu_available = None
                    device = "cpu"
                    logger.info("GPU detection not available, defaulting to CPU")

            # If still no device set, default to auto-detection
            if not device:
                try:
                    import torch

                    device = "cuda" if torch.cuda.is_available() else "cpu"
                except ImportError:
                    torch = None
                    device = "cpu"

            if device:
                model_kwargs["device"] = device

            logger.info(
                "Creating HuggingFace embedding function with model: %s, device: %s",
                model_name,
                model_kwargs.get("device", "default"),
            )

            # Filter out parameters that HuggingFaceEmbeddings doesn't accept
            kwargs_filtered = {
                k: v
                for k, v in kwargs.items()
                if k not in ["token", "base_url", "api_key", "n_ctx", "n_batch", "verbose", "namespace", "model_namespace"]
            }

            # Add a token to model_kwargs if available
            if huggingface_token:
                model_kwargs["token"] = huggingface_token

            # Configure offline mode for local models to prevent network calls
            # Check if the model exists locally
            if model_namespace and model_namespace != "local":
                # Check if the model is downloaded locally
                from pathlib import Path

                # Convert model name to local path format (replace / with --)
                local_model_name = model_name.replace("/", "--")
                potential_paths = [
                    # New embeddings directory structure (preferred)
                    Path(self.config.get("models_directory", "models")) / "embeddings" / "huggingface" / local_model_name,
                    Path("models") / "embeddings" / "huggingface" / local_model_name,
                    # Legacy locations for backward compatibility
                    Path(self.config.get("models_directory", "models")) / "huggingface" / local_model_name,
                    Path("models") / "huggingface" / local_model_name,
                    # HuggingFace cache directory
                    Path.home() / ".cache" / "huggingface" / "hub" / f"models--{local_model_name}",
                ]

                for path in potential_paths:
                    if path.exists() and (path / "config.json").exists():
                        model_path = str(path)
                        logger.info("Found local model at: %s", model_path)
                        break

            # Check if the model exists locally to avoid downloads
            local_model_path = self._check_local_model_path(model_name)
            if local_model_path:
                logger.info("Using local model path to avoid download: %s", local_model_path)
                actual_model_name = local_model_path
                # Force offline mode for local models
                model_kwargs["local_files_only"] = True
            else:
                actual_model_name = model_name
                logger.info("Model not found locally, will download: %s", model_name)

            return HuggingFaceEmbeddings(model_name=actual_model_name, model_kwargs=model_kwargs, **kwargs_filtered)

        except ImportError:
            logger.error("HuggingFaceEmbeddings not available")
            raise ValueError("HuggingFaceEmbeddings is not installed. Install with 'pip install langchain-huggingface'") from None

    def _create_openai_embeddings(self, model_name: str, **kwargs) -> Embeddings:
        """Create OpenAI embeddings."""
        try:
            from langchain_openai import OpenAIEmbeddings

            # Extract API key: kwargs > DB system_agent_config
            api_key = kwargs.get("api_key")
            if not api_key:
                # noinspection PyProtectedMember
                from src.main.utils.llm.agent_model_utils import _get_api_key_for_provider

                api_key = _get_api_key_for_provider("openai")

            if not api_key:
                raise ValueError("API key is required for OpenAI embeddings")

            # Get model from config if not specified or is auto
            if not model_name or model_name == "auto":
                model_name = self.config.get("llm", {}).get("models", {}).get("openai", {}).get("embeddings", "text-embedding-3-small")

            return OpenAIEmbeddings(model=model_name, api_key=SecretStr(str(api_key)), **kwargs)
        except ImportError:
            logger.error("OpenAIEmbeddings not available")
            raise ValueError("OpenAIEmbeddings is not installed. Install with 'pip install langchain-openai'") from None

    def _create_ollama_embeddings(self, model_name: str, **kwargs) -> Embeddings:
        """Create Ollama embeddings."""
        try:
            from langchain_ollama import OllamaEmbeddings

            # Get the Ollama base URL from config or use default
            base_url = kwargs.get("base_url") or self.config.get("ollama", {}).get("base_url", "http://localhost:11434")

            # Get model from config if not specified
            if not model_name or model_name == "auto":
                model_name = self.config.get("llm", {}).get("models", {}).get("ollama", {}).get("embeddings", "all-MiniLM-L6-v2")

            return OllamaEmbeddings(model=model_name, base_url=base_url, **kwargs)
        except ImportError:
            logger.error("OllamaEmbeddings not available")
            raise ValueError("OllamaEmbeddings is not installed. Install with 'pip install langchain-ollama'") from None

    def _create_huggingface_embeddings(self, model_name: str, huggingface_token: str | None = None, **kwargs) -> Embeddings:
        """Create HuggingFace embeddings."""
        try:
            from langchain_huggingface import HuggingFaceEmbeddings

            # Import here to avoid circular imports
            from src.main.utils.llm.model_utils import get_model_kwargs_with_token

            model_kwargs = get_model_kwargs_with_token(huggingface_token)

            # Check if the model is instruction-tuned
            if model_name and any(x in model_name.lower() for x in ["instruct", "e5"]):
                try:
                    from langchain_community.embeddings.huggingface import HuggingFaceInstructEmbeddings

                    logger.info("Using HuggingFaceInstructEmbeddings for model: %s", model_name)
                    return HuggingFaceInstructEmbeddings(model_name=model_name, model_kwargs=model_kwargs if huggingface_token else {})
                except (ImportError, ModuleNotFoundError):
                    logger.error("Dependencies for InstructorEmbedding not found.")
                    logger.warning("HuggingFaceInstructEmbeddings not available, falling back to standard embeddings")

            # Default to standard HuggingFace embeddings
            # Get model from config if not specified
            if not model_name or model_name == "auto":
                model_name = (
                    self.config.get("llm", {}).get("models", {}).get("huggingface", {}).get("embeddings", "sentence-transformers/all-MiniLM-L6-v2")
                )

            # Filter out parameters that HuggingFaceEmbeddings doesn't accept
            kwargs_filtered = {
                k: v for k, v in kwargs.items() if k not in ["hf_token", "token", "base_url", "api_key", "namespace", "model_namespace"]
            }

            # Create the embedding object with the model kwargs
            return HuggingFaceEmbeddings(model_name=model_name, model_kwargs=model_kwargs if huggingface_token else {}, **kwargs_filtered)
        except ImportError:
            logger.error("HuggingFaceEmbeddings not available")
            raise ValueError("HuggingFaceEmbeddings is not installed. Install with 'pip install langchain-huggingface'") from None

    def _create_vllm_embeddings(self, model_name: str, **kwargs) -> Embeddings:
        """Create vLLM embeddings."""
        try:
            from langchain_openai import OpenAIEmbeddings

            # Get base URL from config or kwargs
            base_url = kwargs.get("base_url") or self.config.get("vllm", {}).get("base_url", "http://localhost:8000")

            # Get model from config if not specified
            if not model_name or model_name == "auto":
                model_name = self.config.get("llm", {}).get("models", {}).get("vllm", {}).get("embeddings", "sentence-transformers/all-MiniLM-L6-v2")

            return OpenAIEmbeddings(model=model_name, api_key=SecretStr("dummy"), base_url=base_url, **kwargs)
        except ImportError:
            logger.error("VLLMEmbeddings not available")
            raise ValueError("VLLMEmbeddings is not installed. Install with 'pip install langchain-community'") from None

    def _create_anthropic_embeddings(self, model_name: str, **kwargs) -> Embeddings:
        """Create Anthropic embeddings."""
        # Note: Anthropic doesn't have dedicated embedding models, so we fall back to HuggingFace
        logger.warning("Anthropic doesn't provide embedding models. Falling back to HuggingFace embeddings.")
        return self._create_huggingface_embeddings(model_name or "sentence-transformers/all-MiniLM-L6-v2", **kwargs)

    def _create_google_embeddings(self, model_name: str, **kwargs) -> Embeddings:
        """Create Google embeddings."""
        try:
            from langchain_google_genai import GoogleGenerativeAIEmbeddings

            # Extract API key: kwargs > DB system_agent_config
            api_key = kwargs.get("api_key")
            if not api_key:
                # noinspection PyProtectedMember
                from src.main.utils.llm.agent_model_utils import _get_api_key_for_provider

                api_key = _get_api_key_for_provider("google")

            if not api_key:
                raise ValueError("API key is required for Google embeddings")

            # Get model from config if not specified
            if not model_name or model_name == "auto":
                model_name = self.config.get("llm", {}).get("models", {}).get("google", {}).get("embeddings", "models/embedding-001")

            # noinspection PyArgumentList
            return GoogleGenerativeAIEmbeddings(model=model_name, google_api_key=SecretStr(str(api_key)), **kwargs)
        except ImportError:
            logger.error("GoogleGenerativeAIEmbeddings not available")
            raise ValueError("GoogleGenerativeAIEmbeddings is not installed. Install with 'pip install langchain-google-genai'") from None

    def normalize_model_name(self, model_name: str, model_namespace: str | None = None) -> str:
        """
        Normalize the model name using the centralized function.

        Args:
            model_name: The model name to normalize
            model_namespace: Optional namespace for the model

        Returns:
            Normalized model name
        """
        # Use the centralized normalize_model_name function
        if model_name:
            from src.main.utils.llm.model_utils import normalize_model_name as main_normalize

            # noinspection PyTypeChecker
            model_name = main_normalize(model_name, purpose="display_to_model")

        # Check if we're trying to use a model that's not suitable for embeddings
        if "EMBEDDING" in self._get_model_type_from_context():
            # Check if this model is suitable for embeddings by querying the database
            # If we can't determine, use a heuristic approach based on a model type
            is_suitable = self._is_suitable_for_embeddings(model_name, model_namespace)

            if not is_suitable:
                logger.warning("Detected attempt to use %s as an embedding model, which is not supported.", model_name)
                logger.warning("Falling back to default embedding model.")

                # Get a fallback embedding model from a database instead of a deprecated config
                fallback_model = self.get_fallback_embedding_model()

                # If we found a fallback model, return it
                if fallback_model:
                    logger.info("Using fallback embedding model: %s", fallback_model)
                    return fallback_model

                # If no fallback found in a database, use a hardcoded default
                default_model = "all-MiniLM-L6-v2"
                logger.warning("No fallback embedding model found in database, using default: %s", default_model)

                # Add namespace if it's a sentence transformer model
                if default_model == "all-MiniLM-L6-v2":
                    return "sentence-transformers/" + default_model

                return default_model

        # If no namespace provided or model already has namespace, return as is
        if not model_namespace or "/" in model_name:
            return model_name

        # Normalize namespace to lowercase for consistent comparison
        namespace_lower = model_namespace.lower()

        # Special case for local/Local models - use sentence-transformers namespace for standard models
        if namespace_lower in ["local", "ollama"]:
            # For known sentence-transformers models, use the proper namespace
            if model_name in ["all-MiniLM-L6-v2", "all-mpnet-base-v2", "paraphrase-MiniLM-L6-v2"]:
                logger.info("Converting local namespace to sentence-transformers for model: %s", model_name)
                return f"sentence-transformers/{model_name}"
            # For other local models, return without a namespace prefix
            return model_name

        # For sentence transformers models, always use the namespace
        if namespace_lower == "sentence-transformers":
            return f"sentence-transformers/{model_name}"

        # For models with specific namespaces for embeddings
        if model_namespace:
            # For embedding models, we need to add the namespace
            if "EMBEDDING" in self._get_model_type_from_context():
                return f"{model_namespace}/{model_name}"
            # For chat models, don't add namespace for certain providers
            if namespace_lower in ["microsoft", "deepseek", "meta-llama"]:
                return model_name

        # For other models, use namespace only if it makes sense,
        # For example, don't add namespace to models that already have their namespace in the name
        if model_namespace and model_namespace not in model_name:
            return f"{model_namespace}/{model_name}"

        return model_name

    @staticmethod
    def _is_suitable_for_embeddings(model_name: str, model_namespace: str | None = None) -> bool:
        """
        Check if a model is suitable for embeddings by querying the database or using heuristics.

        Args:
            model_name: The name of the model to check
            model_namespace: Optional namespace for the model

        Returns:
            True if the model is suitable for embeddings, False otherwise
        """
        # First, try to determine from the database if available
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            # Create a database session
            db = SessionLocal()
            try:
                # Query the database to check if this model is marked as an embedding model
                query = """
                    SELECT 1 FROM model_provider_models
                    WHERE model_name = :model_name AND model_type = 'EMBEDDING'
                    LIMIT 1
                """

                result = db.execute(text(query), {"model_name": model_name}).first()

                # If we found a match, the model is suitable for embeddings
                if result:
                    return True

                # If no match, check if it's explicitly a non-embedding model
                query = """
                    SELECT 1 FROM model_provider_models
                    WHERE model_name = :model_name AND model_type != 'EMBEDDING'
                    LIMIT 1
                """

                result = db.execute(text(query), {"model_name": model_name}).first()

                # If we found a match, the model is not suitable for embeddings
                if result:
                    return False
            finally:
                db.close()
        except Exception as e:
            # If we can't query the database, log and continue with heuristics
            logger.debug("Could not query database to check model type: %s", str(e))

        # If we couldn't determine from the database, use heuristics
        # Known embedding model namespaces
        embedding_namespaces = ["sentence-transformers", "bge", "e5", "instructor"]

        # If the model has an embedding namespace, it's suitable
        if model_namespace and model_namespace.lower() in embedding_namespaces:
            return True

        # Check if the model name contains known embedding model indicators
        embedding_indicators = ["embed", "embedding", "encoder", "all-minilm", "e5-", "bge-", "instructor"]
        for indicator in embedding_indicators:
            if model_name and indicator.lower() in model_name.lower():
                return True

        # Check if the model name contains known non-embedding model indicators
        non_embedding_indicators = [
            "instruct",
            "chat",
            "llm",
            "llama",
            "lmstudio",
            "gpt",
            "falcon",
            "mixtral",
            "phi3",
            "phi2",
            "phi-2",
        ]
        for indicator in non_embedding_indicators:
            if model_name and indicator.lower() in model_name.lower():
                logger.debug("Model %s identified as non - embedding model due to indicator: %s", model_name, indicator)
                return False

        # If we can't determine, default to True to avoid unnecessary fallbacks
        return True

    def get_embeddings(self, model_name: str = "all-MiniLM-L6-v2", **kwargs) -> Embeddings:
        """
        Get an embedding model based on the model name and configuration.

        Args:
            model_name: The name of the embedding model to use
            **kwargs: Additional keyword arguments to pass to the model
                model_namespace: Optional namespace for the model (e.g., 'sentence - transformers', 'microsoft')

        Returns:
            An instance of an Embedding model
        """
        # Set the model type in context for namespace normalization
        self._set_model_type_in_context("EMBEDDING")

        # Extract model_namespace if provided, otherwise fetch from a database
        model_namespace = kwargs.get("model_namespace")

        # If no namespace provided, try to fetch from a database
        if model_namespace is None:
            model_info = self._get_model_info_from_db(model_name)
            if model_info and model_info.get("model_namespace"):
                model_namespace = model_info["model_namespace"]
                kwargs["model_namespace"] = model_namespace
                logger.debug("Retrieved namespace from database: %s for model: %s", model_namespace, model_name)

        logger.info("Getting embeddings for model: %s, namespace: %s", model_name, model_namespace)

        # Check if the model is suitable for embeddings
        if not self._is_suitable_for_embeddings(model_name, model_namespace):
            logger.warning("%s is not suitable for embeddings. Using fallback embedding model.", model_name)

            # Get a fallback embedding model from a database instead of a deprecated config
            model_name = self.get_fallback_embedding_model()

            # Set the appropriate namespace based on the model name
            if model_name == "all-MiniLM-L6-v2":
                kwargs["model_namespace"] = "sentence-transformers"

        # Update model_namespace after potential fallback
        model_namespace = kwargs.get("model_namespace")

        # Handle special prefixes
        if model_name and model_name.startswith("ollama:"):
            logger.info("Detected Ollama prefix, routing to Ollama embeddings")
            return self._handle_ollama_prefix(model_name, **kwargs)

        if model_name and model_name.startswith("openai:"):
            logger.info("Detected OpenAI prefix, routing to OpenAI embeddings")
            return self._handle_openai_prefix(model_name, **kwargs)

        # Handle local GGUF models
        if model_namespace == "local":
            logger.info("Detected local namespace, routing to local embeddings")
            # Remove model_namespace from kwargs to avoid duplicate argument
            local_kwargs = {k: v for k, v in kwargs.items() if k != "model_namespace"}
            return self._create_local_embeddings(model_name, model_namespace="local", **local_kwargs)

        # Handle sentence-transformers models
        if model_name and (model_name.startswith("sentence-transformers/") or model_namespace == "sentence-transformers"):
            logger.info("Detected sentence-transformers model, routing to sentence-transformers embeddings")
            return self._create_sentence_transformers_embeddings(model_name, **kwargs)

        # Try to infer the provider based on the model name
        if model_name and (
            "openai" in model_name.lower() or model_name in ["text-embedding-ada-002", "text-embedding-3-small", "text-embedding-3-large"]
        ):
            logger.info("Detected OpenAI model, routing to OpenAI embeddings")
            return self._create_openai_embeddings(model_name, **kwargs)

        if model_name and "vllm" in model_name.lower():
            logger.info("Detected vLLM model, routing to vLLM embeddings")
            return self._create_vllm_embeddings(model_name, **kwargs)

        if model_name and "anthropic" in model_name.lower():
            logger.info("Detected Anthropic model, routing to Anthropic embeddings")
            return self._create_anthropic_embeddings(model_name, **kwargs)

        if model_name and "google" in model_name.lower():
            logger.info("Detected Google model, routing to Google embeddings")
            return self._create_google_embeddings(model_name, **kwargs)

        # For all other models (including nomic-ai, huggingface, etc.), use generic HuggingFace embeddings
        # Only exclude the specific providers handled above: anthropic, openai, google, local, ollama
        if not any(
            [
                model_name and "anthropic" in model_name.lower(),
                model_name and "openai" in model_name.lower(),
                model_name and "google" in model_name.lower(),
                model_namespace == "local",
                model_name and model_name.startswith("ollama:"),
            ]
        ):
            logger.info("Routing to generic HuggingFace embeddings for model: %s, namespace: %s", model_name, model_namespace)
            return self._create_sentence_transformers_embeddings(model_name, **kwargs)

        # Final fallback to sentence-transformers for any edge cases
        logger.info("No specific provider detected, defaulting to sentence-transformers embeddings")
        try:
            return self._create_sentence_transformers_embeddings(model_name, **kwargs)
        except Exception as e:
            logger.error("Failed to create sentence-transformers embeddings: %s", str(e))
            return self._handle_embedding_error(e)

    def _create_sentence_transformers_embeddings(self, model_name: str, **kwargs) -> Embeddings:
        """Create embeddings using HuggingFaceEmbeddings with fallback to SentenceTransformers.

        This method handles both sentence-transformers and generic HuggingFace models.
        It first tries to use HuggingFaceEmbeddings and falls back to direct
        SentenceTransformerEmbeddings if that fails.
        """
        # Generate a cache key based on the model name and relevant kwargs
        cache_key = f"st_{model_name}"
        device = kwargs.get("device", "cpu")
        cache_key += f"_{device}"

        # Add namespace to a cache key if present
        model_namespace = kwargs.get("model_namespace")
        cache_key += f"_{model_namespace}"

        # Check if we already have this model initialized
        if cache_key in self._model_cache:
            logger.debug("Using cached embedding model: %s", cache_key)
            return self._model_cache[cache_key]

        try:
            # Use the new langchain-huggingface package to avoid deprecation warning
            from langchain_huggingface import HuggingFaceEmbeddings

            # Get model from config if not specified
            if not model_name or model_name == "auto":
                model_name = "all-MiniLM-L6-v2"

            # Normalize the model name to ensure correct paths
            model_name = self.normalize_model_name(model_name, model_namespace)

            # Filter out parameters that HuggingFaceEmbeddings doesn't accept
            # More comprehensive parameter filtering for HuggingFaceEmbeddings
            excluded_params = {
                "hf_token",
                "token",
                "base_url",
                "api_key",
                "model_namespace",
                "namespace",  # Add namespace to excluded parameters
                "device",
                "trust_remote_code",
                "temperature",
                "max_tokens",
                "top_p",
                "top_k",
                "repetition_penalty",
                "stream",
                "stop",
                "seed",
                "frequency_penalty",
                "presence_penalty",
                "logit_bias",
                "user",
                "deployment_name",
                "openai_api_version",
                "openai_api_base",
                "openai_organization",
                "allowed_special",
                "disallowed_special",
                "chunk_size",
                "max_retries",
                "request_timeout",
                "headers",
                "tiktoken_model_name",
                "embedding_ctx_length",
                "openai_api_key",
                "openai_api_type",
                "check_embedding_ctx_length",
                "dimensions",
                "skip_empty",
                "batch_size",
                "requests_per_minute",
                "retry_min_seconds",
                "retry_max_seconds",
                "embed_instruction",
                "query_instruction",
            }
            kwargs_filtered = {k: v for k, v in kwargs.items() if k not in excluded_params}

            # Handle device selection
            device = kwargs_filtered.pop("device", "cpu")
            model_kwargs = {"device": device, "trust_remote_code": True}

            # Add trust_remote_code for models that require custom code (like nomic-ai models)

            # Add a token to model_kwargs if available
            huggingface_token = kwargs.get("hf_token") or kwargs.get("token") or os.environ.get("HUGGINGFACE_TOKEN")
            if huggingface_token:
                model_kwargs["token"] = huggingface_token

            # Check if the model exists locally to avoid downloads
            local_model_path = self._check_local_model_path(model_name)
            if local_model_path:
                logger.info("Using local model path to avoid download: %s", local_model_path)
                actual_model_name = local_model_path
                # Force offline mode for local models
                model_kwargs["local_files_only"] = True
            else:
                actual_model_name = model_name
                logger.info("Model not found locally, will download: %s", model_name)

            # Debug logging to see what parameters are being passed
            logger.debug("Filtered kwargs for HuggingFaceEmbeddings: %s", kwargs_filtered)
            logger.debug("Model kwargs: %s", model_kwargs)
            logger.info("Creating HuggingFaceEmbeddings with model: %s, device: %s", actual_model_name, device)

            model = HuggingFaceEmbeddings(model_name=actual_model_name, model_kwargs=model_kwargs, **kwargs_filtered)

            # Cache the initialized model
            self._model_cache[cache_key] = model
            return model
        except ImportError:
            logger.error("HuggingFaceEmbeddings not available, trying direct sentence-transformers")
            # Fall back to a direct sentence-transformers library
            try:
                from langchain_community.embeddings import SentenceTransformerEmbeddings

                logger.info("Using SentenceTransformerEmbeddings as fallback for model: %s", model_name)
                # Create model_kwargs for SentenceTransformerEmbeddings with proper device and trust_remote_code
                st_model_kwargs = {"trust_remote_code": True, "device": device}
                # Add token if available
                huggingface_token = kwargs.get("hf_token") or kwargs.get("token") or os.environ.get("HUGGINGFACE_TOKEN")
                if huggingface_token:
                    st_model_kwargs["token"] = huggingface_token
                model = SentenceTransformerEmbeddings(model_name=model_name, model_kwargs=st_model_kwargs)
                self._model_cache[cache_key] = model
                return model
            except Exception as fallback_error:
                logger.error("Failed to create sentence-transformers fallback: %s", str(fallback_error))
                raise ImportError(f"Both HuggingFaceEmbeddings and SentenceTransformers failed: {fallback_error}") from fallback_error
        except Exception as e:
            logger.error("Failed to create HuggingFaceEmbeddings: %s, trying direct sentence-transformers", str(e))
            # Fall back to direct sentence-transformers library
            try:
                from langchain_community.embeddings import SentenceTransformerEmbeddings

                logger.info("Using SentenceTransformerEmbeddings as fallback for model: %s", model_name)
                # Create model_kwargs for SentenceTransformerEmbeddings with a proper device and trust_remote_code
                st_model_kwargs = {"trust_remote_code": True, "device": device}
                # Add token if available
                huggingface_token = kwargs.get("hf_token") or kwargs.get("token") or os.environ.get("HUGGINGFACE_TOKEN")
                if huggingface_token:
                    st_model_kwargs["token"] = huggingface_token
                model = SentenceTransformerEmbeddings(model_name=model_name, model_kwargs=st_model_kwargs)
                self._model_cache[cache_key] = model
                return model
            except Exception as fallback_error:
                logger.error("Failed to create sentence-transformers fallback: %s", str(fallback_error))
                raise Exception(f"Both HuggingFaceEmbeddings and SentenceTransformers failed: {fallback_error}") from e

    def _handle_ollama_prefix(self, model_name: str, **kwargs) -> Embeddings:
        """Handle Ollama-prefixed model names."""
        try:
            from langchain_ollama import OllamaEmbeddings

            # Get base URL from kwargs or config
            base_url = kwargs.get("base_url") or self.config.get("ollama", {}).get("base_url", "http://localhost:11434")

            logger.info("Using OllamaEmbeddings with model: %s", model_name)
            return OllamaEmbeddings(model=model_name, base_url=base_url, **kwargs)
        except ImportError:
            logger.error("OllamaEmbeddings not available")
            raise ValueError("OllamaEmbeddings is not installed. Install with 'pip install langchain-ollama'") from None

    def _handle_openai_prefix(self, model_name: str, **kwargs) -> Embeddings:
        """Handle OpenAI-prefixed model names."""
        try:
            from langchain_openai import OpenAIEmbeddings

            # Extract API key: kwargs > DB system_agent_config
            api_key = kwargs.get("api_key")
            if not api_key:
                # noinspection PyProtectedMember
                from src.main.utils.llm.agent_model_utils import _get_api_key_for_provider

                api_key = _get_api_key_for_provider("openai")

            if not api_key:
                raise ValueError("API key is required for OpenAI embeddings")

            # Handle Azure OpenAI
            if kwargs.get("azure") or model_name.startswith("azure:"):
                # Get Azure-specific parameters
                azure_endpoint = (
                    kwargs.get("azure_endpoint") or os.environ.get("AZURE_OPENAI_ENDPOINT") or self.config.get("azure", {}).get("api_base")
                )
                deployment = kwargs.get("deployment") or self.config.get("azure", {}).get("embedding_deployment")

                if not azure_endpoint:
                    raise ValueError("Azure endpoint is required for Azure OpenAI embeddings")

                if not deployment:
                    raise ValueError("Deployment name is required for Azure OpenAI embeddings")

                logger.info("Using Azure OpenAIEmbeddings with deployment: %s", deployment)
                return OpenAIEmbeddings(
                    deployment=deployment,
                    api_key=SecretStr(str(api_key)),
                    base_url=azure_endpoint,
                    openai_api_type="azure",
                    **kwargs,
                )

            # Standard OpenAI
            logger.info("Using OpenAIEmbeddings with model: %s", model_name)
            return OpenAIEmbeddings(model=model_name, api_key=SecretStr(str(api_key)), **kwargs)
        except ImportError:
            logger.error("OpenAIEmbeddings not available")
            raise ValueError("OpenAIEmbeddings is not installed. Install with 'pip install langchain-openai'") from None

    def get_fallback_embedding_model(self) -> str:
        """
        Get a fallback embedding model from the database or config.

        Returns:
            A fallback embedding model name
        """
        try:
            # Try to get the best embedding model directly from the database with a single query
            with SessionLocal() as db:
                # Query for a suitable embedding model, prioritizing CPU models for better compatibility
                query = """
                    SELECT m.model_name
                    FROM model_provider_models m
                    JOIN model_providers p ON m.provider_id = p.id
                    WHERE m.model_type = 'EMBEDDING'
                    AND p.status = 'active'
                    ORDER BY
                        -- Prioritize local models first
                        CASE WHEN p.provider_type = 'local' THEN 0 ELSE 1 END,
                        -- Then prioritize CPU - friendly models
                        CASE WHEN m.model_name LIKE '%cpu%' THEN 0 ELSE 1 END,
                        -- Then by provider type preference
                        CASE
                            WHEN p.provider_type = 'local' THEN 0
                            WHEN p.provider_type = 'ollama' THEN 1
                            WHEN p.provider_type = 'huggingface' THEN 2
                            ELSE 3
                        END,
                        -- Finally by name
                        m.model_name
                    LIMIT 1
                """

                result = db.execute(text(query)).first()

                if result:
                    logger.info("Found fallback embedding model in database: %s", result[0])
                    return result[0]

                # If no result from an optimized query, fall back to the original approach
                logger.warning("No embedding model found with optimized query, trying provider - specific queries")
        except Exception as e:
            logger.warning("Error querying for fallback embedding model: %s", str(e))

        # Try to get embedding models from the database using the original approach
        local_models = self.get_embedding_models_from_database("local")
        if local_models:
            # Prefer CPU-optimized models for fallback
            cpu_models = [m for m in local_models if "minilm" in m.lower() or "cpu" in m.lower()]
            if cpu_models:
                return cpu_models[0]
            return local_models[0]

        # Try other providers
        for provider in ["ollama", "huggingface"]:
            models = self.get_embedding_models_from_database(provider)
            if models:
                return models[0]

        # Final fallback to config if a database is empty
        from src.main.utils.config.loader import resolved_config

        fallback_model = resolved_config.get("rag", {}).get("reranker_model", "all-MiniLM-L6-v2")
        logger.warning("No embedding models found in database, using config fallback: %s", fallback_model)
        return fallback_model

    @staticmethod
    def get_embedding_models_from_database(provider_type: str = "local", user_id: str = None) -> list[str]:
        """
        Get embedding models from the database for a specific provider.

        Args:
            provider_type: The type of provider (local, ollama, openai, etc.)
            user_id: Optional user ID for user - specific providers

        Returns:
            List of embedding model names
        """
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            # Normalize provider type to lowercase for database consistency
            provider_type = provider_type.lower()

            # Create a database session
            db = SessionLocal()
            try:
                # Query for embedding models from the specified provider
                # First try user-specific providers, then system providers
                if user_id:
                    query = """
                        SELECT mpm.model_name
                        FROM model_provider_models mpm
                        JOIN model_providers mp ON mpm.provider_id = mp.id
                        WHERE mp.provider_type = :provider_type
                        AND mpm.model_type = 'EMBEDDING'
                        AND (mp.user_id = :user_id OR mp.user_id IS NULL)
                        ORDER BY mp.user_id DESC, mpm.model_name
                    """
                    result = db.execute(text(query), {"provider_type": provider_type, "user_id": user_id})
                else:
                    query = """
                        SELECT mpm.model_name
                        FROM model_provider_models mpm
                        JOIN model_providers mp ON mpm.provider_id = mp.id
                        WHERE mp.provider_type = :provider_type
                        AND mpm.model_type = 'EMBEDDING'
                        AND mp.user_id IS NULL
                        ORDER BY mpm.model_name
                    """
                    result = db.execute(text(query), {"provider_type": provider_type})

                models = [row[0] for row in result.fetchall()]
                logger.debug("Found %s embedding models for provider %s: %s", len(models), provider_type, models)
                return models

            finally:
                db.close()
        except Exception as e:
            logger.warning("Could not query database for embedding models: %s", str(e))
            return []

    @staticmethod
    def _get_provider_api_base(provider_type: str, user_id: str = None) -> str | None:
        """
        Get the API base URL for a provider from the database.

        Args:
            provider_type: The type of provider (local, ollama, openai, etc.)
            user_id: Optional user ID for user - specific providers

        Returns:
            API base URL or None if not found
        """
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            # Create a database session
            db = SessionLocal()
            try:
                # Query for provider API base URL
                # First try user-specific providers, then system providers
                if user_id:
                    query = """
                        SELECT api_base
                        FROM model_providers
                        WHERE provider_type = :provider_type
                        AND (user_id = :user_id OR user_id IS NULL)
                        AND status = 'active'
                        ORDER BY user_id DESC
                        LIMIT 1
                    """
                    result = db.execute(text(query), {"provider_type": provider_type, "user_id": user_id})
                else:
                    query = """
                        SELECT api_base
                        FROM model_providers
                        WHERE provider_type = :provider_type
                        AND user_id IS NULL
                        AND status = 'active'
                        LIMIT 1
                    """
                    result = db.execute(text(query), {"provider_type": provider_type})

                row = result.fetchone()
                if row and row[0]:
                    return row[0]
                return None

            finally:
                db.close()
        except Exception as e:
            logger.warning("Could not query database for provider API base: %s", str(e))
            return None

    @staticmethod
    def _get_model_info_from_db(model_name: str) -> dict[str, str]:
        """
        Get the model name and namespace from the database.

        Args:
            model_name: The name of the model to query

        Returns:
            A dictionary with 'model_name' and 'model_namespace' keys
        """
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            # Create a database session
            db = SessionLocal()
            try:
                # Query for model info from the database
                query = """
                    SELECT mpm.model_name, mpm.model_namespace
                    FROM model_provider_models mpm
                    JOIN model_providers mp ON mpm.provider_id = mp.id
                    WHERE mpm.model_name = :model_name
                    OR mpm.display_name = :model_name
                    AND mpm.model_type = 'EMBEDDING'
                    AND mp.status = 'active'
                    ORDER BY
                        CASE WHEN mpm.model_name = :model_name THEN 0 ELSE 1 END
                    LIMIT 1
                """

                result = db.execute(text(query), {"model_name": model_name}).first()

                if result:
                    return {"model_name": result[0], "model_namespace": result[1]}
                return {}
            finally:
                db.close()
        except Exception as e:
            logger.warning("Could not query database for model info: %s", str(e))
            return {}

    def _check_local_model_path(self, model_name: str) -> str | None:
        """
        Check if a model exists locally and return the local path.

        Args:
            model_name: The name of the model to check

        Returns:
            Local path to the model if found, None otherwise
        """
        try:
            import os
            from pathlib import Path

            # Convert model name to local path format (replace / with --)
            local_model_name = model_name.replace("/", "--")

            # Extract just the model name without namespace for directory lookup
            model_name_only = model_name.rsplit("/", maxsplit=1)[-1] if "/" in model_name else model_name

            # Check various potential local paths
            potential_paths = [
                # data/models directory structure (new default)
                Path("data") / "models" / "embeddings" / "huggingface" / local_model_name,
                Path("data") / "models" / "embeddings" / "huggingface" / model_name_only,
                # New embeddings directory structure
                Path(self.config.get("models_directory", "models")) / "embeddings" / "huggingface" / local_model_name,
                Path(self.config.get("models_directory", "models")) / "embeddings" / "huggingface" / model_name_only,
                Path("models") / "embeddings" / "huggingface" / local_model_name,
                Path("models") / "embeddings" / "huggingface" / model_name_only,
                # Legacy locations for backward compatibility
                Path(self.config.get("models_directory", "models")) / "huggingface" / local_model_name,
                Path("models") / "huggingface" / local_model_name,
                # HuggingFace cache directory
                Path.home() / ".cache" / "huggingface" / "hub" / f"models--{local_model_name}",
                # Check if model name is already a local path
                Path(model_name) if os.path.exists(model_name) else None,
            ]

            for path in potential_paths:
                if path and path.exists() and (path / "config.json").exists():
                    logger.info("Found local model at: %s", path)
                    return str(path)

            # Also check if the model exists in the HuggingFace cache using transformers
            # noinspection PyBroadException
            try:
                from transformers import AutoConfig

                # Try to load config without downloading - this will use cache if available
                config = AutoConfig.from_pretrained(model_name, local_files_only=True)
                if config:
                    logger.info("Model %s found in HuggingFace cache", model_name)
                    return model_name  # Return original name, transformers will use cache
            except Exception:
                # Model not in cache, will need to download
                pass

            return None

        except Exception as e:
            logger.debug("Error checking local model path for %s: %s", model_name, str(e))
            return None


# Create a default instance for backward compatibility
_default_factory = EmbeddingFactory()


# Backward compatibility functions


def get_embedding_function(
    provider: EmbeddingProvider = "local",
    model_name: EmbeddingModel | None = None,
    config: dict[str, Any] | None = None,
    **kwargs,
) -> Embeddings:
    """
    Backward compatibility function for getting embedding functions.

    Args:
        provider: The embedding provider (e.g., "ollama", "openai", "local")
        model_name: The name of the embedding model to use
        config: Configuration dictionary
        **kwargs: Additional keyword arguments to pass to the embedding model

    Returns:
        An Embedding instance
    """
    if config is not None:
        factory = EmbeddingFactory(config)
        return factory.get_embedding_function(provider, model_name, **kwargs)
    return _default_factory.get_embedding_function(provider, model_name, **kwargs)


def get_embeddings(model_name: str = "all-MiniLM-L6-v2", **kwargs) -> Embeddings:
    """
    Backward compatibility function for getting embeddings.

    Args:
        model_name: The name of the embedding model to use
        **kwargs: Additional keyword arguments to pass to the model

    Returns:
        An instance of an Embedding model
    """
    return _default_factory.get_embeddings(model_name, **kwargs)


async def get_embeddings_async(model_name: str = "all-MiniLM-L6-v2", **kwargs) -> Embeddings:
    """
    Async version of get_embeddings that runs blocking model loading in thread pool.

    This prevents h5py model loading from blocking the main event loop during
    document processing.

    Args:
        model_name: The name of the embedding model to use
        **kwargs: Additional keyword arguments to pass to the model

    Returns:
        An instance of an Embedding model
    """
    provider = kwargs.pop("provider", "local")
    return await _default_factory.get_embedding_function_async(provider, model_name, **kwargs)
