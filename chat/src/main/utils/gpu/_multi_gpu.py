"""Cached LLM-manager GPU info, multi-GPU strategy, cache reset, CUDA compat checks."""

# noinspection PyUnresolvedReferences
import os

from src.main.utils.core.logger import get_logger
from src.main.utils.gpu import _state
from src.main.utils.gpu._detection import _detect_nvidia_gpus

# noinspection PyPackageRequirements
logger = get_logger(__name__)


def _get_gpu_info_from_llm_manager():
    """
    Get comprehensive GPU information from the LLM manager with fallback handling.

    Returns:
        dict: GPU information with keys 'available', 'name', 'memory'
    """
    try:
        from src.main.service.llm.llm_manager import llm_manager

        # Get comprehensive system capabilities
        system_caps = llm_manager.system_capabilities
        gpu_available = system_caps["has_gpu"]

        if gpu_available and system_caps["primary_gpu"]:
            primary_gpu = system_caps["primary_gpu"]
            gpu_name = primary_gpu["name"]
            gpu_memory = primary_gpu.get("total_memory_mb", 0) / 1024  # Convert MB to GB

            return {"available": True, "name": gpu_name, "memory": gpu_memory}
        else:
            # Fallback to legacy detection for compatibility
            # noinspection PyBroadException
            try:
                legacy_gpu_available = llm_manager.is_gpu_available
                if legacy_gpu_available:
                    # Try to get GPU info from the torch if available
                    # noinspection PyBroadException
                    try:
                        import torch

                        if torch and torch.cuda.is_available():
                            device_count = torch.cuda.device_count()
                            if device_count > 0:
                                gpu_name = torch.cuda.get_device_name(0)
                                gpu_memory = torch.cuda.get_device_properties(0).total_memory / (1024**3)
                                return {"available": True, "name": gpu_name, "memory": gpu_memory}
                    except Exception as e:
                        logger.debug("Could not get PyTorch CUDA GPU details: %s", e)

                    # LLM manager says GPU available but can't get details
                    return {"available": True, "name": "GPU (Unknown)", "memory": 0.0}
            except Exception as e:
                logger.debug("Could not access LLM manager GPU info: %s", e)

            return {"available": False, "name": "CPU", "memory": 0.0}

    except Exception as e:
        logger.warning("Cannot access LLM manager for GPU information: %s. Assuming CPU only.", str(e))
        return {"available": False, "name": "CPU", "memory": 0.0}


def get_cached_gpu_info():
    """
    Get comprehensive GPU information with caching to avoid repeated expensive checks.

    Returns:
        dict: GPU information with keys 'available', 'name', 'memory'
    """
    if _state._GPU_INFO_CACHE is None:
        _state._GPU_INFO_CACHE = _get_gpu_info_from_llm_manager()
        logger.debug(
            "Cached GPU info: available=%s, name=%s, memory=%.2fGB",
            _state._GPU_INFO_CACHE["available"],
            _state._GPU_INFO_CACHE["name"],
            _state._GPU_INFO_CACHE["memory"],
        )

    return _state._GPU_INFO_CACHE


def get_cached_gpu_availability() -> bool:
    """
    Get GPU availability with caching to avoid repeated expensive checks.

    Returns:
        bool: True if GPU is available, False otherwise
    """
    return get_cached_gpu_info()["available"]


def get_cached_gpu_name() -> str:
    """
    Get GPU name with caching to avoid repeated expensive checks.

    Returns:
        str: GPU name or "CPU" if no GPU available
    """
    return get_cached_gpu_info()["name"]


def get_cached_gpu_memory() -> float:
    """
    Get GPU memory with caching to avoid repeated expensive checks.

    Returns:
        float: GPU memory in GB, or 0.0 if no GPU available
    """
    return get_cached_gpu_info()["memory"]


# For backward compatibility, provide the old interface
def get_gpu_available_flag() -> bool:
    """Backward compatibility wrapper for GPU_AVAILABLE."""
    return get_cached_gpu_availability()


# =============================================================================
# MULTI-GPU SUPPORT UTILITIES
# =============================================================================


def get_multi_gpu_info() -> dict:
    """
    Get comprehensive multi-GPU information for model parallelism.

    Returns:
        Dict containing multi-GPU configuration and capabilities
    """
    nvidia_gpus = _detect_nvidia_gpus()

    total_vram_mb = sum(gpu.get("total_memory_mb", 0) for gpu in nvidia_gpus)
    total_vram_gb = total_vram_mb / 1024

    multi_gpu_info = {
        "gpu_count": len(nvidia_gpus),
        "total_vram_mb": total_vram_mb,
        "total_vram_gb": total_vram_gb,
        "gpus": nvidia_gpus,
        "supports_model_parallel": len(nvidia_gpus) > 1,
        "supports_data_parallel": len(nvidia_gpus) > 1,
        "recommended_strategy": _get_recommended_multi_gpu_strategy(nvidia_gpus),
    }

    return multi_gpu_info


def _get_recommended_multi_gpu_strategy(gpus: list[dict]) -> str:
    """
    Recommend the best multi-GPU strategy based on available hardware.

    Args:
        gpus: List of GPU information dictionaries

    Returns:
        Recommended multi-GPU strategy
    """
    if len(gpus) <= 1:
        return _state.MULTI_GPU_STRATEGY_NONE

    # For identical GPUs with high VRAM, model parallelism is often better
    # for large models that don't fit on a single GPU
    if len(gpus) >= 2:
        total_vram_per_gpu = gpus[0].get("total_memory_mb", 0) / 1024  # GB
        if total_vram_per_gpu >= 24:  # High VRAM GPUs
            return _state.MULTI_GPU_STRATEGY_MODEL_PARALLEL
        else:
            return _state.MULTI_GPU_STRATEGY_DATA_PARALLEL

    return _state.MULTI_GPU_STRATEGY_DATA_PARALLEL


def get_optimal_gpu_allocation(model_size_gb: float) -> dict:
    """
    Get optimal GPU allocation strategy for a given model size.

    Args:
        model_size_gb: Estimated model size in GB

    Returns:
        Dict with allocation strategy and GPU assignments
    """
    multi_gpu_info = get_multi_gpu_info()
    gpus = multi_gpu_info["gpus"]

    if len(gpus) <= 1:
        return {
            "strategy": _state.MULTI_GPU_STRATEGY_NONE,
            "primary_gpu": 0 if gpus else None,
            "gpu_allocation": [0] if gpus else [],
            "can_fit": len(gpus) > 0 and (gpus[0].get("total_memory_mb", 0) / 1024) >= model_size_gb,
        }

    # Check if model fits on a single GPU
    single_gpu_vram = gpus[0].get("total_memory_mb", 0) / 1024
    if model_size_gb <= single_gpu_vram * 0.8:  # Leave 20% headroom
        return {"strategy": _state.MULTI_GPU_STRATEGY_NONE, "primary_gpu": 0, "gpu_allocation": [0], "can_fit": True}

    # Check if model fits across multiple GPUs with model parallelism
    total_vram = sum(gpu.get("total_memory_mb", 0) for gpu in gpus) / 1024
    if model_size_gb <= total_vram * 0.7:  # Leave 30% headroom for multi-GPU overhead
        return {
            "strategy": _state.MULTI_GPU_STRATEGY_MODEL_PARALLEL,
            "primary_gpu": 0,
            "gpu_allocation": list(range(len(gpus))),
            "can_fit": True,
        }

    # Model too large even for multi-GPU
    return {
        "strategy": _state.MULTI_GPU_STRATEGY_NONE,
        "primary_gpu": None,
        "gpu_allocation": [],
        "can_fit": False,
        "required_vram_gb": model_size_gb,
        "available_vram_gb": total_vram,
    }


def setup_multi_gpu_environment() -> bool:
    """
    Setup environment variables and configurations for multi-GPU usage.

    Returns:
        bool: True if multi-GPU environment was successfully configured
    """
    try:
        multi_gpu_info = get_multi_gpu_info()

        if multi_gpu_info["gpu_count"] <= 1:
            logger.info("Single GPU detected, no multi-GPU setup needed")
            return False

        # Set CUDA_VISIBLE_DEVICES to include all GPUs
        gpu_ids = ",".join(str(i) for i in range(multi_gpu_info["gpu_count"]))
        os.environ["CUDA_VISIBLE_DEVICES"] = gpu_ids

        # Set optimal memory allocation
        os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "max_split_size_mb:512"

        logger.info(
            "Multi-GPU environment configured: %s GPUs, %.1fGB total VRAM",
            multi_gpu_info["gpu_count"],
            multi_gpu_info["total_vram_gb"],
        )
        logger.info("CUDA_VISIBLE_DEVICES set to: %s", gpu_ids)

        return True

    except Exception as e:
        logger.error("Failed to setup multi-GPU environment: %s", e)
        return False


def log_multi_gpu_status():
    """Log comprehensive multi-GPU status information."""
    try:
        multi_gpu_info = get_multi_gpu_info()

        logger.info("=== Multi-GPU Status ===")
        logger.info("GPU Count: %s", multi_gpu_info["gpu_count"])
        logger.info("Total VRAM: %.1fGB", multi_gpu_info["total_vram_gb"])
        logger.info("Model Parallelism Support: %s", multi_gpu_info["supports_model_parallel"])
        logger.info("Recommended Strategy: %s", multi_gpu_info["recommended_strategy"])

        for i, gpu in enumerate(multi_gpu_info["gpus"]):
            vram_gb = gpu.get("total_memory_mb", 0) / 1024
            logger.info("GPU %s: %s - %.1fGB VRAM", i, gpu.get("name", "Unknown"), vram_gb)

    except Exception as e:
        logger.error("Failed to log multi-GPU status: %s", e)


def clear_gpu_cache():
    """Clear all GPU detection caches to force fresh detection."""
    logger.info("Clearing GPU detection cache to force fresh detection")

    # Clear in-memory cache
    _state._gpu_detection_cache = {
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

    # Clear file cache
    try:
        if os.path.exists(_state.GPU_CACHE_FILE):
            os.remove(_state.GPU_CACHE_FILE)
            logger.info("Removed GPU cache file: %s", _state.GPU_CACHE_FILE)
    except Exception as e:
        logger.warning("Failed to remove GPU cache file: %s", e)


def force_gpu_redetection():
    """Force a complete GPU re-detection by clearing cache and re-running detection."""
    logger.info("Forcing complete GPU re-detection")

    # Clear all caches
    clear_gpu_cache()

    # Force PyTorch to reinitialize CUDA context
    # noinspection PyUnresolvedReferences
    if _state._check_torch_availability() and _state.torch.cuda.is_available():
        try:
            # Clear PyTorch CUDA cache
            # noinspection PyUnresolvedReferences
            _state.torch.cuda.empty_cache()
            logger.info("Cleared PyTorch CUDA cache")
        except Exception as e:
            logger.warning("Failed to clear PyTorch CUDA cache: %s", e)

    # Run fresh detection
    nvidia_gpus = _detect_nvidia_gpus()
    logger.info("Fresh detection found %s NVIDIA GPUs", len(nvidia_gpus))

    return nvidia_gpus


def check_pytorch_cuda_compatibility() -> tuple[bool, str | None]:
    """
    Check if PyTorch CUDA is compatible with the installed GPU.

    Returns:
        tuple[bool, str | None]: (is_compatible, reason_if_incompatible)
            - True, None: CUDA is compatible or not available
            - False, reason: CUDA is incompatible with reason string
    """
    try:
        # Check if PyTorch is available
        if not _state._check_torch_availability():
            return True, None  # PyTorch not available, not an error

        import torch

        # Check if CUDA is available in PyTorch
        if not torch.cuda.is_available():
            return True, None  # No CUDA, not an error

        # Try to detect GPU compute capability mismatch
        try:
            # Get the compute capability of the GPU
            device_count = torch.cuda.device_count()
            if device_count == 0:
                return True, None

            # Check each GPU for compatibility
            for device_idx in range(device_count):
                props = torch.cuda.get_device_properties(device_idx)
                gpu_name = props.name

                # Get compute capability
                major = props.major
                minor = props.minor
                compute_cap = f"sm_{major}{minor}"

                # Try to run a simple operation to detect incompatibility
                try:
                    # This will fail if the GPU architecture is not supported
                    test_tensor = torch.ones((1, 1), device=f"cuda:{device_idx}")
                    _ = test_tensor + 1
                    logger.debug("GPU %s (%s) compatibility check passed", device_idx, gpu_name)
                except RuntimeError as e:
                    error_str = str(e)
                    if "no kernel image is available" in error_str or "CUDA capability" in error_str:
                        reason = (
                            f"GPU {device_idx} ({gpu_name}) with compute capability {compute_cap} "
                            f"is not compatible with the current PyTorch installation. "
                            f"PyTorch was compiled for older GPU architectures. "
                            f"This typically happens with very new GPUs (e.g., Blackwell architecture). "
                            f"Docling will use CPU mode instead."
                        )
                        logger.warning(reason)
                        return False, reason
                    else:
                        # Other CUDA error, re-raise
                        raise

            # All GPUs passed compatibility check
            return True, None

        except Exception as e:
            error_str = str(e)
            if "no kernel image is available" in error_str or "CUDA capability" in error_str:
                reason = (
                    f"CUDA compatibility check failed: {error_str}. "
                    f"This typically indicates a GPU architecture mismatch. "
                    f"Docling will use CPU mode instead."
                )
                logger.warning(reason)
                return False, reason
            else:
                # Unknown error, log but assume compatible
                logger.warning("CUDA compatibility check encountered unexpected error: %s", e)
                return True, None

    except Exception as e:
        # Any other exception, assume compatible (fail open)
        logger.debug("CUDA compatibility check failed with exception: %s", e)
        return True, None
