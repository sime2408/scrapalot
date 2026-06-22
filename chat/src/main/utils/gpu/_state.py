"""Shared GPU detection state, constants, and lazy library loaders.

This module is the single owner of all module-level state used by the GPU
detection / monitoring helpers (in-memory caches, tool-availability flags,
lazily imported ``torch`` / ``pynvml`` handles, and configuration helpers).
Every sibling module references this state through the module object
(``from src.main.utils.gpu import _state``; ``_state._gpu_detection_cache``)
so that singleton semantics are preserved even when a cache is rebound
(e.g. ``clear_gpu_cache`` replaces ``_gpu_detection_cache`` wholesale).
"""

# noinspection PyUnresolvedReferences
import os
import shutil
import subprocess
import time
from typing import Any

from src.main.utils.core.logger import get_logger

# noinspection PyPackageRequirements
logger = get_logger(__name__)

# Configuration loading - will be imported lazily to avoid circular imports
_config_loader = None
_resolved_config = None


def _get_gpu_config():
    """Get GPU detection configuration from config.yaml"""
    global _resolved_config

    if _resolved_config is None:
        try:
            # noinspection PyUnresolvedReferences
            from src.main.utils.config.loader import resolved_config

            _resolved_config = resolved_config
        except ImportError:
            logger.debug("Config loader not available, using default GPU detection settings")
            _resolved_config = {}

    return _resolved_config.get("gpu_detection", {})


# Cache file for GPU detection results - configurable for Docker volumes
GPU_CACHE_DIR = os.environ.get("SCRAPALOT_CACHE_DIR", os.path.expanduser("~"))
GPU_CACHE_FILE = os.path.join(GPU_CACHE_DIR, ".scrapalot_gpu_cache.json")
GPU_CACHE_EXPIRY_HOURS = 24  # Cache expires after 24 hours
VULKAN_INFO_PATTERN = "VP_VULKANINFO_*.json"  # Pattern for Vulkan info files

# Cache for GPU detection results to avoid repeated expensive operations
_gpu_detection_cache: dict[str, Any] = {
    "nvidia_gpus": None,
    "amd_gpus": None,
    "apple_gpus": None,
    "intel_gpus": None,
    "opencl_gpus": None,
    "vulkan_gpus": None,
    "all_gpus": None,
    "device_type": None,
    "system_capabilities": None,
}

# Global initialization state
_gpu_system_initialized = False

# Background detection state
_background_detection_started = False
_background_detection_complete = False
_background_detection_task = None


def _is_gpu_detection_disabled() -> bool:
    """
    Check if GPU detection should be disabled based on environment variables or configuration.

    Environment variables that disable GPU detection:
    - DISABLE_GPU_DETECTION=true (explicit disable)
    - ENABLE_GPU_DETECTION=false (explicit disable)

    Returns:
        bool: True if GPU detection should be disabled
    """
    # Check configuration first
    gpu_config = _get_gpu_config()
    if not gpu_config.get("enabled", True):
        return True

    # Check for explicit disabling
    if os.environ.get("DISABLE_GPU_DETECTION", "").lower() == "true":
        return True

    # Check for explicit enable=false
    return os.environ.get("ENABLE_GPU_DETECTION", "").lower() == "false"


def _is_provider_enabled(provider_name: str) -> bool:
    """
    Check if a specific GPU detection provider is enabled in configuration.

    Args:
        provider_name: Name of the provider (nvidia, amd, intel, apple, vulkan, opencl)

    Returns:
        bool: True if the provider should be used for detection
    """
    gpu_config = _get_gpu_config()
    providers_config = gpu_config.get("providers", {})

    # Default values for each provider
    defaults = {
        "nvidia": True,
        "amd": True,
        "intel": False,  # Disabled by default due to timeouts
        "apple": False,  # Disabled by default on non-Mac
        "vulkan": False,  # Disabled by default due to slow detection
        "opencl": True,  # Keep as lightweight fallback
    }

    return providers_config.get(provider_name, defaults.get(provider_name, True))


def _get_command_timeout() -> int:
    """Get the configured timeout for GPU detection commands."""
    gpu_config = _get_gpu_config()
    performance_config = gpu_config.get("performance", {})
    # Coerce to int. config.yaml carries this as `${GPU_DETECTION_TIMEOUT:-5}`,
    # and env-var substitution yields a STRING ('5'). Passing a str to
    # subprocess.run(timeout=...) makes Python raise "unsupported operand
    # type(s) for +: 'float' and 'str'" (time.monotonic() + timeout), which
    # silently broke nvidia-smi GPU detection (0 GPUs reported despite
    # torch.cuda being available).
    raw = performance_config.get("command_timeout", 10)
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 10  # Default 10 seconds


def get_gpu_availability() -> bool:
    """
    Get GPU availability from the LLM manager with fallback handling.

    This function provides centralized GPU availability checking to avoid code duplication.

    Returns:
        bool: True if GPU is available, False otherwise
    """
    # noinspection PyBroadException
    try:
        from src.main.service.llm.llm_manager import llm_manager

        return llm_manager.is_gpu_available
    except Exception as e:
        logger.warning("Cannot access LLM manager for GPU availability: %s. Assuming CPU only.", e)
        return False


# GPU Type Constants
GPU_TYPE_NVIDIA = "NVIDIA"
GPU_TYPE_AMD = "AMD"
GPU_TYPE_APPLE = "APPLE"
GPU_TYPE_INTEL = "INTEL"
GPU_TYPE_UNKNOWN = "UNKNOWN"

DEVICE_TYPE_CPU = "cpu"
DEVICE_TYPE_CUDA = "cuda"
DEVICE_TYPE_MPS = "mps"
DEVICE_TYPE_ROCM = "rocm"
DEVICE_TYPE_OPENCL = "opencl"
DEVICE_TYPE_VULKAN = "vulkan"

# Check for available GPU libraries
_torch_available = None  # Will be checked lazily
_pynvml_available = False
_pyamdgpu_available = False
torch = None  # Will be imported lazily


def _check_torch_availability():
    """Lazily check if a torch is available and import it."""
    global _torch_available, torch
    if _torch_available is None:
        try:
            # noinspection PyUnresolvedReferences
            import torch as torch_module

            torch = torch_module
            _torch_available = True
            logger.debug("PyTorch available for GPU detection")
        except ImportError:
            _torch_available = False
            logger.debug("PyTorch not available")
    return _torch_available


# PyNVML will be imported lazily to avoid startup delays
pynvml = None


def _check_pynvml_availability():
    """Lazily check if PyNVML is available and import it."""
    global _pynvml_available, pynvml
    if _pynvml_available is None:
        try:
            # noinspection PyUnresolvedReferences
            import pynvml as pynvml_module

            pynvml = pynvml_module
            _pynvml_available = True
            logger.debug("PyNVML available for NVIDIA GPU detection")
        except ImportError:
            _pynvml_available = False
            logger.debug("PyNVML not available")
    return _pynvml_available


# Check for command-line tools
# noinspection PyDeprecation
_nvidia_smi_available = shutil.which("nvidia-smi") is not None
# noinspection PyDeprecation
_rocm_smi_available = shutil.which("rocm-smi") is not None
# noinspection PyDeprecation
_intel_gpu_top_available = shutil.which("intel_gpu_top") is not None
# noinspection PyDeprecation
_clinfo_available = shutil.which("clinfo") is not None
# noinspection PyDeprecation
_vulkaninfo_available = shutil.which("vulkaninfo") is not None


# Global GPU availability flag - will be initialized after functions are defined
GPU_AVAILABLE = None

# Multi-GPU support constants
MULTI_GPU_STRATEGY_NONE = "none"
MULTI_GPU_STRATEGY_DATA_PARALLEL = "data_parallel"
MULTI_GPU_STRATEGY_MODEL_PARALLEL = "model_parallel"
MULTI_GPU_STRATEGY_PIPELINE_PARALLEL = "pipeline_parallel"


def _run_command(cmd: list[str], timeout: int = None) -> str | None:
    """
    Run a command and return its output.

    Args:
        cmd: Command to run as a list of string
        timeout: Timeout in seconds (uses configured timeout if None)

    Returns:
        Command output as string or None if failed
    """
    if timeout is None:
        timeout = _get_command_timeout()

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        if result.returncode == 0:
            return result.stdout.strip()
        else:
            logger.debug("Command %s failed with return code %s", " ".join(cmd), result.returncode)
            return None
    except subprocess.TimeoutExpired:
        logger.debug("Command %s timed out", " ".join(cmd))
        return None
    except Exception as e:
        logger.debug("Error running command %s: %s", " ".join(cmd), e)
        return None


# GPU Monitoring availability flags (consolidated from gpu_monitor.py)
# Check if nvidia-smi command is available
# noinspection PyDeprecation
NVIDIA_SMI_AVAILABLE = shutil.which("nvidia-smi") is not None
# Check if rocm-smi command is available
# noinspection PyDeprecation
ROCM_SMI_AVAILABLE = shutil.which("rocm-smi") is not None

# Cache for fallback values
_last_fallback_values: dict[str, tuple[float, float]] = {
    "memory": (0.0, time.time()),  # (value, timestamp)
    "utilization": (0.0, time.time()),
}

# Global GPU availability cache - initialized lazily
_GPU_AVAILABLE_CACHE = None

# Enhanced GPU information cache - stores availability, name, and memory
_GPU_INFO_CACHE = None
