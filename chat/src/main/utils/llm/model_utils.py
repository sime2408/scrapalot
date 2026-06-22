"""
Comprehensive LLM Model Utilities Module

This module consolidates all LLM model-related utilities into a single cohesive module,
eliminating code duplication and providing a unified interface for LLM model operations.

Merged from:
- llm_common_utils.py - Common LLM utilities (provider mappings, model discovery, API key management)
- llm_provider_utils.py - Provider operations (credential extraction, model syncing, logging)
- model_utils.py - Model database operations (embedding models, model queries, normalization)
"""

import os
import re
from typing import Any

from sqlalchemy import text

from src.main.config.database import SessionLocal
from src.main.utils.config.loader import resolved_config, resolved_secrets
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# =============================================================================
# COMMON LLM UTILITIES (from llm_common_utils.py)
# =============================================================================

# Provider mappings
MODEL_TO_PROVIDER_MAP = {
    "llama": "meta",
    "lmstudio": "lmstudio",
    "mpt": "mosaicml",
    "falcon": "tii",
    "vicuna": "lmsys",
    "zephyr": "huggingface",
    "openai": "openai",
    "claude": "anthropic",
    "gpt": "openai",
    "codellama": "meta",
    "gemini": "google",
    "google": "google",
    "gemma": "google",
    "microsoft": "microsoft",
    "phi": "microsoft",
    "deepseek": "deepseek",
    "qwen": "alibaba",
}

# Valid model file extensions
VALID_MODEL_EXTENSIONS = [".gguf", ".bin", ".ggml", ".ggmlv3", ".safetensors"]

# Cache duration constant
ONE_DAY_IN_SECONDS = 86400  # 24 hours in seconds


def determine_provider(model_name: str) -> str:
    """Determine the model provider based on the model name."""
    if not model_name:
        return "huggingface"

    # Convert to lowercase for case-insensitive matching
    model_name_lower = model_name.lower()

    # Check each known model name pattern
    for model_key, provider in MODEL_TO_PROVIDER_MAP.items():
        if model_key in model_name_lower:
            return provider

    return "huggingface"


def get_model_icon(provider: str) -> str:
    """Get the icon path for a given provider."""
    # This is a placeholder-in a real implementation, return actual icon paths
    return f"providers/{provider.lower()}.svg"


def get_huggingface_token() -> str | None:
    """
    Get the Hugging Face token from environment or config.

    Returns:
        The Hugging Face token as a string, or None if not found.
    """
    token = None
    if token := os.environ.get("HUGGINGFACE_TOKEN", "") or resolved_secrets.get("huggingface_token", ""):
        logger.debug("Setting HUGGINGFACE_TOKEN environment variable")
        # noinspection PyTypeChecker
        os.environ["HUGGINGFACE_TOKEN"] = token
        return token
    return None


def get_model_kwargs_with_token(huggingface_token: str | None = None) -> dict[str, Any]:
    """
    Create model_kwargs dictionary with token if available.

    Args:
        huggingface_token: Optional token to use

    Returns:
        Dictionary with token parameters if token is available, empty dict otherwise
    """
    if not huggingface_token and not (huggingface_token := get_huggingface_token()):
        return {}

    return {"token": huggingface_token}


def get_api_key(provider_name: str, db=None, user_id: str = None) -> str | None:
    """
    Get the API key for a specific provider, considering user-specific settings.
    Priority: Model Providers Table -> User DB -> Environment Variables -> Config.

    Args:
        provider_name: The LLM provider (e.g., "openai", "anthropic").
        db: Optional database session.
        user_id: Optional user ID for user-specific keys.

    Returns:
        The API key as a string, or None if not found.
    """
    provider_name = provider_name.lower()

    # First check model_providers table if db provided
    if db:
        try:
            from sqlalchemy import and_

            from src.main.models.sqlmodel_providers import ModelProvider

            # Query for the provider in the model_providers table
            if user_id:
                # Check the user-specific provider first
                # noinspection PyTypeChecker,PyUnresolvedReferences
                provider = (
                    db.query(ModelProvider)
                    .filter(
                        and_(
                            ModelProvider.user_id == user_id,
                            ModelProvider.provider_type == provider_name,
                            ModelProvider.api_key.isnot(None),
                            ModelProvider.api_key != "",
                        )
                    )
                    .first()
                )
            else:
                # Check the system provider (user_id is None)
                # noinspection PyTypeChecker,PyUnresolvedReferences
                provider = (
                    db.query(ModelProvider)
                    .filter(
                        and_(
                            ModelProvider.provider_type == provider_name,
                            ModelProvider.api_key.isnot(None),
                            ModelProvider.api_key != "",
                        )
                    )
                    .first()
                )

            if provider and provider.api_key:
                logger.debug("Found API key for %s in model_providers table", provider_name)
                return provider.api_key

        except Exception as e:
            logger.warning("Error querying model_providers table for API key: %s", e)

    # Check system_settings table if db provided
    if db:
        try:
            system_settings_key = f"{provider_name.upper()}_API_KEY"
            result = db.execute(text("SELECT value FROM system_settings WHERE key = :key"), {"key": system_settings_key}).fetchone()
            if result and result[0]:
                logger.debug("Found API key for %s in system_settings table", provider_name)
                return result[0]
        except Exception as e:
            logger.warning("Error querying system_settings table for API key: %s", e)

    # Then check system-wide settings (from environment or config)
    env_var_name = f"{provider_name.upper()}_API_KEY"
    config_key = f"{provider_name}_api_key"

    # Try environment variable first
    if api_key := os.environ.get(env_var_name, ""):
        logger.debug("Found API key for %s in environment variables", provider_name)
        return api_key

    # Then try the secrets in config
    if api_key := resolved_secrets.get(config_key, ""):
        logger.debug("Found API key for %s in config secrets", provider_name)
        return api_key

    logger.debug("No API key found for provider: %s", provider_name)
    return None


def get_default_embedding_model(provider: str = "local", db: Any | None = None) -> str:
    """
    Get the default embedding model for a provider from database or config.

    Args:
        provider: The provider to get the default model for
        db: Optional database session for querying available models

    Returns:
        The default model name as a string
    """
    from src.main.utils.llm.embedding_resolver import EmbeddingModelResolver

    # If database session is provided, use resolver to query for available models
    if db:
        try:
            # Use resolver to find embedding models from database with provider_type = 'local'
            resolved_model = EmbeddingModelResolver.resolve_embedding_model(db=db, use_fallback=True, context=f"provider_{provider}")
            if resolved_model:
                logger.info("Using embedding model from database: %s (provider: %s)", resolved_model, provider)
                return resolved_model
        except Exception as e:
            logger.warning("Failed to query database for embedding model: %s", str(e))

    # Fallback to config-based resolution
    # For a local provider, check for GPU availability
    if provider == "local":
        try:
            import torch

            if torch.cuda.is_available():
                model_name = resolved_config.get("llm", {}).get("models", {}).get("local", {}).get("embeddings", {}).get("gpu")
                logger.info("Using GPU embedding model from config: %s", model_name)
                return model_name
            else:
                model_name = resolved_config.get("llm", {}).get("models", {}).get("local", {}).get("embeddings", {}).get("cpu")
                logger.info("Using CPU embedding model from config: %s", model_name)
                return model_name
        except ImportError:
            logger.warning("PyTorch not available, using CPU embedding model")
            model_name = resolved_config.get("llm", {}).get("models", {}).get("local", {}).get("embeddings", {}).get("cpu")
            return model_name

    # Get a provider-specific model
    model_name = resolved_config.get("llm", {}).get("models", {}).get(provider, {}).get("embeddings")

    # If still no model name, use a sensible default from config
    if not model_name:
        model_name = resolved_config.get("defaults", {}).get("embedding", {}).get("embedding_model")

    # Last resort fallback
    if model_name:
        return model_name

    # Use resolver for fallback
    return EmbeddingModelResolver.get_cpu_fallback_model()


def clean_tags(tags_list: Any) -> list[str]:
    """Clean tags to prevent 'NaN undefined' in the UI"""
    if not tags_list:
        return []

    # Convert to list if it's not already
    if not isinstance(tags_list, list):
        # noinspection PyBroadException
        try:
            if isinstance(tags_list, str):
                # Try to parse JSON if it's a string
                import json

                tags_list = json.loads(tags_list)
            else:
                tags_list = list(tags_list)
        except Exception:
            return []

    # Filter out None, empty strings, and non-string values
    return [str(tag).strip() for tag in tags_list if tag and str(tag).strip()]


def get_models_directory() -> str:
    """
    Get the standardized models directory path.

    Returns:
        Absolute path to the models directory
    """
    # Get the project root directory
    current_file = str(os.path.abspath(__file__))
    project_root = str(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(current_file)))))
    return str(os.path.join(project_root, "models"))


def get_gguf_models_directory() -> str:
    """
    Get the standardized GGUF models directory path.

    Returns:
        Absolute path to the GGUF models directory
    """
    return os.path.join(get_models_directory(), "gguf")


def find_model_in_directory(model_name: str, models_dir: str, use_fuzzy_matching: bool = True) -> str | None:
    """
    Enhanced model discovery with fuzzy matching and directory support.

    Args:
        model_name: Name of the model to find
        models_dir: Base directory to search in
        use_fuzzy_matching: Whether to use fuzzy matching for model names

    Returns:
        Path to the model file if found, None otherwise
    """
    if not model_name or not os.path.exists(models_dir):
        return None

    # Clean model name (remove local/ prefix if present)
    clean_model_name = model_name.replace("local/", "").replace("local\\", "")

    # First try exact match as directory
    model_dir = os.path.join(models_dir, clean_model_name)
    if os.path.isdir(model_dir):
        # Look for .gguf files in the directory
        gguf_files = [f for f in os.listdir(model_dir) if f.endswith(".gguf")]
        if gguf_files:
            return os.path.join(model_dir, gguf_files[0])

    # Try direct file match with various extensions
    for ext in VALID_MODEL_EXTENSIONS:
        file_path = os.path.join(models_dir, f"{clean_model_name}{ext}")
        if os.path.isfile(file_path):
            return file_path

    if not use_fuzzy_matching:
        return None

    # Fuzzy matching for directories
    try:
        dirs = [d for d in os.listdir(models_dir) if os.path.isdir(os.path.join(models_dir, d))]
    except OSError:
        return None

    # Normalize names for comparison
    normalized_target = clean_model_name.lower().replace("_", "-").replace(" ", "-")

    for dir_name in dirs:
        dir_path = os.path.join(models_dir, dir_name)
        normalized_dir = dir_name.lower().replace("_", "-").replace(" ", "-")

        # Check for exact normalized match
        if normalized_dir == normalized_target:
            gguf_files = [f for f in os.listdir(dir_path) if f.endswith(".gguf")]
            if gguf_files:
                return os.path.join(dir_path, gguf_files[0])

        # Check for partial matches (at least 2 common parts)
        if len(normalized_target.split("-")) > 1:
            similarity_score = len(set(normalized_target.split("-")) & set(normalized_dir.split("-")))
            if similarity_score >= 2:
                gguf_files = [f for f in os.listdir(dir_path) if f.endswith(".gguf")]
                if gguf_files:
                    return os.path.join(dir_path, gguf_files[0])

    return None


def check_model_file_exists(model_name: str, models_dir: str) -> str | None:
    """
    Check if a model file exists for the given model name.

    Args:
        model_name: Name of the model to check
        models_dir: Base directory for models

    Returns:
        Path to the model file if found, None otherwise
    """
    if not model_name:
        return None

    # Case 1: If model_name contains a path separator, it's a direct path
    if os.path.sep in model_name:
        # Check if model_name is an absolute path and exists
        if os.path.isabs(model_name) and os.path.isfile(model_name):
            return model_name

        # Check if model_name is a relative path within models_dir
        model_path = os.path.join(models_dir, model_name)
        if os.path.isfile(model_path):
            return model_path

    # Case 2: Use enhanced model finding with fuzzy matching
    return find_model_in_directory(model_name, models_dir, use_fuzzy_matching=True)


def extract_parameter_size(model_name: str) -> float | None:
    """
    Extract parameter size in billions from the model name.

    Args:
        model_name: Name of the model

    Returns:
        Parameter size in billions as a float, or None if not found
    """
    # Common patterns for parameter sizes in model names
    patterns = [
        r"(\d+(\.\d+)?)[bB]",  # like "7b" or "13B" or "1.5B"
        r"-(\d+(\.\d+)?)[bB]",  # like "-7b" or "-13B"
        r"[_-](\d+(\.\d+)?)[bB]",  # like "_7b" or "_13B"
        r"\s(\d+(\.\d+)?)[bB]",  # like " 7b" or " 13B"
    ]

    for pattern in patterns:
        if match := re.search(pattern, model_name):
            try:
                return float(match.group(1))
            except (ValueError, AttributeError) as e:
                logger.debug("Could not parse param size from %s: %s", model_name, e)

    # Check for specific model families
    model_name_lower = model_name.lower()
    return next(
        (
            size
            for size, pattern in [
                (1.0, "1b"),
                (3.0, "3b"),
                (7.0, "7b"),
                (8.0, "8b"),
                (13.0, "13b"),
                (34.0, "34b"),
                (70.0, "70b"),
            ]
            if pattern in model_name_lower
        ),
        None,
    )


def calculate_model_compatibility(model_name: str) -> bool:
    """
    Calculate if a model is compatible with the current system
    based on its parameter size and available resources.

    Args:
        model_name: Name of the model to check

    Returns:
        True if model is compatible, False otherwise
    """
    try:
        # Extract parameter size from model name
        param_size = extract_parameter_size(model_name)
        if not param_size:
            # If we can't determine size, assume it's compatible
            return True

        # Check system resources
        # noinspection PyBroadException
        try:
            import psutil
            import torch

            # Check for GPU and get memory info
            if torch.cuda.is_available():
                # Get GPU memory in GB
                gpu_memory = torch.cuda.get_device_properties(0).total_memory / (1024**3)
                logger.info("GPU memory: %.2f GB", gpu_memory)

                # Rough estimate: model needs 2GB per billion parameters when quantized
                memory_needed = param_size * 2.0

                # If GPU has enough memory, it's compatible
                if gpu_memory >= memory_needed:
                    logger.info("Model %s (%sB) is GPU compatible", model_name, param_size)
                    return True

            # If no GPU or not enough GPU memory, check system RAM
            system_memory = psutil.virtual_memory().total / (1024**3)  # in GB
            logger.info("System memory: %.2f GB", system_memory)

            # CPU needs more memory per parameter
            memory_needed = param_size * 3.0

            if system_memory >= memory_needed:
                logger.info("Model %s (%sB) is CPU compatible", model_name, param_size)
                return True

            logger.warning("Model %s (%sB) requires %.2f GB RAM", model_name, param_size, memory_needed)
            return False

        except ImportError:
            psutil = None
            torch = None
            logger.warning("Couldn't check GPU / system resources, assuming model is compatible")
            return True

    except Exception as e:
        logger.error("Error calculating model compatibility: %s", e)
        return True  # In case of error, assume it's compatible


def validate_gpu_config(n_gpu_layers: int, max_layers: int = 1000) -> bool:
    """
    Validates GPU configuration parameters.

    Args:
        n_gpu_layers: Number of layers to offload to GPU
        max_layers: Maximum allowed layers (default 1000)

    Returns:
        bool: True if configuration is valid

    Raises:
        ValueError: If configuration is invalid
    """
    # Check if n_gpu_layers is negative
    if n_gpu_layers < 0:
        raise ValueError(f"Number of GPU layers cannot be negative: {n_gpu_layers}")

    # Check if n_gpu_layers is unreasonably large
    if n_gpu_layers > max_layers:
        raise ValueError(f"Number of GPU layers ({n_gpu_layers}) exceeds maximum allowed ({max_layers})")

    return True


async def check_service_health(service_url: str, timeout: float = 2.0) -> bool:
    """
    Check if a service is healthy by making a request to its health endpoint.

    Args:
        service_url: Base URL of the service
        timeout: Timeout in seconds for the request

    Returns:
        bool: True if service is healthy, False otherwise
    """
    try:
        import httpx

        async with httpx.AsyncClient() as client:
            response = await client.get(f"{service_url}/health", timeout=timeout)
            return response.status_code == 200
    except Exception as e:
        logger.debug("Service health check failed: %s", e)
        return False


def get_ollama_base_url(user_provider_config=None) -> str:
    """
    Get the Ollama base URL from user config or default config.

    Args:
        user_provider_config: Optional user provider configuration

    Returns:
        The Ollama base URL as a string
    """
    if user_provider_config and user_provider_config.get("api_base"):
        return user_provider_config.get("api_base")

    return resolved_config.get("llm", {}).get("models", {}).get("ollama", {}).get("base_url", "http://localhost:11434")


# =============================================================================
# LLM PROVIDER UTILITIES (from llm_provider_utils.py)
# =============================================================================


def extract_provider_credentials(provider) -> tuple[str | None, str | None]:
    """
    Extract API key and base URL from provider settings.

    Args:
        provider: Provider object with settings

    Returns:
        Tuple of (api_key, api_base)
    """
    api_key = None
    api_base = None
    if provider.settings:
        api_key = provider.settings.get("api_key")
        api_base = provider.settings.get("api_base")

    return api_key, api_base


def should_skip_provider(provider, api_key: str | None) -> bool:
    """
    Determine if a provider should be skipped based on API key availability.

    Args:
        provider: Provider object
        api_key: API key for the provider

    Returns:
        True if provider should be skipped, False otherwise
    """
    # Skip providers without API keys (except OpenRouter which can work without)
    if not api_key and provider.provider_type != "openrouter":
        logger.warning("Skipping provider %s - no API key configured", provider.id)
        return True

    return False


async def sync_provider_models_standard(
    sync_service,
    db,
    provider_id: str,
    provider_type: str,
    api_key: str | None,
    api_base: str | None,
    merge_and_cleanup: bool = True,
) -> tuple[bool, str, list]:
    """
    Standardized wrapper for syncing provider models with consistent parameter handling.

    Args:
        sync_service: RemoteModelSyncService instance
        db: Database session
        provider_id: Provider identifier
        provider_type: Type of provider
        api_key: API key for the provider
        api_base: Base URL for the provider API
        merge_and_cleanup: Whether to merge and cleanup models

    Returns:
        Tuple of (success, message, models)
    """
    try:
        success, message, models = await sync_service.sync_provider_models(
            db=db,
            provider_id=provider_id,
            provider_type=provider_type,
            api_key=api_key,
            api_base=api_base,
            merge_and_cleanup=merge_and_cleanup,
        )
        return success, message, models
    except Exception as ex:
        error_msg = f"Error syncing models for provider {provider_id}: {ex!s}"
        logger.error(error_msg)
        return False, error_msg, []


def log_sync_result(provider_type: str, provider_id: str, success: bool, message: str, models: list, context: str = "sync") -> None:
    """
    Log the result of a model sync operation.

    Args:
        provider_type: Type of provider
        provider_id: Provider identifier
        success: Whether the sync was successful
        message: Result message
        models: List of synced models
        context: Context for logging (e.g., "sync", "bulk_sync")
    """
    if success:
        logger.info("Successfully synced %d models from %s (ID: %s) in %s", len(models), provider_type, provider_id, context)
    else:
        logger.warning("⚠️ Failed to sync %s (ID: %s) in %s: %s", provider_type, provider_id, context, message)


# =============================================================================
# MODEL DATABASE UTILITIES (from model_utils.py)
# =============================================================================


def normalize_model_name(model_name: str, purpose: str = "display_to_model", model_namespace: str | None = None) -> str | None:
    """
    Unified model name normalization function that handles all normalization use cases.

    Args:
        model_name: The model name to normalize
        purpose: The purpose of normalization:
            - "display_to_model": Map UI-friendly display names to actual model names (default)
            - "model_to_display": Convert API model identifiers to human-readable display names
            - "file_path": Sanitize for use in file paths and IDs
            - "lowercase": Simple lowercase conversion for dictionary keys
            - "comparison": Normalize for model comparison (removes versions, formats)
            - "embedding_namespace": Handle embedding-specific namespace logic
        model_namespace: Optional namespace for embedding normalization

    Returns:
        Normalized model name based on the specified purpose
    """
    if not model_name:
        return "" if purpose == "file_path" else None if purpose == "lowercase" else model_name

    # Clean up any timestamp suffix that might be present (common to all purposes)
    cleaned_name = re.sub(r"-\d{13}$", "", model_name)

    if purpose == "model_to_display":
        # Convert API model identifier to human-readable display name
        # e.g., "deepseek/deepseek-r1-0528:free" -> "Deepseek R1 0528"

        # Remove provider prefix (e.g., "deepseek/deepseek-r1" -> "deepseek-r1")
        if "/" in cleaned_name:
            cleaned_name = cleaned_name.split("/")[-1]

        # Remove version suffixes like :free, :pro, etc.
        if ":" in cleaned_name:
            cleaned_name = cleaned_name.split(":")[0]

        # Replace hyphens and underscores with spaces
        cleaned_name = cleaned_name.replace("-", " ").replace("_", " ")

        # Title case each word
        words = cleaned_name.split()
        formatted_words = []
        for word in words:
            # Keep version numbers and special codes with proper casing
            if word.isdigit() or word.lower() in ["v1", "v2", "v3", "v4", "free", "pro"]:
                formatted_words.append(word.capitalize())
            else:
                formatted_words.append(word.capitalize())

        return " ".join(formatted_words)

    elif purpose == "display_to_model":
        # Map UI-friendly display names to actual model names via database lookup
        # If the name already contains a namespace (e.g., 'huggingface/model'), it's likely already normalized
        if "/" in cleaned_name:
            return cleaned_name

        try:
            # Query the database to map display_name to model_name
            with SessionLocal() as db_session:
                # Use raw SQL for maximum compatibility
                query = """
                    SELECT model_name
                    FROM model_provider_models
                    WHERE display_name = :display_name
                    LIMIT 1
                """

                result = db_session.execute(text(query), {"display_name": cleaned_name}).first()

                if result:
                    logger.info("Mapped display name '%s' to model name '%s'", cleaned_name, result[0])
                    return result[0]

                # If no mapping found in database, return the original name
                # Let the calling code handle model resolution through proper channels

                # If no mapping found, return the original name
                return cleaned_name

        except Exception as e:
            logger.error("Error mapping model name: %s", str(e))
            return cleaned_name

    elif purpose == "file_path":
        # Sanitize for use in file paths and IDs
        # Replace spaces and special characters with hyphens
        cleaned_name = re.sub(r"[^a-zA-Z0-9-]", "-", cleaned_name)
        # Convert to lowercase for consistency
        cleaned_name = cleaned_name.lower()
        # Remove duplicate hyphens
        cleaned_name = re.sub(r"-+", "-", cleaned_name)
        # Remove leading/trailing hyphens
        cleaned_name = cleaned_name.strip("-")
        return cleaned_name

    elif purpose == "lowercase":
        # Simple lowercase conversion for dictionary keys
        return cleaned_name.lower()

    elif purpose == "comparison":
        # Normalize for model comparison by removing common variations,
        # Convert to lowercase and replace common separators
        normalized = cleaned_name.lower().replace("_", "-").replace(" ", "-")
        # Remove version suffixes like -v1, -v2, etc.
        normalized = re.sub(r"-v\d+", "", normalized)
        # Remove format suffixes like -f16, -q8_0, etc.
        normalized = re.sub(r"-(f16|q8_0|q5_k_m|q4_k_m)$", "", normalized)
        return normalized

    elif purpose == "embedding_namespace":
        # Handle embedding-specific namespace logic
        # First, try to convert display name to model name
        converted_name = normalize_model_name(cleaned_name, "display_to_model")
        if converted_name != cleaned_name:
            logger.info("Converted display name '%s' to model name '%s'", cleaned_name, converted_name)
            cleaned_name = converted_name

        # If no namespace provided or model already has namespace, return as is
        # noinspection PyUnresolvedReferences
        if not model_namespace or "/" in cleaned_name:
            return cleaned_name

        # For sentence transformers models, always use the namespace
        if model_namespace == "sentence-transformers":
            return f"{model_namespace}/{cleaned_name}"

        # Special case for local models that should not be prefixed with namespace
        if model_namespace in ["local", "ollama"]:
            return cleaned_name

        # For models with specific namespaces
        if model_namespace and model_namespace not in cleaned_name:
            return f"{model_namespace}/{cleaned_name}"

        return cleaned_name

    else:
        # Default: return cleaned name
        return cleaned_name


async def get_model_config_from_db(
    provider: str | None = None,
    model_type: str = "chat",
    model_name: str | None = None,
    user_id: str | None = None,
    db_session=None,
) -> dict[str, Any] | None:
    """
    Get model configuration from the database.

    Args:
        provider: Optional provider name to filter by
        model_type: Type of model (chat, reasoning, embeddings)
        model_name: Optional specific model name
        user_id: Optional user ID for user-specific models
        db_session: Database session

    Returns:
        Dict with provider, model, and base_url keys, or None if not found
    """
    try:
        from sqlmodel import select

        from src.main.models.sqlmodel_providers import ModelProvider, ModelProviderModel

        if not db_session:
            logger.warning("No database session provided to get_model_config_from_db")
            return None

        # Build query using proper ORM now that ModelProvider and ModelProviderModel have all columns
        query = (
            select(ModelProviderModel, ModelProvider)
            .join(ModelProvider, ModelProviderModel.provider_id == ModelProvider.id)
            .where(ModelProvider.status == "active")
        )

        # Filter by model type - map chat/reasoning to database values
        if model_type:
            if model_type in ["reasoning", "chat"]:
                query = query.where(ModelProviderModel.model_type == "NORMAL")  # Fixed: Use NORMAL enum value
            elif model_type == "embeddings":
                query = query.where(ModelProviderModel.model_type == "EMBEDDING")  # Fixed: Use EMBEDDING enum value

        # Filter by provider
        if provider:
            query = query.where(ModelProvider.provider_type == provider)

        # Filter by model name
        if model_name:
            query = query.where(ModelProviderModel.model_name == model_name)

        # Prioritize user-specific models
        if user_id:
            user_query = query.where(ModelProvider.user_id == user_id)
            result = db_session.execute(user_query).first()
            if result:
                model, provider_obj = result[0], result[1]
                return {
                    "provider": provider_obj.provider_type,
                    "model": model.model_name,
                    "base_url": provider_obj.api_base,
                    "api_key": provider_obj.api_key,
                    "model_type": model.model_type,
                    "is_local": provider_obj.provider_type == "local",
                }

        # Fall back to system-wide models (user_id IS NULL)
        # noinspection PyUnresolvedReferences
        system_query = query.where(ModelProvider.user_id.is_(None))
        result = db_session.execute(system_query).first()
        if result:
            model, provider_obj = result[0], result[1]
            return {
                "provider": provider_obj.provider_type,
                "model": model.model_name,
                "base_url": provider_obj.api_base,
                "api_key": provider_obj.api_key,
                "model_type": model.model_type,
                "is_local": provider_obj.provider_type == "local",
            }

        # If no models found, return None
        logger.warning("No model found in database for type=%s, provider=%s, model_name=%s", model_type, provider, model_name)
        return None

    except Exception as e:
        logger.exception("Error querying model from database: %s", str(e))
        return None


# ---------------------------------------------------------------------------
# Context Window Lookup
# ---------------------------------------------------------------------------

_DEFAULT_CONTEXT_WINDOW = 128_000


def get_model_context_window(model_name: str) -> int:
    """Return the context window size (in tokens) for *model_name*.

    Looks up ``model_provider_models.context_window`` in the database.
    Falls back to ``_DEFAULT_CONTEXT_WINDOW`` (128 000) when the model is
    not found or the column is NULL.

    The lookup strips any ``provider/`` prefix so both ``"gpt-4o-mini"``
    and ``"openai/gpt-4o-mini"`` match.
    """
    bare_name = model_name.rsplit("/", 1)[-1] if "/" in model_name else model_name
    try:
        with SessionLocal() as db:
            row = db.execute(
                text("SELECT context_window FROM model_provider_models WHERE model_name = :name AND context_window IS NOT NULL LIMIT 1"),
                {"name": bare_name},
            ).first()
            if row and row[0]:
                return int(row[0])
            # Try with provider prefix
            row = db.execute(
                text("SELECT context_window FROM model_provider_models WHERE model_name = :name AND context_window IS NOT NULL LIMIT 1"),
                {"name": model_name},
            ).first()
            if row and row[0]:
                return int(row[0])
    except Exception as e:
        logger.warning("Could not look up context_window for %s: %s", model_name, str(e))
    return _DEFAULT_CONTEXT_WINDOW
