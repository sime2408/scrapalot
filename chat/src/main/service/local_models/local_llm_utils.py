"""
Local LLM Utility Functions

This module provides utility functions specifically for local LLM operations,
focused on model detection, hardware compatibility, and system resource management.
"""

import os

from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger
from src.main.utils.llm.model_utils import VALID_MODEL_EXTENSIONS
from src.main.utils.llm.model_utils import check_model_file_exists as _check_model_file_exists

logger = get_logger(__name__)

# GPU availability will be checked after function definition

# Path to the models directory
MODELS_DIRECTORY = str(os.path.abspath(resolved_config.get("llm", {}).get("models_directory", "./data/models") or "./data/models"))


def ensure_models_directory_exists(models_dir: str = None) -> str:
    """
    Create the models directory if it doesn't exist.

    Args:
            models_dir: Path to models directory, uses MODELS_DIRECTORY if None

    Returns:
            Path to the models directory
    """
    if not models_dir:
        models_dir = MODELS_DIRECTORY

    try:
        os.makedirs(models_dir, exist_ok=True)
    except OSError as e:
        logger.error("Failed to create models directory %s: %s", models_dir, e)

    return models_dir


def find_gguf_files(directory: str) -> list[str]:
    """
    Find all model files with valid extensions in directory and subdirectories.

    Args:
            directory: Directory to search in

    Returns:
            List of paths to model files
    """
    result = []
    try:
        for root, _, files in os.walk(directory):
            for file in files:
                if any(file.lower().endswith(ext) for ext in VALID_MODEL_EXTENSIONS):
                    result.append(os.path.join(root, file))
    except OSError as e:
        logger.error("Error searching for model files in %s: %s", directory, e)

    return result


# Import utility functions from common utils


def check_model_file_exists(model_name: str, models_dir: str = None) -> str | None:
    """
    Check if a model file exists for the given model name.
    This is a wrapper around the common utility function that uses the local models directory as default.

    Args:
            model_name: Name of the model to check
            models_dir: Base directory for models (defaults to MODELS_DIRECTORY)

    Returns:
            Path to the model file if found, None otherwise
    """
    if not models_dir:
        models_dir = MODELS_DIRECTORY

    # Ensure models directory exists before checking
    ensure_models_directory_exists(models_dir)

    return _check_model_file_exists(model_name, models_dir)


def is_gpu_available() -> bool:
    """Check if GPU is available for PyTorch."""
    # Deprecated: Use llm_manager.is_gpu_available instead
    from src.main.service.llm.llm_manager import llm_manager

    return llm_manager.is_gpu_available
