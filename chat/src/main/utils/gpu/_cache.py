"""GPU detection cache persistence (file load/save, expiry, Vulkan info files)."""

# noinspection PyUnresolvedReferences
import json
import os
import platform
import re
import time

from src.main.utils.core.logger import get_logger
from src.main.utils.gpu import _state

# noinspection PyPackageRequirements
logger = get_logger(__name__)


def _ensure_cache_directory():
    """Ensure the cache directory exists."""
    try:
        os.makedirs(_state.GPU_CACHE_DIR, exist_ok=True)
    except Exception as e:
        logger.warning("Failed to create cache directory %s: %s", _state.GPU_CACHE_DIR, e)


def _is_cache_expired():
    """Check if the GPU cache has expired."""
    try:
        if not os.path.exists(_state.GPU_CACHE_FILE):
            return True

        cache_mtime = os.path.getmtime(_state.GPU_CACHE_FILE)
        current_time = time.time()
        expiry_time = cache_mtime + (_state.GPU_CACHE_EXPIRY_HOURS * 3600)

        is_expired = current_time > expiry_time
        if is_expired:
            logger.debug("GPU cache expired: %.1f hours old", (current_time - cache_mtime) / 3600)
        else:
            logger.debug("GPU cache valid: %.1f hours old", (current_time - cache_mtime) / 3600)

        return is_expired
    except Exception as e:
        logger.debug("Error checking cache expiry: %s", e)
        return True


def _load_vulkan_info_files():
    """Load GPU information from Vulkan info files if available."""
    vulkan_gpus = []

    try:
        import glob

        # Look for Vulkan info files in current directory and cache directory
        search_paths = [".", _state.GPU_CACHE_DIR]

        for search_path in search_paths:
            pattern = os.path.join(search_path, _state.VULKAN_INFO_PATTERN)
            vulkan_files = glob.glob(pattern)

            for vulkan_file in vulkan_files:
                try:
                    logger.debug("Loading Vulkan info from: %s", vulkan_file)
                    # noinspection PyTypeChecker
                    with open(vulkan_file) as f:
                        vulkan_data = json.load(f)

                    # Extract GPU name from filename
                    # noinspection PyTypeChecker
                    filename = os.path.basename(vulkan_file)
                    # VP_VULKANINFO_AMD_Radeon(TM)_Graphics_2_0_302.json -> AMD_Radeon(TM)_Graphics
                    gpu_name_match = re.search(r"VP_VULKANINFO_(.+?)_\d+_\d+_\d+\.json", filename)
                    gpu_name = gpu_name_match.group(1).replace("_", " ") if gpu_name_match else "Unknown GPU"

                    # Determine vendor from name
                    vendor = _state.GPU_TYPE_UNKNOWN
                    gpu_name_upper = gpu_name.upper()
                    if any(x in gpu_name_upper for x in ["NVIDIA", "GEFORCE", "QUADRO", "TESLA", "RTX"]):
                        vendor = _state.GPU_TYPE_NVIDIA
                    elif any(x in gpu_name_upper for x in ["AMD", "RADEON", "VEGA", "NAVI"]):
                        vendor = _state.GPU_TYPE_AMD
                    elif any(x in gpu_name_upper for x in ["INTEL", "IRIS", "UHD", "ARC"]):
                        vendor = _state.GPU_TYPE_INTEL

                    # Extract capabilities from Vulkan data
                    capabilities = vulkan_data.get("capabilities", {})
                    device_caps = capabilities.get("device", {})
                    extensions = device_caps.get("extensions", {})

                    # Calculate approximate memory from extensions/features
                    memory_mb = 0
                    if "properties" in device_caps:
                        props = device_caps["properties"]
                        if "VkPhysicalDeviceMemoryProperties" in props:
                            memory_props = props["VkPhysicalDeviceMemoryProperties"]
                            if "memoryHeaps" in memory_props:
                                for heap in memory_props["memoryHeaps"]:
                                    if isinstance(heap, dict) and "size" in heap:
                                        memory_mb += heap["size"] // (1024 * 1024)

                    # Create GPU info from Vulkan data
                    gpu_info = {
                        "id": len(vulkan_gpus),
                        "name": gpu_name,
                        "vendor": vendor,
                        "detection_method": "vulkan_file",
                        "vulkan_capable": True,
                        "supports_compute": True,
                        "vulkan_extensions": len(extensions),
                        "vulkan_file": vulkan_file,
                        "last_updated": os.path.getmtime(vulkan_file),
                    }

                    if memory_mb > 0:
                        gpu_info["total_memory_mb"] = memory_mb

                    # Check for specific capabilities
                    if any("fp16" in ext.lower() for ext in extensions):
                        gpu_info["supports_fp16"] = True

                    vulkan_gpus.append(gpu_info)
                    logger.info("Loaded GPU info from Vulkan file: %s (%s)", gpu_name, vendor)

                except Exception as e:
                    logger.debug("Error parsing Vulkan file %s: %s", vulkan_file, e)

    except Exception as e:
        logger.debug("Error loading Vulkan info files: %s", e)

    return vulkan_gpus


def load_gpu_cache():
    """Load GPU cache from file with enhanced validation and Vulkan integration."""
    _ensure_cache_directory()

    try:
        if not os.path.exists(_state.GPU_CACHE_FILE):
            logger.debug("No GPU cache file found")
            return False

        with open(_state.GPU_CACHE_FILE) as f:
            cache_data = json.load(f)

        # Validate cache structure
        if not isinstance(cache_data, dict):
            logger.debug("Invalid cache format")
            return False

        # Check for required cache version/timestamp
        cache_timestamp = cache_data.get("cache_timestamp", 0)
        cache_version = cache_data.get("cache_version", "1.0")

        # Update cache with loaded data
        for key, value in cache_data.items():
            if key in _state._gpu_detection_cache:
                _state._gpu_detection_cache[key] = value

        logger.debug("Loaded GPU cache from file (version: %s, timestamp: %s)", cache_version, cache_timestamp)

        # Try to enhance with Vulkan info files
        vulkan_gpus = _load_vulkan_info_files()
        if vulkan_gpus:
            _state._gpu_detection_cache["vulkan_file_gpus"] = vulkan_gpus
            logger.debug("Enhanced cache with %s GPUs from Vulkan files", len(vulkan_gpus))

        return True

    except FileNotFoundError:
        logger.debug("No GPU cache file found")
        return False
    except json.JSONDecodeError as e:
        logger.debug("Failed to parse GPU cache file: %s", e)
        return False
    except Exception as e:
        logger.debug("Error loading GPU cache: %s", e)
        return False


def save_gpu_cache():
    """Save GPU cache to file with enhanced metadata and validation."""
    _ensure_cache_directory()

    try:
        # Prepare cache data with metadata
        cache_data = dict(_state._gpu_detection_cache)
        cache_data["cache_timestamp"] = time.time()
        cache_data["cache_version"] = "2.0"
        cache_data["python_platform"] = platform.platform()
        cache_data["scrapalot_version"] = "1.0"  # Could be made configurable

        # Write to temporary file first, then rename for atomic operation
        temp_file = _state.GPU_CACHE_FILE + ".tmp"
        with open(temp_file, "w") as f:
            json.dump(cache_data, f, indent=2, default=str)

        # Atomic rename
        if os.path.exists(_state.GPU_CACHE_FILE):
            os.remove(_state.GPU_CACHE_FILE)
        os.rename(temp_file, _state.GPU_CACHE_FILE)

        logger.debug("Saved GPU cache to file: %s", _state.GPU_CACHE_FILE)
        return True

    except Exception as e:
        logger.debug("Failed to save GPU cache: %s", e)
        # Clean up temp file if it exists
        temp_file = _state.GPU_CACHE_FILE + ".tmp"
        if os.path.exists(temp_file):
            try:
                os.remove(temp_file)
            except OSError as e:
                logger.debug("Could not remove temp GPU cache file %s: %s", temp_file, e)
        return False


def _invalidate_expired_cache():
    """Remove expired cache file to force fresh detection."""
    try:
        if os.path.exists(_state.GPU_CACHE_FILE) and _is_cache_expired():
            os.remove(_state.GPU_CACHE_FILE)
            logger.debug("Removed expired GPU cache file")
            # Clear in-memory cache
            for key in _state._gpu_detection_cache:
                _state._gpu_detection_cache[key] = None
            return True
    except Exception as e:
        logger.debug("Error invalidating cache: %s", e)
    return False


def get_gpu_cache_info():
    """Get information about the current GPU cache status."""
    cache_info = {
        "cache_file": _state.GPU_CACHE_FILE,
        "cache_dir": _state.GPU_CACHE_DIR,
        "exists": os.path.exists(_state.GPU_CACHE_FILE),
        "expired": _is_cache_expired(),
        "size_bytes": 0,
        "age_hours": 0,
        "vulkan_files": [],
    }

    try:
        if cache_info["exists"]:
            stat = os.stat(_state.GPU_CACHE_FILE)
            cache_info["size_bytes"] = stat.st_size
            # noinspection PyTypeChecker
            cache_info["age_hours"] = (time.time() - stat.st_mtime) / 3600

        # Find Vulkan info files
        import glob

        pattern = os.path.join(_state.GPU_CACHE_DIR, _state.VULKAN_INFO_PATTERN)
        cache_info["vulkan_files"] = glob.glob(pattern)

    except Exception as e:
        logger.debug("Error getting cache info: %s", e)

    return cache_info


# Initialize GPU caching system
def _initialize_gpu_cache():
    """Initialize the GPU caching system."""
    if _state._gpu_system_initialized:
        return

    try:
        # Check if cache is expired and invalidate if needed
        if _invalidate_expired_cache():
            logger.debug("GPU cache has expired, reloading")

        # Try to load existing cache
        cache_loaded = load_gpu_cache()

        if cache_loaded and not _is_cache_expired():
            logger.debug("Using valid GPU cache from file")
            # Check if we have essential GPU info cached
            if _state._gpu_detection_cache.get("device_type") and _state._gpu_detection_cache.get("all_gpus"):
                logger.debug("Background GPU detection disabled - using synchronous detection with caching")
                _state._gpu_system_initialized = True
                return

        logger.debug("GPU cache invalid or missing - background detection will run")

    except Exception as e:
        logger.debug("Error initializing GPU cache: %s", e)
