"""
Utility functions for local model management - synchronous alternatives to async functions
"""

import os
import re
from typing import Any

from sqlalchemy.orm import Session

from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger
from src.main.utils.gpu.devices import get_cached_gpu_availability
from src.main.utils.llm.provider_utils import get_system_provider

logger = get_logger(__name__)

# Shared model settings from config
MODELS_DIRECTORY = str(os.path.abspath(resolved_config.get("llm", {}).get("models_directory", "./data/models") or "./data/models"))


def list_installed_models(models_directory: str = None, gpu_available: bool = None) -> list[dict[str, Any]]:
    """
    Synchronous version of check_installed_models.
    Check for installed GGUF models in the specified directory.

    Args:
            models_directory: Directory to search for models
            gpu_available: Override for GPU availability detection

    Returns:
            List of installed models with their metadata
    """
    # Use the provided directory or the default
    models_dir = models_directory or MODELS_DIRECTORY

    # Use provided GPU status or the detected one
    has_gpu = gpu_available if gpu_available is not None else get_cached_gpu_availability()

    logger.info("Checking installed models in %s (GPU available: %s)", models_dir, has_gpu)

    result = []

    try:
        # Check if the directory exists
        if not os.path.exists(models_dir):
            logger.warning("Models directory does not exist: %s", models_dir)
            return []

        # Pattern to match GGUF model files
        model_pattern = re.compile(r"^(.+)\.gguf$", re.IGNORECASE)

        # List all files in the directory
        for filename in os.listdir(models_dir):
            match = model_pattern.match(filename)
            if match:
                model_name = match.group(1)
                model_path = os.path.join(models_dir, filename)

                # Get file size in MB
                size_mb = os.path.getsize(model_path) / (1024 * 1024)

                # Create model info
                model_info = {
                    "id": model_name,
                    "name": model_name,
                    "model_path": model_path,
                    "size_mb": round(size_mb, 2),
                    "status": "available",
                }

                result.append(model_info)

        logger.info("Found %s models: %s", len(result), [model["id"] for model in result])
        return result

    except Exception as e:
        logger.error("Error checking installed models: %s", str(e))
        # Return empty list on error
        return []


def get_available_local_models(db: Session) -> list[str]:
    """
    Get a list of available local model names from the database.

    Args:
            db: Database session

    Returns:
            List of available local model names
    """
    try:
        # Get the system provider for local models
        system_provider, _ = get_system_provider(db)

        if not system_provider:
            logger.warning("No system provider found for local models")
            return []

        # No active model concept anymore - users must explicitly select models
        logger.debug("No active model concept - users must explicitly select models")
        return []

    except Exception as e:
        logger.error("Error getting available local models: %s", str(e))
        return []
