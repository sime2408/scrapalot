"""
Create Model Utilities

This module provides functions for creating and configuring local LLM models.
"""

import os
import platform
from typing import Any

from src.main.service.local_models.local_llm_utils import check_model_file_exists
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger
from src.main.utils.gpu.devices import get_cached_gpu_availability
from src.main.utils.llm.model_utils import find_model_in_directory, get_gguf_models_directory

# Note: huggingface_hub imports removed - using pattern-based detection instead


logger = get_logger(__name__)


# Removed get_model_metadata_from_hf - using pattern-based detection instead


def get_model_config_patterns() -> dict[str, dict[str, Any]]:
    """
    Load model configuration patterns from config.yaml.
    This provides centralized configuration management for model optimization.

    Returns:
        Dict mapping model patterns to their optimal configurations
    """
    try:
        # Get model patterns from resolved config
        model_patterns = resolved_config.get("llm", {}).get("model_patterns", {})

        if not model_patterns:
            logger.error("No model patterns found in config.yaml. Please ensure the 'llm.model_patterns' section is properly configured.")
            return {}

        logger.info("Loaded %s model pattern configurations from config.yaml", len(model_patterns))
        return model_patterns

    except Exception as e:
        logger.error("Failed to load model patterns from config: %s", e)
        return {}


def detect_model_pattern(model_name: str) -> tuple[str, str]:
    """
    Detect model family and version from model name using pattern matching.
    This works with GGUF files and various naming conventions.

    Args:
        model_name: Name of the model to analyze

    Returns:
        tuple of (model_family, version_key)
    """
    model_lower = model_name.lower()

    # DeepSeek patterns
    if "deepseek" in model_lower:
        if "r1" in model_lower:
            return "deepseek", "r1"
        elif "coder" in model_lower:
            return "deepseek", "coder"
        else:
            return "deepseek", "default"

    # Qwen patterns (updated for Qwen 3)
    elif "qwen" in model_lower:
        if "qwen3" in model_lower or "qwen-3" in model_lower or "qwen_3" in model_lower:
            return "qwen", "3"
        elif "2.5" in model_lower:
            return "qwen", "2.5"
        elif "qwen2" in model_lower or "qwen-2" in model_lower:
            return "qwen", "2"
        else:
            return "qwen", "default"

    # Llama patterns (updated for Llama 4)
    elif "llama" in model_lower:
        if "llama4" in model_lower or "llama-4" in model_lower or "llama_4" in model_lower:
            return "llama", "4"
        elif "3.1" in model_lower:
            return "llama", "3.1"
        elif "llama3" in model_lower or "llama-3" in model_lower:
            return "llama", "3"
        else:
            return "llama", "default"

    # LM Studio patterns
    elif "lmstudio" in model_lower:
        return "lmstudio", "default"

    # Unknown pattern (CodeLlama removed)
    else:
        return "unknown", "default"


def get_optimized_model_config(model_name: str, is_windows: bool = False) -> dict[str, Any]:
    """
    Generate optimized model configuration based on model name patterns.
    This approach works with GGUF files and doesn't rely on Hugging Face Hub.

    Args:
        model_name: Name of the model (including GGUF files)
        is_windows: Whether running on Windows platform

    Returns:
        Dict containing optimized model parameters
    """
    config = {}
    patterns = get_model_config_patterns()
    model_family, version_key = detect_model_pattern(model_name)

    if model_family in patterns:
        pattern = patterns[model_family]

        # Get context window size
        context_windows = pattern["context_windows"]
        max_context = context_windows.get(version_key, context_windows["default"])

        # Apply platform-specific limits
        if is_windows:
            # Reduce context size on Windows for memory management
            max_context = min(max_context, max_context // 2)

        # Set context size (cap at reasonable limits)
        context_size = min(max_context, 32768 if not is_windows else 16384)
        config["n_ctx"] = context_size

        # Calculate batch size
        batch_size = max(pattern["min_batch"], context_size // pattern["batch_ratio"])
        config["n_batch"] = batch_size

        # Set GPU layers boost
        config["gpu_layers_boost"] = pattern["gpu_layers_boost"]

        logger.info(
            "%s model detected (%s): context=%s, batch=%s, gpu_boost=%s",
            model_family.title(),
            version_key,
            context_size,
            batch_size,
            pattern["gpu_layers_boost"],
        )

    else:
        # Fallback for unknown models
        context_size = 4096 if not is_windows else 2048
        config["n_ctx"] = context_size
        config["n_batch"] = max(32, context_size // 128)
        config["gpu_layers_boost"] = 5
        logger.info("Unknown model pattern: using safe defaults context=%s, batch=%s", context_size, config["n_batch"])

    return config


def get_default_gpu_layers() -> int:
    """
    Determine the default number of GPU layers to use based on system capabilities.

    Returns:
        int: Number of GPU layers (0 if no GPU available)
    """
    # Use the cached GPU availability function to determine if GPU is available
    if get_cached_gpu_availability():
        # Try to get GPU memory information for smarter layer calculation
        try:
            from src.main.service.local_models.model_service import GPU_MEMORY

            if GPU_MEMORY > 12:  # 12+ GB GPU memory
                return 35  # Most layers for high-end GPUs
            elif GPU_MEMORY > 8:  # 8-12 GB GPU memory
                return 25  # Good amount of layers for mid-range GPUs
            elif GPU_MEMORY > 4:  # 4-8 GB GPU memory
                return 15  # Moderate layers for entry-level GPUs
            else:  # Less than 4 GB GPU memory
                return 5  # Conservative layers for low-memory GPUs
        except ImportError:
            # Fallback to conservative default if GPU_MEMORY not available
            return 1
    return 0


def create_llama_cpp_llm(model_name: str, model_path_str: str = None, _temperature: float = 0.1, **kwargs) -> Any:
    """
    Create a LlamaCpp model with the specified parameters, using the model_service
    for model lifecycle management when possible.

    Args:
        model_name: Name of the model
        model_path_str: Path to the model file
        _temperature: Temperature for generation (not currently used; handled via kwargs)
        **kwargs: Additional parameters for LlamaCpp

    Returns:
        LlamaCpp model instance or None if creation fails

    Raises:
        ImportError: If LlamaCpp is not available
        FileNotFoundError: If the model file cannot be found
        MemoryError: If there's not enough memory to load the model
    """
    # Check if local AI is enabled before attempting to import
    local_ai_enabled = resolved_config.get("llm", {}).get("local_ai", {}).get("enabled", False)
    if not local_ai_enabled:
        logger.info("Local AI is disabled, cannot create LlamaCpp model")
        raise ImportError("Local AI is disabled in configuration")

    # Import here to handle the case where llama-cpp-python is not installed
    try:
        from llama_cpp import Llama

        # Try to import LogLevel from different locations based on a package version
        try:
            pass
        except ImportError:
            try:
                pass
            except ImportError:
                pass

    except ImportError as e:
        logger.warning("Failed to import llama-cpp-python: %s", str(e))
        import sys

        logger.error("Python path: %s", sys.path)
        logger.error("llama-cpp-python not installed or not in the Python path. Please install it with: pip install llama-cpp-python")
        raise ImportError(f"llama-cpp-python is not installed: {e!s}") from e

    # Find the model file
    if not model_path_str:
        # noinspection PyTypeChecker
        model_path_str = check_model_file_exists(model_name)

    if not model_path_str or not os.path.exists(model_path_str):
        logger.error("DEPLOYMENT_HALTING_ERROR: Model file not found for %s", model_name)
        raise FileNotFoundError(f"DEPLOYMENT_HALTING_ERROR: Model file not found for {model_name}")

    model_path_str = str(model_path_str)

    # Check a platform
    is_windows = platform.system().lower() == "windows"
    if is_windows:
        logger.info("Windows detected, disabling use_mlock")
        use_mlock = False
    else:
        use_mlock = kwargs.get("use_mlock", True)

    # Pattern-based model configuration (works with GGUF files and any naming)
    optimized_config = get_optimized_model_config(model_name, is_windows)

    # Apply optimized configuration with kwargs override
    context_size = int(kwargs.get("n_ctx", optimized_config.get("n_ctx", 2048 if not is_windows else 1024)) or 2048)
    batch_size = int(kwargs.get("n_batch", optimized_config.get("n_batch", max(32, context_size // 64))) or 32)

    # GPU layer optimization
    default_gpu_layers = get_default_gpu_layers()
    gpu_layers_boost = optimized_config.get("gpu_layers_boost", 0)
    if get_cached_gpu_availability() and default_gpu_layers > 0:
        default_gpu_layers = min(40, default_gpu_layers + gpu_layers_boost)
    gpu_layers = kwargs.get("n_gpu_layers", default_gpu_layers)

    # Check for Vulkan backend preference from config
    vulkan_config = resolved_config.get("llm", {}).get("advanced", {}).get("vulkan", {})
    prefer_vulkan = vulkan_config.get("enabled", True) and vulkan_config.get("prefer_vulkan", False)
    force_vulkan = kwargs.get("force_vulkan", False)
    force_cpu = kwargs.get("force_cpu", False)

    if kwargs.get("verbose", False) or kwargs.get("force_gpu_layers_log", False):
        backend_info = "CPU" if force_cpu or gpu_layers == 0 else f"GPU ({gpu_layers} layers)"
        if prefer_vulkan or force_vulkan:
            backend_info += " with Vulkan backend preference"
        logger.info("Using %s for model %s", backend_info, model_name)

    # Get model parameters
    model_kwargs = {
        "model_path": model_path_str,
        "n_ctx": context_size,
        "n_batch": batch_size,
        "n_gpu_layers": gpu_layers,
        "use_mlock": use_mlock,
        "verbose": kwargs.get("verbose", False),
        "seed": kwargs.get("seed", -1),  # -1 means random seed
        # Disable embedding for text generation models (not embedding models)
        "embedding": kwargs.get("embedding", False),
    }

    # Windows-specific adjustments to prevent access violations
    if is_windows:
        # Set specific options to improve Windows stability
        model_kwargs["offload_kqv"] = True  # Offload key / query / value matrices to reduce memory usage
        model_kwargs["flash_attn"] = False  # Disable flash attention on Windows

    # Add optional additional parameters if provided
    for param_name, param_value in kwargs.items():
        if param_name not in model_kwargs and param_name != "temperature":
            model_kwargs[param_name] = param_value

    # Log model parameters
    logger.info("LlamaCpp initialization parameters: %s", model_kwargs)

    try:
        # Set chat format if provided
        if chat_format := kwargs.get("chat_format"):
            model_kwargs["chat_format"] = chat_format

        # Create the model with proper error handling
        try:
            logger.info("Creating LlamaCpp model: %s", model_name)
            model = Llama(**model_kwargs)
        except Exception as e:
            error_str = str(e).lower()
            # Handle DeepSeek R1 tokenizer compatibility issues
            if "unknown pre-tokenizer type" in error_str and ("deepseek-r1" in error_str or "deepseek-r1-qwen" in error_str):
                logger.warning("DeepSeek R1 tokenizer not supported in current llama-cpp-python version: %s", str(e))
                logger.info("Attempting to load with generic chat format fallback...")

                # Try with generic chat format to bypass tokenizer issues
                model_kwargs_fallback = model_kwargs.copy()
                model_kwargs_fallback["chat_format"] = "chatml"  # Use generic ChatML format
                model_kwargs_fallback["vocab_only"] = False  # Ensure full model loading

                try:
                    model = Llama(**model_kwargs_fallback)
                    logger.info("Successfully loaded DeepSeek R1 model with ChatML format fallback")
                except Exception as fallback_e:
                    logger.error("Fallback attempt also failed: %s", str(fallback_e))
                    raise RuntimeError(
                        f"DeepSeek R1 model requires newer llama-cpp-python version. "
                        f"Current version doesn't support 'deepseek-r1-qwen' tokenizer. "
                        f"Please update llama-cpp-python or use a different model. "
                        f"Original error: {e!s}"
                    ) from fallback_e

            # Windows-specific handling for memory issues
            elif is_windows and ("access violation" in error_str or "memory" in error_str):
                logger.warning("First loading attempt failed with: %s. Trying with reduced parameters.", str(e))
                # Try with drastically reduced parameters for Windows
                model_kwargs["n_ctx"] = 1024  # Minimal context size
                model_kwargs["n_batch"] = 16  # Very small batch size
                model_kwargs["n_ctx"] = 512  # Minimal context size
                model_kwargs["n_batch"] = 8  # Very small batch size
                model_kwargs["n_threads"] = 1  # Single thread
                logger.info("Retrying with reduced parameters: %s", model_kwargs)
                model = Llama(**model_kwargs)
            else:
                # Re-raise if not a known issue
                raise

        # Test the model safely
        test_prompt = "Test"
        try:
            if is_windows:
                # On Windows, just test tokenization which is safer
                _ = model.tokenize(test_prompt.encode("utf-8"))
                logger.info("Successfully initialized LlamaCpp model: %s (tokenizer test)", model_name)
            else:
                # Full generation test on non-Windows platforms
                _ = model(prompt=test_prompt, max_tokens=1)
                logger.info("Successfully initialized and tested LlamaCpp model: %s", model_name)
        except Exception as e:
            logger.error("DEPLOYMENT_HALTING_ERROR: Model loaded but failed to use: %s", str(e))
            # Clean up to avoid memory leaks
            if hasattr(model, "_model"):
                # noinspection PyProtectedMember
                del model._model
            if hasattr(model, "model"):
                # noinspection PyPropertyAccess
                del model.model
            raise RuntimeError(f"Model loaded but failed to use: {e!s}") from e

        return model

    except (MemoryError, RuntimeError) as e:
        # Critical error that should halt deployment
        error_msg = str(e)
        if "Unable to allocate" in error_msg or "Failed to load" in error_msg:
            logger.error("DEPLOYMENT_HALTING_ERROR: Not enough memory to load model %s: %s", model_name, error_msg)
            raise MemoryError(f"DEPLOYMENT_HALTING_ERROR: Not enough memory to load model {model_name}: {error_msg}") from e
        else:
            logger.error("DEPLOYMENT_HALTING_ERROR: Runtime error loading model %s: %s", model_name, error_msg)
            raise RuntimeError(f"DEPLOYMENT_HALTING_ERROR: Runtime error loading model {model_name}: {error_msg}") from e
    except Exception as e:
        logger.error("Error creating LlamaCpp model: %s", str(e))
        raise


def create_llama_cpp_chat_model(model_name: str, model_path_str: str = None, temperature: float = 0.1, **kwargs) -> Any:
    """
    Create a LlamaCpp chat model wrapper with the specified parameters.

    Args:
        model_name: Name of the model
        model_path_str: Path to the model file
        temperature: Temperature for generation
        **kwargs: Additional parameters for LlamaCpp

    Returns:
        LlamaCppChatModel instance wrapping a LlamaCpp model or None if creation fails

    Raises:
        ImportError: If LlamaCpp is not available
        FileNotFoundError: If the model file cannot be found
        MemoryError: If there's not enough memory to load the model
    """
    try:
        # Import the wrapper class
        from src.main.service.local_models.llama_cpp_wrapper import LlamaCppChatModel

        # Create the base LlamaCpp model
        llama_cpp_model = create_llama_cpp_llm(model_name, model_path_str, temperature, **kwargs)

        # Wrap the model with the LlamaCppChatModel
        logger.info("Creating LlamaCppChatModel wrapper for %s", model_name)
        model = LlamaCppChatModel(llm=llama_cpp_model, model_name=model_name, temperature=temperature, **kwargs)

        return model
    except Exception as e:
        logger.error("Error creating LlamaCppChatModel: %s", str(e))
        raise


def create_local_model_for_factory(model_name: str, **kwargs) -> Any:
    """
    Create a local model for use with the LLM factory.

    This function handles all local model resolutions, fallbacks, and initialization
    for the llm_factory. It centralizes the local model handling code.

    Args:
        model_name: The name of the model to use
        **kwargs: Additional parameters for model creation

    Returns:
        A BaseChatModel - compatible instance

    Raises:
        ValueError: If the model cannot be found and no fallbacks are available
    """
    import os

    # Check if local AI is enabled before attempting any local model operations
    local_ai_enabled = resolved_config.get("llm", {}).get("local_ai", {}).get("enabled", False)
    if not local_ai_enabled:
        logger.info("Local AI is disabled, cannot create local model for: %s", model_name)
        raise ValueError("Local AI is disabled in configuration")

    # Use existing imports
    # Check if this is an embedding model by querying the database
    # Embedding models should be handled by the embedding system, not as local GGUF files
    try:
        from sqlalchemy import text

        from src.main.config.database import SessionLocal

        # Query the database to check if this is an embedding model
        with SessionLocal() as db:
            result = db.execute(
                text("SELECT model_type FROM model_provider_models WHERE model_name = :model_name"),
                {"model_name": model_name},
            ).first()

            if result and result[0] == "EMBEDDING":
                logger.warning(
                    "Model %s is an EMBEDDING model. This should be handled by the embedding system, not as a local GGUF file.",
                    model_name,
                )
                raise ValueError(f"Model {model_name} is an EMBEDDING model. Embedding models should be handled by the embedding system.")
    except ValueError as ve:
        # Re-raise ValueError for embedding models - this is the intended behavior
        raise ve from ve
    except Exception as e:
        # If database query fails for other reasons, continue with the original logic
        # This ensures the function still works even if there are DB issues
        logger.debug("Could not check model type from database: %s. Continuing with local model processing.", str(e))

    # Get the models directory from config
    models_dir = str(resolved_config.get("llm", {}).get("models_directory", "models") or "models")
    models_dir = os.path.abspath(models_dir)
    logger.info("Using models directory: %s", models_dir)

    # Get the GGUF models directory using centralized utility
    gguf_dir = get_gguf_models_directory()

    # Try to find the model using centralized utility
    model_path = find_model_in_directory(model_name, gguf_dir, use_fuzzy_matching=True)

    # If a model is found, create and return it
    if model_path:
        temp_value = kwargs.get("temperature", 0.1)
        return create_llama_cpp_chat_model(model_name, model_path, temp_value, **kwargs)

    # If the model is not found, try fallbacks
    logger.warning("Local model file not found for model: %s, will try fallbacks", model_name)

    # First try the CPU model from config
    local_cpu_model = resolved_config.get("llm", {}).get("models", {}).get("local", {}).get("models", {}).get("chat")

    if local_cpu_model:
        logger.info("Trying configured CPU model: %s", local_cpu_model)
        if fallback_path := check_model_file_exists(local_cpu_model, models_dir):
            logger.info("Found configured CPU model: %s at %s", local_cpu_model, fallback_path)
            temp_value = kwargs.get("temperature", 0.1)
            return create_llama_cpp_chat_model(local_cpu_model, fallback_path, temp_value, **kwargs)

    # Try common model patterns that might exist
    common_patterns = [
        # Local models removed - using remote providers only
    ]

    # Try each fallback model with enhanced discovery
    for fallback_model in common_patterns:
        logger.info("Trying fallback model: %s", fallback_model)

        # Use the centralized utility for fallbacks too
        fallback_path = find_model_in_directory(fallback_model, gguf_dir, use_fuzzy_matching=True)

        if fallback_path:
            logger.info("Found fallback model: %s at %s", fallback_model, fallback_path)
            temp_value = kwargs.get("temperature", 0.1)
            return create_llama_cpp_chat_model(fallback_model, fallback_path, temp_value, **kwargs)

    # If we get here, no physical model files were found including fallbacks
    logger.warning("No local model files found on this system, including fallbacks")

    # Instead of failing completely, return a mock LLM that directs users to download models
    # This allows the application to the start even without local models

    # Check if langchain dependencies are available
    try:
        from langchain_community.llms import FakeListLLM
        from langchain_core.messages import AIMessage as LangChainAIMessage

        langchain_available = True
    except ImportError:
        logger.warning("LangChain dependencies not available, using basic fallback")
        langchain_available = False
        # noinspection PyPep8Naming
        FakeListLLM = None
        # noinspection PyPep8Naming
        LangChainAIMessage = None

    responses = [
        "I'm sorry, but no local AI models were found on this system. "
        "To use local AI features, please download at least one compatible model "
        "file and place it in the 'data/models' directory. Recommended models include: "
        "llama3-8b-instruct-q5_K_M, or any GGUF format model. "
        "For now, you can use cloud-based providers if configured, or check the application "
        "documentation for model setup instructions.",
        "No local AI models are installed. Please download a compatible GGUF format "
        "model to the 'data/models' directory. Visit the documentation for setup instructions.",
        "Local AI is not available because no model files were found. Please install "
        "a compatible GGUF model file in the models directory to enable local AI features.",
    ]

    if langchain_available and FakeListLLM is not None:
        # noinspection PyCallingNonCallable
        mock_llm = FakeListLLM(responses=responses)
        logger.info("Created fallback message provider due to missing local models")
    else:
        mock_llm = None
        logger.info("Created basic fallback due to missing local models and LangChain dependencies")

    # Create a mock AIMessage class that mimics LangChain's AIMessage interface
    class MockAIMessage:
        """Mock AIMessage that provides the same interface as LangChain's AIMessage."""

        def __init__(self, content: str, **msg_kwargs):
            self.content = content
            self.type = "ai"
            self.additional_kwargs = msg_kwargs.get("additional_kwargs", {})
            self.response_metadata = msg_kwargs.get("response_metadata", {})
            self.id = msg_kwargs.get("id")
            self.usage_metadata = msg_kwargs.get("usage_metadata", {})

        def __str__(self):
            return f"MockAIMessage(content='{self.content}')"

        def __repr__(self):
            return f"MockAIMessage(content='{self.content}', type='{self.type}')"

    # Create a chat model wrapper for the mock LLM

    class MockChatModel:
        def __init__(self, llm):
            self.llm = llm

        # Removed deprecated ConversationBufferMemory - memory handling moved to application level

        @staticmethod
        async def ainvoke(_messages=None, **_kw):
            if langchain_available and LangChainAIMessage:
                return LangChainAIMessage(content=responses[0])
            else:
                # Return a mock object that mimics AIMessage interface per LangChain standards
                return MockAIMessage(content=responses[0])

        @staticmethod
        def invoke(_messages=None, **_kw):
            if langchain_available and LangChainAIMessage:
                return LangChainAIMessage(content=responses[0])
            else:
                # Return a mock object that mimics AIMessage interface per LangChain standards
                return MockAIMessage(content=responses[0])

        @staticmethod
        async def astream(_input=None, **_kw):
            """Stream the response character by character to simulate streaming behavior."""
            # Get the response content
            content = responses[0]

            # Simulate streaming by yielding chunks
            # Split into words for a more realistic streaming experience
            words = content.split()
            for i, word in enumerate(words):
                # Add space before word except for the first one
                chunk_text = word if i == 0 else f" {word}"

                # Create a mock chunk that mimics LangChain streaming chunks
                if langchain_available and LangChainAIMessage:
                    # Use LangChain's AIMessage chunk format
                    chunk = LangChainAIMessage(content=chunk_text)
                else:
                    # Use our mock chunk format
                    chunk = MockAIMessage(content=chunk_text)

                yield chunk

    return MockChatModel(mock_llm)
