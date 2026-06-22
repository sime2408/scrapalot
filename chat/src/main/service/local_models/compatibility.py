"""
Compatibility module for transitioning from old src.main.service.llm structure to new local_models structure.

This module provides re-exports of important functions and classes to maintain
backwards compatibility during the migration process.
"""

from src.main.service.local_models.create_model_utils import create_llama_cpp_chat_model, create_llama_cpp_llm

# Re-export important classes and functions
from src.main.service.local_models.llama_cpp_wrapper import LlamaCppChatModel
from src.main.service.local_models.local_llm_utils import (
    check_model_file_exists,
    ensure_models_directory_exists,
    find_gguf_files,
)
from src.main.utils.gpu.devices import get_cached_gpu_availability

# noinspection PyUnresolvedReferences
from src.main.utils.llm.model_utils import (
    ONE_DAY_IN_SECONDS,
    VALID_MODEL_EXTENSIONS,
    calculate_model_compatibility,
    check_service_health,
    clean_tags,
    determine_provider,
    extract_parameter_size,
    get_api_key,
    get_embedding_model,
    get_huggingface_token,
    get_model_icon,
    get_model_kwargs_with_token,
    get_ollama_base_url,
    validate_gpu_config,
)

# noinspection PyUnresolvedReferences
__all__ = [
    # Constants
    "ONE_DAY_IN_SECONDS",
    "VALID_MODEL_EXTENSIONS",
    # Classes
    "LlamaCppChatModel",
    "calculate_model_compatibility",
    # Functions from local_llm_utils
    "check_model_file_exists",
    "check_service_health",
    "clean_tags",
    "create_llama_cpp_chat_model",
    # Functions from create_model_utils
    "create_llama_cpp_llm",
    # Functions from llm_common_utils
    "determine_provider",
    "ensure_models_directory_exists",
    "extract_parameter_size",
    "find_gguf_files",
    "get_api_key",
    "get_cached_gpu_availability",
    # Functions from model_utils
    "get_embedding_model",
    "get_huggingface_token",
    "get_model_icon",
    "get_model_kwargs_with_token",
    "get_ollama_base_url",
    "validate_gpu_config",
]
