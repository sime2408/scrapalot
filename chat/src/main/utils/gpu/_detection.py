"""GPU detection orchestration: device-type resolution, system capabilities.

The cross-vendor ``get_all_gpus`` orchestrator, device-type / primary-GPU
resolution, system-capability aggregation, the background-detection driver,
``initialize_gpu_system`` and legacy-compat shims. Per-vendor probes live in
``_probes.py``.
"""

import platform
import time

import psutil

from src.main.utils.core.logger import get_logger, timing_decorator
from src.main.utils.gpu import _state
from src.main.utils.gpu._cache import save_gpu_cache
from src.main.utils.gpu._probes import (
    _detect_amd_gpus,
    _detect_apple_gpus,
    _detect_intel_gpus,
    _detect_nvidia_gpus,
    _detect_opencl_gpus,
    _detect_vulkan_gpus,
)

# noinspection PyPackageRequirements
logger = get_logger(__name__)


@timing_decorator("Get All GPUs")
def get_all_gpus() -> list[dict]:
    """
    Detect all available GPUs across all platforms.

    Returns:
        List of GPU information dictionaries
    """
    # Check if GPU detection is disabled via environment variables
    if _state._is_gpu_detection_disabled():
        logger.info("GPU detection disabled via environment variable - returning empty GPU list")
        _state._gpu_detection_cache["all_gpus"] = []
        return []
    # Return cached result if available
    cached_gpus = _state._gpu_detection_cache["all_gpus"]
    if cached_gpus is not None:
        logger.debug("Get All GPUs: returning cached result with %s GPUs", len(cached_gpus))
        return cached_gpus

    # If not initialized yet, do a quick check to avoid expensive operations during startup
    if not _state._gpu_system_initialized:
        logger.debug("GPU system not initialized, performing one-time detection")

    logger.debug("Get All GPUs: no cached result, performing detection")
    all_gpus = []

    # Detect NVIDIA GPUs first (usually fastest)
    if _state._is_provider_enabled("nvidia"):
        logger.debug("NVIDIA GPU detection enabled, running detection")
        nvidia_gpus = _detect_nvidia_gpus()
        all_gpus.extend(nvidia_gpus)
    else:
        logger.debug("NVIDIA GPU detection disabled in configuration")

    # Detect AMD GPUs
    if _state._is_provider_enabled("amd"):
        logger.debug("AMD GPU detection enabled, running detection")
        amd_gpus = _detect_amd_gpus()
        all_gpus.extend(amd_gpus)
    else:
        logger.debug("AMD GPU detection disabled in configuration")

    # Detect Apple GPUs (Mac only)
    if _state._is_provider_enabled("apple"):
        logger.debug("Apple GPU detection enabled, running detection")
        apple_gpus = _detect_apple_gpus()
        all_gpus.extend(apple_gpus)
    else:
        logger.debug("Apple GPU detection disabled in configuration")

    # Detect Intel GPUs
    if _state._is_provider_enabled("intel"):
        logger.debug("Intel GPU detection enabled, running detection")
        intel_gpus = _detect_intel_gpus()
        all_gpus.extend(intel_gpus)
    else:
        logger.debug("Intel GPU detection disabled in configuration")

    # Smart decision: Only run Vulkan detection if enabled, and we have few or no GPUs found
    # This avoids the expensive Vulkan detection when we already have comprehensive results
    should_run_vulkan = _state._is_provider_enabled("vulkan") and (
        len(all_gpus) == 0 or (len(all_gpus) == 1 and all_gpus[0].get("detection_method", "").startswith("windows_wmi"))
    )

    if should_run_vulkan:
        logger.debug("Vulkan GPU detection enabled, running detection to find additional GPUs")
        vulkan_gpus = _detect_vulkan_gpus()
        # Only add Vulkan GPUs that weren't already detected by vendor-specific methods
        for vulkan_gpu in vulkan_gpus:
            vulkan_name = vulkan_gpu.get("name", "").lower()
            already_detected = any(vulkan_name in existing_gpu.get("name", "").lower() for existing_gpu in all_gpus)
            if not already_detected:
                all_gpus.append(vulkan_gpu)
                logger.info("Added additional GPU via Vulkan: %s", vulkan_gpu["name"])
    elif not _state._is_provider_enabled("vulkan"):
        logger.debug("Vulkan GPU detection disabled in configuration")
    else:
        logger.debug("Skipping Vulkan detection - already found %s GPUs via vendor-specific methods", len(all_gpus))

    # Fallback: Try OpenCL detection only if enabled and no GPUs found at all
    if _state._is_provider_enabled("opencl") and not all_gpus:
        logger.debug("OpenCL GPU detection enabled, running as fallback since no GPUs found")
        opencl_gpus = _detect_opencl_gpus()
        all_gpus.extend(opencl_gpus)
    elif not _state._is_provider_enabled("opencl"):
        logger.debug("OpenCL GPU detection disabled in configuration")
    elif all_gpus:
        logger.debug("Skipping OpenCL detection - GPUs already found via other methods")

    # Remove duplicates based on name and vendor
    unique_gpus = []
    seen = set()
    for gpu in all_gpus:
        key = (gpu.get("name", ""), gpu.get("vendor", ""))
        if key not in seen:
            seen.add(key)
            unique_gpus.append(gpu)

    # Cache the result
    logger.debug("Get All GPUs: caching result with %s GPUs", len(unique_gpus))
    _state._gpu_detection_cache["all_gpus"] = unique_gpus
    save_gpu_cache()
    return unique_gpus


def is_gpu_available() -> bool:
    """
    Check if any GPU is available for processing.

    Returns:
        bool: True if GPU is available, False otherwise
    """
    # Use cached result if available
    if _state._gpu_detection_cache["all_gpus"] is not None:
        return len(_state._gpu_detection_cache["all_gpus"]) > 0

    gpus = get_all_gpus()
    return len(gpus) > 0


def _determine_device_type_internal() -> str:
    """Internal device type detection without background detection calls."""
    # noinspection PyBroadException
    try:
        # Check PyTorch availability lazily
        torch_available = _state._check_torch_availability()

        # Check PyTorch CUDA
        # noinspection PyUnresolvedReferences
        if torch_available and _state.torch.cuda.is_available():
            device_type = _state.DEVICE_TYPE_CUDA
        # Check PyTorch MPS (Apple Silicon)
        # noinspection PyUnresolvedReferences
        elif torch_available and hasattr(_state.torch.backends, "mps") and _state.torch.backends.mps.is_available():
            device_type = _state.DEVICE_TYPE_MPS
        # Check ROCm
        elif torch_available and hasattr(_state.torch, "hip") and _state.torch.hip.is_available():
            device_type = _state.DEVICE_TYPE_ROCM
        # Check if any GPU is available via other methods
        elif get_all_gpus():
            device_type = _state.DEVICE_TYPE_OPENCL
        else:
            device_type = _state.DEVICE_TYPE_CPU
    except Exception as e:
        logger.debug("Error detecting device type, defaulting to CPU: %s", e)
        device_type = _state.DEVICE_TYPE_CPU

    # Cache the result
    _state._gpu_detection_cache["device_type"] = device_type
    return device_type


def get_device_type() -> str:
    """
    Get the best available device type for processing.
    Starts background detection if needed and returns immediate fallback if detection not complete.

    Returns:
        str: Device type ("cuda", "mps", "rocm", "opencl", "cpu")
    """
    # Start background detection if not already started
    _start_background_detection()

    # Return cached result if available
    if _state._gpu_detection_cache["device_type"] is not None:
        return _state._gpu_detection_cache["device_type"]

    # If background detection is not complete, return immediate fallback
    if not _state._background_detection_complete:
        logger.debug("GPU detection in progress, returning CPU fallback")
        return _state.DEVICE_TYPE_CPU

    # noinspection PyBroadException
    try:
        # Check PyTorch availability lazily
        torch_available = _state._check_torch_availability()

        # Check PyTorch CUDA
        # noinspection PyUnresolvedReferences
        if torch_available and _state.torch.cuda.is_available():
            device_type = _state.DEVICE_TYPE_CUDA
        # Check PyTorch MPS (Apple Silicon)
        # noinspection PyUnresolvedReferences
        elif torch_available and hasattr(_state.torch.backends, "mps") and _state.torch.backends.mps.is_available():
            device_type = _state.DEVICE_TYPE_MPS
        # Check ROCm
        elif torch_available and hasattr(_state.torch, "hip") and _state.torch.hip.is_available():
            device_type = _state.DEVICE_TYPE_ROCM
        # Check if any GPU is available via other methods
        elif get_all_gpus():
            device_type = _state.DEVICE_TYPE_OPENCL
        else:
            device_type = _state.DEVICE_TYPE_CPU
    except Exception as e:
        logger.debug("Error detecting device type, defaulting to CPU: %s", e)
        device_type = _state.DEVICE_TYPE_CPU

    # Cache the result
    _state._gpu_detection_cache["device_type"] = device_type
    return device_type


def get_gpu_type() -> str | None:
    """
    Determine the primary GPU type available.

    Returns:
        str | None: GPU type or None if no GPU is available
    """
    gpus = get_all_gpus()
    if not gpus:
        return None

    # Prioritize dedicated GPUs
    for gpu in gpus:
        if gpu.get("vendor") == _state.GPU_TYPE_NVIDIA:
            return _state.GPU_TYPE_NVIDIA
        elif gpu.get("vendor") == _state.GPU_TYPE_AMD:
            return _state.GPU_TYPE_AMD

    # Then integrated GPUs
    for gpu in gpus:
        if gpu.get("vendor") == _state.GPU_TYPE_APPLE:
            return _state.GPU_TYPE_APPLE
        elif gpu.get("vendor") == _state.GPU_TYPE_INTEL:
            return _state.GPU_TYPE_INTEL

    return gpus[0].get("vendor", _state.GPU_TYPE_UNKNOWN)


def get_primary_gpu() -> dict | None:
    """
    Get information about the primary GPU.

    Returns:
        Dictionary with primary GPU information or None if no GPU available
    """
    gpus = get_all_gpus()
    if not gpus:
        return None

    # Prioritize GPUs with known memory
    gpus_with_memory = [gpu for gpu in gpus if "total_memory_mb" in gpu]
    if gpus_with_memory:
        # Sort by memory size (descending)
        gpus_with_memory.sort(key=lambda x: x["total_memory_mb"], reverse=True)
        return gpus_with_memory[0]

    # Return first GPU if no memory info available
    return gpus[0]


def get_gpu_memory_info() -> dict:
    """
    Get comprehensive GPU memory information.

    Returns:
        Dictionary with GPU memory details
    """
    primary_gpu = get_primary_gpu()
    if not primary_gpu:
        return {"has_gpu": False, "total_memory_mb": 0, "available_memory_mb": 0, "used_memory_mb": 0, "vendor": None}

    total_memory = primary_gpu.get("total_memory_mb", 0)
    used_memory = primary_gpu.get("used_memory_mb", 0)
    free_memory = primary_gpu.get("free_memory_mb", 0)

    # Calculate available memory if not directly provided
    if not free_memory and total_memory and used_memory:
        free_memory = total_memory - used_memory
    elif not used_memory and total_memory and free_memory:
        used_memory = total_memory - free_memory

    # Conservative estimate if we don't have usage info
    if not free_memory and total_memory:
        free_memory = int(total_memory * 0.8)  # Assume 80% available

    return {
        "has_gpu": True,
        "total_memory_mb": total_memory,
        "available_memory_mb": free_memory,
        "used_memory_mb": used_memory,
        "vendor": primary_gpu.get("vendor"),
        "name": primary_gpu.get("name"),
        "detection_method": primary_gpu.get("detection_method"),
    }


def calculate_max_parameters(memory_gb: float, quantization_bits: int) -> float:
    """
    Calculate maximum model parameters in billions based on memory and quantization.
    Uses the formula: M = (P * 4B) / (32 / Q) * 1.2
    Rearranged: P = M / ((4B / (32 / Q)) * 1.2)

    Args:
        memory_gb: Available memory in GB
        quantization_bits: Quantization bits (16, 8, 4)

    Returns:
        Maximum parameters in billions
    """
    return memory_gb / ((4.0 / (32.0 / quantization_bits)) * 1.2)


def get_recommended_quantization(memory_gb: float) -> str:
    """
    Determine the recommended quantization based on available memory.

    Args:
        memory_gb: Available memory in GB

    Returns:
        str: "fp16", "int8", or "int4" based on available memory
    """
    if memory_gb >= 24:
        return "fp16"
    elif memory_gb >= 8:
        return "int8"
    else:
        return "int4"


@timing_decorator("Get System Capabilities")
def get_system_capabilities() -> dict:
    """
    Get comprehensive system GPU capabilities and memory availability for model compatibility.

    Returns:
        Dictionary with system capabilities information
    """
    # Return cached result if available
    if _state._gpu_detection_cache["system_capabilities"] is not None:
        return _state._gpu_detection_cache["system_capabilities"]

    # If not initialized yet, note that we're doing expensive operations
    if not _state._gpu_system_initialized:
        logger.debug("GPU system not initialized, performing system capabilities detection")

    system_info_template = {
        "os": platform.system(),
        "architecture": platform.machine(),
        "python_version": platform.python_version(),
        "has_gpu": False,
        "gpu_count": 0,
        "primary_gpu": None,
        "all_gpus": [],
        "device_type": get_device_type(),
        "memory": {"gpu_memory_mb": 0, "available_gpu_mb": 0, "cpu_memory_mb": 0, "available_cpu_mb": 0},
        "recommended_quantization": "int8",
    }

    try:
        # Get all GPU information (call once and reuse)
        all_gpus = get_all_gpus()
        system_info_template["all_gpus"] = all_gpus
        system_info_template["gpu_count"] = len(all_gpus)
        system_info_template["has_gpu"] = len(all_gpus) > 0

        # Get primary GPU info (reuse all_gpus to avoid redundant calls)
        primary_gpu = None
        if all_gpus:
            # Prioritize GPUs with known memory (same logic as get_primary_gpu)
            gpus_with_memory = [gpu for gpu in all_gpus if "total_memory_mb" in gpu]
            if gpus_with_memory:
                # Sort by memory size (descending)
                gpus_with_memory.sort(key=lambda x: x["total_memory_mb"], reverse=True)
                primary_gpu = gpus_with_memory[0]
            else:
                # Return first GPU if no memory info available
                primary_gpu = all_gpus[0]

        if primary_gpu:
            system_info_template["primary_gpu"] = primary_gpu

            # Get GPU memory info (reuse primary_gpu to avoid redundant calls)
            total_memory_mb = primary_gpu.get("total_memory_mb", 0)
            available_memory_mb = primary_gpu.get("available_memory_mb", total_memory_mb)
            # noinspection PyUnresolvedReferences
            system_info_template["memory"]["gpu_memory_mb"] = total_memory_mb
            # noinspection PyUnresolvedReferences
            system_info_template["memory"]["available_gpu_mb"] = available_memory_mb

            # Determine recommended quantization based on GPU memory
            # noinspection PyUnresolvedReferences
            gpu_memory_gb = system_info_template["memory"]["available_gpu_mb"] / 1024
            if gpu_memory_gb >= 8:
                system_info_template["recommended_quantization"] = get_recommended_quantization(gpu_memory_gb)

            logger.info("Primary GPU: %s (%s) - %sMB", primary_gpu["name"], primary_gpu["vendor"], total_memory_mb)

        # Get CPU memory info
        total_memory = psutil.virtual_memory().total
        available_memory = psutil.virtual_memory().available

        # noinspection PyUnresolvedReferences
        system_info_template["memory"]["cpu_memory_mb"] = total_memory // (1024 * 1024)
        # noinspection PyUnresolvedReferences
        system_info_template["memory"]["available_cpu_mb"] = available_memory // (1024 * 1024)

        # If no GPU or insufficient GPU memory, use CPU memory for recommendations
        # noinspection PyUnresolvedReferences
        if not system_info_template["has_gpu"] or system_info_template["memory"]["available_gpu_mb"] < 4096:
            # noinspection PyUnresolvedReferences
            cpu_memory_gb = system_info_template["memory"]["available_cpu_mb"] / 1024
            if cpu_memory_gb >= 16:
                system_info_template["recommended_quantization"] = "int8"
            elif cpu_memory_gb >= 8:
                system_info_template["recommended_quantization"] = "int4"
            else:
                system_info_template["recommended_quantization"] = "int4"

        # noinspection PyUnresolvedReferences
        logger.info("System capabilities: %s GPU(s), %sMB RAM", system_info_template["gpu_count"], system_info_template["memory"]["cpu_memory_mb"])

        # Cache the result
        _state._gpu_detection_cache["system_capabilities"] = system_info_template
        save_gpu_cache()
        return system_info_template

    except Exception as e:
        logger.error("Error getting system capabilities: %s", str(e))
        # Cache the error result to avoid repeated failures
        _state._gpu_detection_cache["system_capabilities"] = system_info_template
        save_gpu_cache()
        return system_info_template


# Background GPU detection functions
def _background_gpu_detection():
    """Run GPU detection in background to avoid blocking startup."""
    try:
        logger.debug("Starting background GPU detection...")

        # Detect all GPU types in parallel if possible
        _detect_nvidia_gpus()  # This will cache results
        _detect_amd_gpus()  # This will cache results
        _detect_apple_gpus()  # This will cache results
        _detect_intel_gpus()  # This will cache results

        # Determine device type internally (avoid circular call)
        _state._check_torch_availability()
        _determine_device_type_internal()  # Internal version without background detection call

        # Get system capabilities
        get_system_capabilities()  # This will cache the result

        _state._background_detection_complete = True
        logger.info("Background GPU detection completed successfully")

    except Exception as e:
        logger.warning("Background GPU detection failed: %s", e)
        # Set fallback values
        _state._gpu_detection_cache["device_type"] = "cpu"
        _state._background_detection_complete = True


def _start_background_detection():
    """Background detection disabled to prevent race conditions. Detection now happens synchronously with caching."""
    # Mark as started and complete to prevent any background detection
    _state._background_detection_started = True
    _state._background_detection_complete = True
    logger.debug("Background GPU detection disabled - using synchronous detection with caching")


# Background GPU detection is started on-demand when needed
# This prevents duplicate detection during module import
# _start_background_detection()  # Removed automatic startup


# Legacy compatibility functions
def get_cuda_gpu_info() -> list[dict]:
    """
    Get detailed information about CUDA GPUs (legacy compatibility).

    Returns:
        List of dictionaries with GPU details
    """
    return _detect_nvidia_gpus()


def get_apple_silicon_info() -> dict:
    """
    Get information about Apple Silicon (MPS) capabilities (legacy compatibility).

    Returns:
        Dictionary with Apple Silicon details
    """
    apple_gpus = _detect_apple_gpus()
    if apple_gpus:
        return apple_gpus[0]

    # Fallback for compatibility
    total_memory = psutil.virtual_memory().total / (1024**3)  # in GB
    available_memory = total_memory * 0.5

    max_params_fp16 = calculate_max_parameters(available_memory, 16)
    max_params_int8 = calculate_max_parameters(available_memory, 8)
    max_params_int4 = calculate_max_parameters(available_memory, 4)

    return {
        "id": 0,
        "name": "Apple Silicon",
        "vram_gb": round(available_memory, 2),
        "max_parameters": {
            "fp16": round(max_params_fp16, 2),
            "int8": round(max_params_int8, 2),
            "int4": round(max_params_int4, 2),
        },
    }


def get_cpu_memory_info() -> dict:
    """
    Get information about CPU memory availability for model compatibility (legacy compatibility).

    Returns:
        Dictionary with CPU memory details and parameter estimates
    """
    total_memory = psutil.virtual_memory().total / (1024**3)  # in GB
    available_memory = total_memory * 0.7  # Let's assume 70% of RAM can be used

    max_params_fp16 = calculate_max_parameters(available_memory, 16)
    max_params_int8 = calculate_max_parameters(available_memory, 8)
    max_params_int4 = calculate_max_parameters(available_memory, 4)

    return {
        "available_gb": round(available_memory, 2),
        "max_parameters": {
            "fp16": round(max_params_fp16, 2),
            "int8": round(max_params_int8, 2),
            "int4": round(max_params_int4, 2),
        },
    }


def initialize_gpu_system():
    """
    Initialize the GPU detection system once during application startup.
    This should be called early in the application lifecycle to populate all caches.
    """
    if _state._gpu_system_initialized:
        logger.debug("GPU system already initialized, skipping")
        return

    logger.info("🚀 Initializing GPU detection system...")

    try:
        # Perform all GPU detection in one go
        start_time = time.time()

        # This will populate all caches at once
        all_gpus = get_all_gpus()
        device_type = _determine_device_type_internal()
        system_caps = get_system_capabilities()

        # Mark as initialized
        _state._gpu_system_initialized = True

        elapsed = time.time() - start_time
        gpu_count = len(all_gpus)
        has_gpu = system_caps.get("has_gpu", False)
        logger.info(
            "✔️ GPU detection system initialized in %.2fs - Found %d GPU(s), device type: %s, GPU available: %s",
            elapsed,
            gpu_count,
            device_type,
            has_gpu,
        )

    except Exception as e:
        logger.warning("⚠️ GPU detection system initialization failed: %s", e)
        # Set fallback values to prevent repeated failures
        _state._gpu_detection_cache["all_gpus"] = []
        _state._gpu_detection_cache["device_type"] = "cpu"
        _state._gpu_detection_cache["system_capabilities"] = {"has_gpu": False, "gpu_count": 0, "device_type": "cpu"}
        _state._gpu_system_initialized = True
