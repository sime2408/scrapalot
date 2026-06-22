"""
Service module for managing local LLM models using llama-cpp-python directly.

This module provides functionality to:
- Load and run GGUF models using LlamaCpp
- Support both CPU and GPU inference
- Manage model lifecycle (loading / unloading)
- Track active models and their status
"""

from datetime import datetime
import gc
import os
import re
import threading
import time
from typing import Any

from sqlalchemy import create_engine, text

from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger
from src.main.utils.gpu.devices import (
    get_cached_gpu_availability,
    get_cached_gpu_info,
    get_cached_gpu_memory,
    get_cached_gpu_name,
)
from src.main.utils.llm.model_utils import normalize_model_name

logger = get_logger(__name__)

# Deferred import of llama_cpp - only import when local AI is enabled
# Global variables for llama-cpp-python components
Llama = None
LlamaGrammar = None
LLAMA_CPP_AVAILABLE = False
llama_logger = None


def _ensure_llama_cpp_imported():
    """
    Import llama_cpp components only when needed and local AI is enabled.
    This prevents import errors when llama-cpp-python is not installed but local AI is disabled.
    """
    global Llama, LlamaGrammar, LLAMA_CPP_AVAILABLE, llama_logger

    if LLAMA_CPP_AVAILABLE:
        return True

    # Check if local AI is enabled before attempting import
    local_ai_enabled = resolved_config.get("llm", {}).get("local_ai", {}).get("enabled", False)
    if not local_ai_enabled:
        logger.info("Local AI is disabled, skipping llama-cpp-python import")
        return False

    try:
        import logging

        from llama_cpp import Llama as _Llama
        from llama_cpp import LlamaGrammar as _LlamaGrammar

        Llama = _Llama
        LlamaGrammar = _LlamaGrammar
        llama_logger = logging.getLogger("llama-cpp-python")
        LLAMA_CPP_AVAILABLE = True
        logger.info("Successfully imported llama-cpp-python")
        return True

    except ImportError as e:
        import sys

        logger.warning("llama-cpp-python not available: %s", str(e))
        logger.info("Python path: %s", sys.path)
        logger.info("llama-cpp-python not installed. Install with: pip install llama-cpp-python")
        return False

    except Exception as e:
        logger.warning("Unexpected error importing llama-cpp-python: %s", str(e))
        logger.info("This might be due to library compatibility issues. Local LLM support will be disabled.")
        return False


# Check for GPU support
try:
    import torch
except ImportError:
    torch = None

# GPU availability check function is imported from local_llm_utils

# Import GPU utilities - use centralized GPU detection to avoid circular dependencies

# Global variables to track loaded models and their status
MODEL_PROCESSES = {}
MODEL_STATUS = {}

# Path to the models directory
MODELS_DIRECTORY = str(os.path.abspath(resolved_config.get("llm", {}).get("models_directory", "./data/models") or "./data/models"))

# Import for memory errors
try:
    import psutil
except ImportError:
    psutil = None
    logger.warning("psutil not available, will not be able to check system memory")


def _get_model_hardware_requirements() -> dict[str, dict[str, int]]:
    """
    Fetch hardware requirements for all models from the database.

    Returns:
        Dictionary mapping model_name (lowercase) to a dict with min_gpu_memory_mb and min_cpu_memory_mb
    """
    try:
        # Import the database URL and type
        from src.main.config.database import DB_SCHEMA, DB_TYPE, SQLALCHEMY_DATABASE_URL

        # Create a synchronous engine
        engine = create_engine(SQLALCHEMY_DATABASE_URL or "")

        with engine.connect() as conn:
            # Query the model_provider_models table for hardware requirements
            # Adjust the table name based on the database type
            if DB_TYPE == "sqlite":
                # For SQLite, don't use schema prefix
                query = text("""
                    SELECT model_name, min_gpu_memory_mb, min_cpu_memory_mb
                    FROM model_provider_models
                """)
            else:
                # For PostgreSQL, use the schema prefix
                query = text(f"""
                    SELECT model_name, min_gpu_memory_mb, min_cpu_memory_mb
                    FROM {DB_SCHEMA}.model_provider_models
                """)

            result = conn.execute(query)  # type: ignore[arg-type]

            # Create a dictionary mapping model_name to hardware requirements
            requirements = {}
            for row in result.fetchall():
                model_name = row[0].lower()  # Normalize to lowercase
                min_gpu_memory = row[1]  # This might be None
                min_cpu_memory = row[2]  # This might be None

                requirements[model_name] = {"min_gpu_memory_mb": min_gpu_memory, "min_cpu_memory_mb": min_cpu_memory}

            logger.info("Loaded hardware requirements for %s models", len(requirements))
            return requirements

    except Exception as ex:
        logger.error("Error fetching hardware requirements from database: %s", str(ex))
        return {}


def check_installed_models(models_directory=None, gpu_available=None) -> list[dict[str, Any]]:
    """
    Check which models are installed locally by scanning the models directory for GGUF files.
    Filters models based on hardware requirements if GPU is not available.

    Args:
        models_directory: Directory to search for models
        gpu_available: Override for GPU availability detection

    Returns:
        List of installed model objects with metadata
    """
    try:
        models = []

        # Use provided models directory or default
        models_dir = models_directory if models_directory else MODELS_DIRECTORY

        # Use provided GPU availability or default
        gpu_avail = gpu_available if gpu_available is not None else get_cached_gpu_availability()

        # Ensure the models directory exists
        os.makedirs(models_dir, exist_ok=True)

        # Walk through the models directory to find all GGUF files
        for root, _, files in os.walk(models_dir):
            for file in files:
                if file.lower().endswith(".gguf"):
                    file_path = os.path.join(root, file)
                    file_size = os.path.getsize(file_path) / (1024 * 1024)  # Size in MB

                    # Extract model name and parameter size from filename
                    display_name = str(os.path.splitext(file)[0])
                    # Create a normalized lowercase version for the name to prevent case sensitivity issues
                    model_name = display_name.lower()

                    # Log both the original filename and the normalized name for debugging
                    logger.info("Found model file: %s", file_path)
                    logger.info("Using normalized model name: %s", model_name)

                    # Try to estimate parameter size from filename
                    param_size = None
                    for pattern in [
                        r"(\d+[bB])",  # Match patterns like 7B, 13b, etc.
                        r"-(\d+[bB])",  # Match patterns like -7B, -13b
                        r"_(\d+[bB])",  # Match patterns like _7B, _13b
                    ]:
                        match = re.search(pattern, model_name)
                        if match:
                            param_size = match.group(1)
                            break

                    # Get hardware requirements
                    hardware_req = "CPU"  # Default to CPU
                    min_gpu_memory_mb = None
                    min_cpu_memory_mb = None

                    # Try to get hardware requirements from the database
                    model_hardware_requirements = _get_model_hardware_requirements()
                    if model_name in model_hardware_requirements:
                        hw_info = model_hardware_requirements[model_name]
                        min_gpu_memory_mb = hw_info.get("min_gpu_memory_mb")
                        min_cpu_memory_mb = hw_info.get("min_cpu_memory_mb")

                        # Determine hardware requirement type
                        if min_gpu_memory_mb and not min_cpu_memory_mb:
                            hardware_req = "GPU"  # GPU only
                        elif min_gpu_memory_mb and min_cpu_memory_mb:
                            hardware_req = "CPU_GPU"  # Can run on too
                        else:
                            hardware_req = "CPU"  # CPU only or unknown
                    else:
                        # Try to guess based on param size
                        if param_size:
                            size_num = re.search(r"(\d+)", param_size)
                            if size_num and int(size_num.group(1)) >= 7:
                                hardware_req = "GPU"
                                logger.info("Estimated GPU requirement for large model %s with param size %s", model_name, param_size)

                    # Skip GPU-only models if no GPU is available
                    if not gpu_avail and hardware_req == "GPU":
                        logger.warning("Skipping GPU - required model %s because no GPU is available", display_name)
                        continue

                    # Add the model to the list
                    models.append(
                        {
                            "id": model_name,
                            "name": display_name,
                            "path": file_path,
                            "size_mb": round(file_size, 2),
                            "param_size": param_size,
                            "min_gpu_memory_mb": min_gpu_memory_mb,
                            "min_cpu_memory_mb": min_cpu_memory_mb,
                            "hardware_requirements": hardware_req,
                            "last_modified": datetime.fromtimestamp(os.path.getmtime(file_path)).isoformat(),
                            "installed_date": datetime.fromtimestamp(os.path.getctime(file_path)).isoformat(),
                        }
                    )

        return models
    except Exception as exc:
        logger.error("Error checking installed models: %s", str(exc))
        return []


async def check_installed_models_async(models_directory=None, gpu_available=None) -> list[dict[str, Any]]:
    """
    Async version of check_installed_models.
    Check for installed GGUF models in the specified directory.

    Args:
        models_directory: Directory to search for models
        gpu_available: Override for GPU availability detection

    Returns:
        List of installed model objects with metadata
    """
    # Call the synchronous version - this allows the function to be awaited
    # without actually blocking the event loop since it's mostly I/O operations
    return check_installed_models(models_directory, gpu_available)


def initialize_local_ai_service() -> dict[str, Any]:
    """
    Initialize the LlamaCpp environment by ensuring the models directory exists
    and checking for available models.

    Returns:
        Dictionary with initialization result information
    """
    try:
        # Check if llama-cpp-python is available (will attempt import if local AI is enabled)
        if not _ensure_llama_cpp_imported():
            logger.info("llama-cpp-python is not available or local AI is disabled. Local LLM functionality will be disabled.")
            return {
                "success": False,
                "error": "llama-cpp-python is not available",
                "message": "Local LLM functionality is disabled because llama-cpp-python is not installed or local AI is disabled.",
            }

        # Ensure the models directory exists
        os.makedirs(MODELS_DIRECTORY, exist_ok=True)
        logger.info("Models directory: %s", MODELS_DIRECTORY)

        # Check for installed models
        installed_models = check_installed_models()
        if not installed_models:
            logger.warning("No GGUF models found in the models directory.")
            return {
                "success": True,
                "warning": "No models found",
                "message": f"No GGUF models found in {MODELS_DIRECTORY}. Please add some models to use LlamaCpp.",
                "models_directory": MODELS_DIRECTORY,
            }

        # Check GPU availability
        gpu_info = ""
        if get_cached_gpu_availability():
            gpu_info = f" with GPU support ({get_cached_gpu_name()})"

        logger.info("LlamaCpp initialized successfully%s. Found %s models.", gpu_info, len(installed_models))
        return {
            "success": True,
            "message": f"LlamaCpp initialized successfully{gpu_info}.",
            "models_count": len(installed_models),
            "models_directory": MODELS_DIRECTORY,
            "gpu_available": get_cached_gpu_availability(),
            "gpu_name": get_cached_gpu_name() if get_cached_gpu_availability() else None,
        }

    except Exception as exc:
        logger.error("Error initializing LlamaCpp environment: %s", str(exc))
        return {"success": False, "error": str(exc), "message": f"Error initializing LlamaCpp environment: {exc!s}"}


async def check_service_status() -> dict[str, Any]:
    """
    Check if any LlamaCpp models are currently loaded and running.

    Returns:
        Dictionary with model status information
    """
    try:
        # Check if llama-cpp-python is available (will attempt import if local AI is enabled)
        if not _ensure_llama_cpp_imported():
            return {
                "success": False,
                "error": "llama-cpp-python is not available",
                "message": "Local LLM functionality is disabled because llama-cpp-python is not installed or local AI is disabled.",
            }

        # Get a list of installed models
        await check_installed_models_async()

        # Check if any models are running
        if not MODEL_PROCESSES:
            return {"running": False, "message": "No models are currently loaded"}

        # Find any running models
        running_models = []
        for model_id, process_info in MODEL_PROCESSES.items():
            if process_info.get("status") in ["running", "ready"] and process_info.get("llm"):
                running_models.append(
                    {
                        "model_id": model_id,
                        "status": process_info.get("status"),
                        "model_path": process_info.get("model_path", ""),
                        "gpu_layers": process_info.get("gpu_layers", 0),
                    }
                )

        if not running_models:
            return {"running": False, "message": "No models are currently running"}

        # Return info about running models
        return {
            "running": True,
            "message": f"{len(running_models)} model(s) are running",
            "running_models": running_models,
        }

    except Exception as ex:
        logger.error("Error checking service status: %s", str(ex))
        return {"running": False, "error": str(ex), "message": f"Error checking service status: {ex!s}"}


async def start_service(model_name: str, model_path: str, gpu_layers: int = None, context_size: int = None, batch_size: int = None) -> dict[str, Any]:
    """
    Start a LlamaCpp model in a background thread.

    Args:
        model_name: The name of the model to start
        model_path: The path to the model file
        gpu_layers: Number of GPU layers to use (overrides config.yaml)
        context_size: Context window size (overrides config.yaml)
        batch_size: Batch size for processing (overrides config.yaml)

    Returns:
        A dictionary with the status of the operation
    """
    # global ACTIVE_MODEL, MODEL_PROCESSES, MODEL_STATUS  # Currently unused

    # Normalize model_name for file path consistency
    normalized_model_name = normalize_model_name(model_name, purpose="file_path")
    logger.info("Starting model with normalized name: %s (original: %s)", normalized_model_name, model_name)

    try:
        # Check if llama-cpp-python is available (will attempt import if local AI is enabled)
        if not _ensure_llama_cpp_imported():
            error_msg = "llama-cpp-python is not available or local AI is disabled"
            logger.error(error_msg)
            return {"success": False, "error": "LlamaCpp not available", "message": error_msg}

        # Check if the model is already running
        if normalized_model_name in MODEL_PROCESSES and MODEL_PROCESSES[normalized_model_name].get("status") == "ready":
            logger.info("Model %s is already running.", normalized_model_name)
            return {
                "success": True,
                "message": f"Model {normalized_model_name} is already running.",
                "model_name": normalized_model_name,
                "status": "ready",
            }

        # Check if the model file exists
        if not os.path.exists(model_path):
            logger.error("Model file not found: %s", model_path)
            return {
                "success": False,
                "message": f"Model file not found: {model_path}",
                "model_name": normalized_model_name,
                "status": "error",
            }

        # Initialize model process entry if it doesn't exist
        if normalized_model_name not in MODEL_PROCESSES:
            MODEL_PROCESSES[normalized_model_name] = {
                "thread": None,
                "process": None,
                "status": "initializing",
                "llm": None,
            }

        # Update model status
        MODEL_STATUS[normalized_model_name] = {
            "status": "loading",
            "progress": 0,
            "message": f"Loading model {normalized_model_name}",
        }

        # Define the function to load the model in a separate thread

        def get_llm_advanced_parameters():
            """
            Get advanced LLM parameters from config.yaml, with overrides from function parameters

            Returns:
                Dictionary containing advanced LLM parameters from config.yaml with parameter overrides
            """
            # Get parameters from config.yaml advanced section with defaults
            advanced_config = resolved_config.get("llm", {}).get("advanced", {})

            # Handle GPU layers - use passed parameter if available, otherwise config
            if gpu_layers is not None:
                final_gpu_layers = gpu_layers
                logger.info("Using GPU layers from parameter: %s", gpu_layers)
            else:
                gpu_layers_config = advanced_config.get("gpu_layers", 0)
                if gpu_layers_config == "auto":
                    from src.main.service.local_models.create_model_utils import get_default_gpu_layers

                    final_gpu_layers = get_default_gpu_layers()
                else:
                    final_gpu_layers = int(gpu_layers_config)
                logger.info("Using GPU layers from config: %s", final_gpu_layers)

            # Handle context size - use passed parameter if available, otherwise config
            if context_size is not None:
                final_context_size = context_size
                logger.info("Using context size from parameter: %s", context_size)
            else:
                final_context_size = int(advanced_config.get("context_size", 32768))
                logger.info("Using context size from config: %s", final_context_size)

            # Handle batch size - use passed parameter if available, otherwise config
            if batch_size is not None:
                final_batch_size = batch_size
                logger.info("Using batch size from parameter: %s", batch_size)
            else:
                final_batch_size = int(advanced_config.get("batch_size", 1024))
                logger.info("Using batch size from config: %s", final_batch_size)

            return {
                "n_gpu_layers": final_gpu_layers,
                "n_ctx": final_context_size,
                "n_batch": final_batch_size,
                "threads": int(advanced_config.get("threads", 4)),
                "use_mlock": bool(advanced_config.get("use_mlock", True)),
                "use_mmap": bool(advanced_config.get("use_mmap", True)),
                "rope_scaling": advanced_config.get("rope_scaling"),
            }

        def load_model_thread():
            try:
                logger.info("Loading model %s from %s", normalized_model_name, model_path)
                MODEL_STATUS[normalized_model_name] = {
                    "status": "loading",
                    "progress": 10,
                    "message": f"Loading model {normalized_model_name}",
                }

                # Create the LLM instance here
                try:
                    import platform

                    from langchain_community.llms.llamacpp import LlamaCpp

                    # Get hardware requirements for the model from the database
                    hardware_reqs = _get_model_hardware_requirements()
                    # noinspection PyTypeChecker
                    model_hw_reqs = hardware_reqs.get(normalized_model_name, {})

                    # Get advanced parameters from config.yaml
                    config_params = get_llm_advanced_parameters()

                    # Determine if we're in a CPU-only environment
                    is_cpu_only = not get_cached_gpu_availability()

                    # Set parameters with priority: model hardware requirements > config.yaml > defaults
                    n_gpu_layers = model_hw_reqs.get("n_gpu_layers", config_params["n_gpu_layers"])

                    # Force n_gpu_layers to 0 if we're in a CPU-only environment
                    if is_cpu_only:
                        logger.info("Configuring LlamaCpp for CPU - only environment")
                        n_gpu_layers = 0
                        # Lower batch size for CPU
                        n_batch = min(model_hw_reqs.get("n_batch", config_params["n_batch"]), 256)
                        n_ctx = min(model_hw_reqs.get("n_ctx", config_params["n_ctx"]), 2048)  # Smaller context for CPU
                    else:
                        n_ctx = model_hw_reqs.get("n_ctx", config_params["n_ctx"])
                        n_batch = model_hw_reqs.get("n_batch", config_params["n_batch"])

                    # Other parameters with model hardware priority
                    threads = model_hw_reqs.get("threads", config_params["threads"])
                    use_mlock = model_hw_reqs.get("use_mlock", config_params["use_mlock"])
                    use_mmap = model_hw_reqs.get("use_mmap", config_params["use_mmap"])
                    rope_scaling = model_hw_reqs.get("rope_scaling", config_params["rope_scaling"])

                    # Handle null/None values that might come as strings from JSON/YAML
                    def safe_convert_to_none(value):
                        """Convert 'null', 'None', empty strings to None"""
                        if value is None or value == "null" or value == "None" or value == "":
                            return None
                        return value

                    threads = safe_convert_to_none(threads)
                    rope_scaling = safe_convert_to_none(rope_scaling)

                    # Check available memory based on where the model will be loaded
                    model_size = os.path.getsize(model_path) / (1024 * 1024 * 1024)  # GB

                    if n_gpu_layers > 0 and get_cached_gpu_availability() and get_cached_gpu_memory() > 0:
                        # Model will use GPU - check GPU memory
                        available_memory = get_cached_gpu_memory()
                        memory_type = "GPU"

                        # Get GPU info for shared memory check
                        gpu_info = get_cached_gpu_info()
                        primary_gpu = gpu_info.get("gpus", [{}])[0] if gpu_info and gpu_info.get("gpus") else {}

                        # For shared memory systems (like AMD APUs), be more conservative
                        if primary_gpu.get("shared_memory_mb", 0) > 0:
                            dedicated_memory_gb = primary_gpu.get("dedicated_memory_mb", 0) / 1024
                            shared_memory_gb = primary_gpu.get("shared_memory_mb", 0) / 1024

                            # Use more conservative calculation for shared memory
                            # Reserve some shared memory for system use
                            usable_shared_memory = shared_memory_gb * 0.8  # Use 80% of shared memory
                            available_memory = dedicated_memory_gb + usable_shared_memory

                            logger.info(
                                "Shared GPU memory detected - Dedicated: %.2f GB, Shared: %.2f GB, Usable: %.2f GB",
                                dedicated_memory_gb,
                                shared_memory_gb,
                                available_memory,
                            )
                            memory_type = "shared GPU"

                        logger.debug("Checking %s memory for model loading: %.2f GB available", memory_type, available_memory)
                    else:
                        # The Model will use CPU - check system RAM
                        # noinspection PyUnresolvedReferences
                        available_memory = psutil.virtual_memory().available / (1024 * 1024 * 1024)  # GB
                        memory_type = "system RAM"
                        logger.debug("Checking system RAM for model loading: %.2f GB available", available_memory)

                    # Estimate required memory (model size + working memory)
                    required_memory = model_size * 1.5  # 50% extra for working memory

                    if available_memory < required_memory:
                        memory_suggestion = "increasing GPU memory" if memory_type == "GPU" else "increasing system memory"
                        # noinspection PyTypeChecker
                        err_msg = (
                            f"Insufficient {memory_type} to load model {normalized_model_name}. "
                            f"Available: {available_memory:.2f} GB, Required: {required_memory:.2f} GB. "
                            f"Consider using a smaller model or {memory_suggestion}."
                        )
                        logger.error(err_msg)
                        raise MemoryError(f"DEPLOYMENT_HALTING_ERROR: {err_msg}")

                    # Check if we're on Windows - automatically disable use_mlock to prevent VirtualLock failures
                    if platform.system() == "Windows" and use_mlock:
                        logger.info("Windows detected, automatically setting use_mlock=False to prevent VirtualLock failures")
                        use_mlock = False

                    # Ensure model_path is absolute to prevent path resolution issues
                    absolute_model_path = os.path.abspath(model_path)
                    logger.info("Using absolute model path: %s", absolute_model_path)

                    # Create the LLM instance with advanced parameters
                    # Separate direct parameters from model_kwargs

                    # Direct LlamaCpp constructor parameters based on source code
                    llm_params = {
                        "model_path": absolute_model_path,
                        "temperature": 0.2,  # Default temperature
                        "max_tokens": 2048,  # Default max tokens
                        "n_ctx": int(n_ctx),
                        "f16_kv": True,  # Use half-precision for key/value cache
                        "verbose": False,
                        "use_mlock": bool(use_mlock),
                        "use_mmap": bool(use_mmap),
                    }

                    # Add optional parameters only if they have valid values
                    if n_gpu_layers is not None:
                        llm_params["n_gpu_layers"] = int(n_gpu_layers)

                    if threads is not None:
                        llm_params["n_threads"] = int(threads)

                    if n_batch is not None:
                        llm_params["n_batch"] = int(n_batch)

                    # Add rope_freq_scale as direct parameter (not in model_kwargs)
                    if rope_scaling is not None:
                        try:
                            llm_params["rope_freq_scale"] = float(rope_scaling)
                        except (ValueError, TypeError) as exc:
                            logger.warning("Invalid rope_scaling value '%s', skipping: %s", rope_scaling, exc)

                    # model_kwargs should only contain additional parameters not defined in LlamaCpp fields
                    # Based on the source code, most parameters should be passed directly

                    # Create the LLM instance
                    logger.info("Attempting to load model with parameters: %s", llm_params)
                    try:
                        llm = LlamaCpp(**llm_params)
                    except Exception as exc:
                        logger.error("Failed to create LlamaCpp instance: %s", str(exc))
                        logger.error("Model path: %s", absolute_model_path)
                        logger.error("Model file exists: %s", os.path.exists(absolute_model_path))
                        logger.error("Model file size: %.2f GB", os.path.getsize(absolute_model_path) / (1024 * 1024 * 1024))

                        # Try with minimal parameters to see if it's a parameter issue
                        logger.info("Attempting to load with minimal parameters...")
                        try:
                            minimal_params = {
                                "model_path": absolute_model_path,
                                "verbose": True,  # Enable verbose to see more details
                            }
                            llm = LlamaCpp(**minimal_params)
                            logger.info("Model loaded successfully with minimal parameters")
                        except Exception as minimal_e:
                            logger.error("Failed even with minimal parameters: %s", str(minimal_e))
                            raise exc from minimal_e  # Re-raise the original exception from minimal_e

                    # Store the LLM instance in the model process entry
                    MODEL_PROCESSES[normalized_model_name]["llm"] = llm
                    logger.info("Created and stored LlamaCpp instance for %s", normalized_model_name)

                    # Update model status to load (only if LLM creation succeeded)
                    MODEL_STATUS[normalized_model_name] = {
                        "status": "ready",
                        "progress": 100,
                        "message": f"Model {normalized_model_name} loaded successfully",
                    }

                    # Update model process status
                    MODEL_PROCESSES[normalized_model_name]["status"] = "ready"

                    logger.info("Model %s loaded successfully with normalized name: %s", model_name, normalized_model_name)

                except Exception as llm_error:
                    logger.error("Error creating LLM instance: %s", str(llm_error))

                    # Update model status to error since LLM creation failed
                    MODEL_STATUS[normalized_model_name] = {
                        "status": "error",
                        "progress": 0,
                        "message": f"Error creating LLM instance: {llm_error!s}",
                    }

                    # Update model process status to error
                    MODEL_PROCESSES[normalized_model_name]["status"] = "error"

                    # Don't continue with success logging if LLM creation failed
                    return
            except Exception as exc:
                logger.error("Error loading model %s: %s", normalized_model_name, str(exc))
                MODEL_STATUS[normalized_model_name] = {
                    "status": "error",
                    "progress": 0,
                    "message": f"Error loading model {normalized_model_name}: {exc!s}",
                }
                MODEL_PROCESSES[normalized_model_name]["status"] = "error"

        # Store the thread and configuration using the normalized name BEFORE creating the thread
        MODEL_PROCESSES[normalized_model_name] = {
            "thread": None,  # Will be set after thread creation
            "model_path": model_path,
            "start_time": time.time(),
            "status": "loading",
            "llm": None,  # Will be populated when the model is loaded
        }

        # Create the model loading thread
        thread = threading.Thread(target=load_model_thread)

        # Update the thread reference in the MODEL_PROCESSES entry
        MODEL_PROCESSES[normalized_model_name]["thread"] = thread

        # Set as an active model using the normalized name (currently unused)
        # ACTIVE_MODEL = normalized_model_name

        # Start the thread
        thread.start()

        logger.info("Started loading model %s in background thread with normalized name: %s", model_name, normalized_model_name)
        return {
            "success": True,
            "message": f"Model {model_name} is being loaded",
            "model_name": normalized_model_name,
            "status": "loading",
        }

    except Exception as ex:
        logger.error("Error starting model %s: %s", model_name, str(ex))
        return {"success": False, "error": str(ex), "message": f"Error starting model {model_name}: {ex!s}"}


async def stop_service(model_name: str = None) -> dict[str, Any]:
    """
    Stop a running LlamaCpp model and free resources.

    Args:
        model_name: Optional name of the model to stop. If None, stop the active model.

    Returns:
        Dictionary with service stop result information
    """
    # global ACTIVE_MODEL, MODEL_PROCESSES, MODEL_STATUS  # Currently unused

    try:
        # Determine which model to stop
        target_model = model_name if model_name else None  # ACTIVE_MODEL currently unused

        if not target_model:
            logger.info("No active model to stop.")
            return {"success": True, "message": "No active model to stop."}

        # Normalize model name to lowercase for consistency
        target_model = target_model.lower()
        logger.info("Stopping model with normalized name: %s", target_model)

        # Check if the model is running - case-insensitive check
        model_process_keys = [k.lower() for k in MODEL_PROCESSES]
        if target_model not in model_process_keys:
            logger.info("Model %s is not running.", target_model)
            return {"success": True, "message": f"Model {target_model} is not running."}

        # Get the actual key from MODEL_PROCESSES that matches our normalized target_model
        actual_key = next((k for k in MODEL_PROCESSES if k.lower() == target_model), None)

        # Get the process info using the actual key
        process_info = MODEL_PROCESSES[actual_key]

        # If we have a LlamaCpp instance, clean it up
        if "llm" in process_info:
            try:
                # Delete the reference to free memory
                del process_info["llm"]
            except Exception as ex:
                logger.error("Error cleaning up LlamaCpp instance: %s", str(ex))

        # Wait for the thread to finish if it's still running
        if process_info.get("thread") and process_info["thread"].is_alive():
            # Set a timeout for the thread to finish
            timeout = 5  # seconds
            start_time = time.time()

            while process_info["thread"].is_alive() and time.time() - start_time < timeout:
                time.sleep(0.5)

        # Clean up process info
        MODEL_PROCESSES.pop(actual_key, None)

        # Update status
        MODEL_STATUS[target_model] = {"status": "stopped", "message": f"Model {target_model} stopped"}

        # If this was the active model, clear it (case-insensitive comparison) - currently disabled
        # if ACTIVE_MODEL and ACTIVE_MODEL.lower() == target_model:
        #     ACTIVE_MODEL = None

        # Force garbage collection to free memory
        gc.collect()

        if get_cached_gpu_availability():
            # Try to clear CUDA cache if available
            try:
                # noinspection PyUnresolvedReferences
                torch.cuda.empty_cache()
                logger.info("CUDA cache cleared")
            except Exception as ex:
                logger.warning("Could not clear CUDA cache: %s", str(ex))

        logger.info("Model %s stopped successfully", target_model)
        return {"success": True, "message": f"Model {target_model} stopped successfully", "model_name": target_model}

    except Exception as ex:
        logger.error("Error stopping model: %s", str(ex))
        return {"success": False, "error": str(ex), "message": f"Error stopping model: {ex!s}"}
