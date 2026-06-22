"""Per-vendor GPU detection probes (NVIDIA / AMD / Apple / Intel / OpenCL / Vulkan).

Each probe lazily imports its backend (torch / pynvml / subprocess CLI tools),
reads and writes the shared ``_state._gpu_detection_cache``, and persists via
``save_gpu_cache``. The cross-vendor orchestration that calls these probes lives
in ``_detection.py``.
"""

# noinspection PyUnresolvedReferences
import json
import platform
import re

import psutil

from src.main.utils.core.logger import get_logger, timing_decorator
from src.main.utils.gpu import _state
from src.main.utils.gpu._cache import save_gpu_cache

# noinspection PyPackageRequirements
logger = get_logger(__name__)


@timing_decorator("NVIDIA GPU Detection")
def _detect_nvidia_gpus() -> list[dict]:
    """
    Detect NVIDIA GPUs using multiple methods.

    Returns:
        List of NVIDIA GPU information dictionaries
    """
    gpus = []

    # Return cached result if available
    cached_nvidia_gpus = _state._gpu_detection_cache["nvidia_gpus"]
    if cached_nvidia_gpus is not None:
        return cached_nvidia_gpus

    # Method 1: PyTorch CUDA
    # noinspection PyUnresolvedReferences
    if _state._torch_available and _state.torch.cuda.is_available():
        try:
            # noinspection PyUnresolvedReferences
            device_count = _state.torch.cuda.device_count()
            logger.info("PyTorch CUDA device count: %s", device_count)

            for i in range(device_count):
                logger.debug("Processing GPU %s of %s", i, device_count)
                # noinspection PyUnresolvedReferences
                props = _state.torch.cuda.get_device_properties(i)
                gpu_info = {
                    "id": i,
                    "name": props.name,
                    "vendor": _state.GPU_TYPE_NVIDIA,
                    "total_memory_mb": props.total_memory // (1024 * 1024),
                    "compute_capability": f"{props.major}.{props.minor}",
                    "multiprocessor_count": props.multi_processor_count,
                    "detection_method": "torch_cuda",
                }

                # Try to get more detailed memory info
                # noinspection PyBroadException
                try:
                    # noinspection PyTypeChecker,PyUnresolvedReferences
                    gpu_info["allocated_memory_mb"] = _state.torch.cuda.memory_allocated(i) // (1024 * 1024)
                    # noinspection PyTypeChecker,PyUnresolvedReferences
                    gpu_info["cached_memory_mb"] = _state.torch.cuda.memory_reserved(i) // (1024 * 1024)
                    # noinspection PyTypeChecker,PyUnresolvedReferences
                    gpu_info["free_memory_mb"] = gpu_info["total_memory_mb"] - gpu_info["allocated_memory_mb"]
                except Exception as e:
                    logger.debug("Could not get detailed GPU memory info: %s", e)

                gpus.append(gpu_info)
                logger.info("Detected NVIDIA GPU %s via PyTorch: %s (%sMB)", i, gpu_info["name"], gpu_info["total_memory_mb"])

            logger.info("Total NVIDIA GPUs detected via PyTorch: %s", len(gpus))
        except Exception as e:
            logger.debug("Error detecting NVIDIA GPUs via PyTorch: %s", e)

    # Method 2: PyNVML
    if _state._check_pynvml_availability() and not gpus:  # Only use if PyTorch didn't find anything
        try:
            # noinspection PyUnresolvedReferences
            _state.pynvml.nvmlInit()
            # noinspection PyUnresolvedReferences
            device_count = _state.pynvml.nvmlDeviceGetCount()

            for i in range(device_count):
                # noinspection PyUnresolvedReferences
                handle = _state.pynvml.nvmlDeviceGetHandleByIndex(i)
                # noinspection PyUnresolvedReferences
                name = _state.pynvml.nvmlDeviceGetName(handle).decode("utf-8")
                # noinspection PyUnresolvedReferences
                mem_info = _state.pynvml.nvmlDeviceGetMemoryInfo(handle)

                gpu_info = {
                    "id": i,
                    "name": name,
                    "vendor": _state.GPU_TYPE_NVIDIA,
                    "total_memory_mb": mem_info.total // (1024 * 1024),
                    "used_memory_mb": mem_info.used // (1024 * 1024),
                    "free_memory_mb": mem_info.free // (1024 * 1024),
                    "detection_method": "pynvml",
                }

                # noinspection PyBroadException
                try:
                    # Get additional info
                    # noinspection PyUnresolvedReferences
                    uuid = _state.pynvml.nvmlDeviceGetUUID(handle).decode("utf-8")
                    gpu_info["uuid"] = uuid

                    # noinspection PyUnresolvedReferences
                    utilization = _state.pynvml.nvmlDeviceGetUtilizationRates(handle)
                    gpu_info["gpu_utilization"] = utilization.gpu
                    gpu_info["memory_utilization"] = utilization.memory
                except Exception as e:
                    logger.debug("Could not get detailed GPU memory info: %s", e)

                gpus.append(gpu_info)
                logger.info("Detected NVIDIA GPU via PyNVML: %s (%sMB)", gpu_info["name"], gpu_info["total_memory_mb"])
        except Exception as e:
            logger.debug("Error detecting NVIDIA GPUs via PyNVML: %s", e)

    # Method 3: nvidia-smi command
    if _state._nvidia_smi_available and not gpus:  # Only use if other methods didn't find anything
        try:
            output = _state._run_command(
                [
                    "nvidia-smi",
                    "--query-gpu=index,name,memory.total,memory.used,memory.free,uuid",
                    "--format=csv,noheader,nounits",
                ]
            )

            if output:
                for line in output.split("\n"):
                    if line.strip():
                        parts = [p.strip() for p in line.split(",")]
                        if len(parts) >= 6:
                            gpu_info = {
                                "id": int(parts[0]),
                                "name": parts[1],
                                "vendor": _state.GPU_TYPE_NVIDIA,
                                "total_memory_mb": int(parts[2]),
                                "used_memory_mb": int(parts[3]),
                                "free_memory_mb": int(parts[4]),
                                "uuid": parts[5],
                                "detection_method": "nvidia_smi",
                            }
                            gpus.append(gpu_info)
                            logger.info("Detected NVIDIA GPU via nvidia-smi: %s (%sMB)", gpu_info["name"], gpu_info["total_memory_mb"])
        except Exception as e:
            logger.debug("Error detecting NVIDIA GPUs via nvidia-smi: %s", e)

    # Cache the result
    _state._gpu_detection_cache["nvidia_gpus"] = gpus
    save_gpu_cache()
    return gpus


@timing_decorator("AMD GPU Detection")
def _detect_amd_gpus() -> list[dict]:
    """
    Detect AMD GPUs using multiple methods.

    Returns:
        List of AMD GPU information dictionaries
    """
    # Return cached result if available
    cached_amd_gpus = _state._gpu_detection_cache["amd_gpus"]
    if cached_amd_gpus is not None:
        logger.debug("AMD GPU detection: returning cached result with %s GPUs", len(cached_amd_gpus))
        return cached_amd_gpus

    logger.debug("AMD GPU detection: no cached result, performing detection")

    gpus = []

    # Method 1: ROCm via PyTorch
    if _state._check_torch_availability():
        try:
            # Check if ROCm is available
            if hasattr(_state.torch, "hip") and _state.torch.hip.is_available():
                for i in range(_state.torch.hip.device_count()):
                    props = _state.torch.hip.get_device_properties(i)
                    gpu_info = {
                        "id": i,
                        "name": props.name,
                        "vendor": _state.GPU_TYPE_AMD,
                        "total_memory_mb": props.total_memory // (1024 * 1024),
                        "detection_method": "torch_hip",
                    }
                    gpus.append(gpu_info)
                    logger.info("Detected AMD GPU via PyTorch HIP: %s (%sMB)", gpu_info["name"], gpu_info["total_memory_mb"])
            # noinspection PyUnresolvedReferences
            elif _state.torch.cuda.is_available() and "rocm" in _state.torch.__version__.lower():
                # ROCm with CUDA compatibility layer
                # noinspection PyUnresolvedReferences
                for i in range(_state.torch.cuda.device_count()):
                    # noinspection PyUnresolvedReferences
                    props = _state.torch.cuda.get_device_properties(i)
                    gpu_info = {
                        "id": i,
                        "name": props.name,
                        "vendor": _state.GPU_TYPE_AMD,
                        "total_memory_mb": props.total_memory // (1024 * 1024),
                        "detection_method": "torch_rocm_cuda",
                    }
                    gpus.append(gpu_info)
                    logger.info("Detected AMD GPU via PyTorch ROCm: %s (%sMB)", gpu_info["name"], gpu_info["total_memory_mb"])
        except Exception as e:
            logger.debug("Error detecting AMD GPUs via PyTorch: %s", e)

    # Early exit if we found GPUs via PyTorch
    if gpus:
        logger.debug("AMD GPU detection: found %s GPUs via PyTorch, skipping other methods", len(gpus))
        _state._gpu_detection_cache["amd_gpus"] = gpus
        save_gpu_cache()
        return gpus

    # Method 2: rocm-smi command (only if no PyTorch GPUs found)
    if _state._rocm_smi_available:
        try:
            # Get basic GPU info with shorter timeout
            output = _state._run_command(["rocm-smi", "--showid", "--showproductname", "--format=csv"], timeout=3)
            if output:
                lines = output.strip().split("\n")
                for line in lines[1:]:  # Skip header
                    if line.strip():
                        parts = [p.strip() for p in line.split(",")]
                        if len(parts) >= 3:
                            gpu_id = int(parts[0])
                            gpu_name = parts[2]

                            gpu_info = {
                                "id": gpu_id,
                                "name": gpu_name,
                                "vendor": _state.GPU_TYPE_AMD,
                                "detection_method": "rocm_smi",
                            }

                            # Try to get memory info with shorter timeout
                            # noinspection PyBroadException
                            try:
                                mem_output = _state._run_command(
                                    ["rocm-smi", f"--device={gpu_id}", "--showmeminfo", "vram", "--format=csv"],
                                    timeout=2,
                                )
                                if mem_output:
                                    mem_lines = mem_output.strip().split("\n")
                                    for mem_line in mem_lines[1:]:  # Skip header
                                        if mem_line.strip():
                                            mem_parts = [p.strip() for p in mem_line.split(",")]
                                            if len(mem_parts) >= 4:
                                                gpu_info["total_memory_mb"] = int(mem_parts[1])
                                                gpu_info["used_memory_mb"] = int(mem_parts[2])
                                                # noinspection PyTypeChecker,PyUnresolvedReferences
                                                gpu_info["free_memory_mb"] = gpu_info["total_memory_mb"] - gpu_info["used_memory_mb"]
                                                break
                            except Exception as e:
                                logger.debug("Could not parse AMD GPU memory info: %s", e)

                            gpus.append(gpu_info)
                            memory_info = f"({gpu_info.get('total_memory_mb', 'Unknown')}MB)" if "total_memory_mb" in gpu_info else ""
                            logger.info("Detected AMD GPU via rocm-smi: %s %s", gpu_info["name"], memory_info)
        except Exception as e:
            logger.debug("Error detecting AMD GPUs via rocm-smi: %s", e)

    # Early exit if we found GPUs via rocm-smi
    if gpus:
        logger.debug("AMD GPU detection: found %s GPUs via rocm-smi, skipping WMI", len(gpus))
        _state._gpu_detection_cache["amd_gpus"] = gpus
        save_gpu_cache()
        return gpus

    # Method 3: Try to detect via system info on Windows (only as last resort)
    if platform.system() == "Windows":
        try:
            # Use wmic with shorter timeout for faster detection
            output = _state._run_command(
                [
                    "wmic",
                    "path",
                    "win32_VideoController",
                    "where",
                    "name like '%AMD%' or name like '%Radeon%'",
                    "get",
                    "name,AdapterRAM",
                    "/format:csv",
                ],
                timeout=5,
            )  # Reduced from default 10s to 5s

            if output:
                for line in output.split("\n"):
                    if "AMD" in line or "Radeon" in line:
                        parts = [p.strip() for p in line.split(",")]
                        if len(parts) >= 3 and parts[2]:  # Ensure we have a name
                            # Format: Node,AdapterRAM,Name
                            name = parts[2]

                            # Parse dedicated VRAM
                            dedicated_ram_mb = None
                            try:
                                if len(parts) > 1 and parts[1]:
                                    ram_bytes = int(parts[1])
                                    dedicated_ram_mb = ram_bytes // (1024 * 1024)
                            except (ValueError, IndexError) as e:
                                logger.debug("Could not parse dedicated VRAM from wmic output: %s", e)

                            # For AMD APUs, try to detect shared system memory (quick estimation)
                            shared_memory_mb = None
                            total_memory_mb = dedicated_ram_mb or 0

                            if dedicated_ram_mb and dedicated_ram_mb <= 2048:  # Likely an APU if <= 2GB dedicated
                                # noinspection PyBroadException
                                try:
                                    # Quick system memory estimation without another WMI call
                                    import psutil

                                    total_system_memory_mb = psutil.virtual_memory().total // (1024 * 1024)
                                    # AMD APUs typically can use up to 50% of system RAM for graphics
                                    shared_memory_mb = min(total_system_memory_mb // 2, 16384)  # Cap at 16GB
                                    total_memory_mb += shared_memory_mb
                                except Exception as e:
                                    logger.debug("Could not get system memory for APU estimation: %s", e)

                            gpu_info = {
                                "id": len(gpus),
                                "name": name,
                                "vendor": _state.GPU_TYPE_AMD,
                                "detection_method": "windows_wmi_fast",
                                "dedicated_memory_mb": dedicated_ram_mb,
                                "shared_memory_mb": shared_memory_mb,
                                "total_memory_mb": total_memory_mb,
                            }

                            gpus.append(gpu_info)

                            # Enhanced logging with memory breakdown
                            if shared_memory_mb:
                                logger.info(
                                    "Detected AMD APU via Windows WMI: %s (Dedicated: %sMB, Shared: %sMB, Total: %sMB)",
                                    name,
                                    dedicated_ram_mb,
                                    shared_memory_mb,
                                    total_memory_mb,
                                )
                            else:
                                memory_info = f"({dedicated_ram_mb}MB)" if dedicated_ram_mb else ""
                                logger.info("Detected AMD GPU via Windows WMI: %s %s", name, memory_info)
        except Exception as e:
            logger.debug("Error detecting AMD GPUs via Windows WMI: %s", e)

    # Cache the result
    logger.debug("AMD GPU detection: caching result with %s GPUs", len(gpus))
    _state._gpu_detection_cache["amd_gpus"] = gpus
    save_gpu_cache()
    return gpus


@timing_decorator("Apple GPU Detection")
def _detect_apple_gpus() -> list[dict]:
    """
    Detect Apple Silicon GPUs.

    Returns:
        List of Apple GPU information dictionaries
    """
    gpus = []

    if platform.system() == "Darwin":  # macOS
        try:
            # Method 1: PyTorch MPS
            # noinspection PyUnresolvedReferences
            if _state._torch_available and hasattr(_state.torch.backends, "mps") and _state.torch.backends.mps.is_available():
                # Apple Silicon doesn't have dedicated VRAM, use system memory estimation
                total_memory = psutil.virtual_memory().total
                # Estimate GPU memory as 60% of system memory (Apple Silicon shares memory)
                estimated_gpu_memory = int(total_memory * 0.6) // (1024 * 1024)

                gpu_info = {
                    "id": 0,
                    "name": "Apple Silicon GPU",
                    "vendor": _state.GPU_TYPE_APPLE,
                    "total_memory_mb": estimated_gpu_memory,
                    "shared_memory": True,
                    "detection_method": "torch_mps",
                }

                # Try to get more specific chip info
                # noinspection PyBroadException
                try:
                    output = _state._run_command(["system_profiler", "SPHardwareDataType", "-json"])
                    if output:
                        data = json.loads(output)
                        if "SPHardwareDataType" in data:
                            for item in data["SPHardwareDataType"]:
                                if "chip_type" in item:
                                    gpu_info["name"] = f"Apple {item['chip_type']} GPU"
                                    gpu_info["chip_type"] = item["chip_type"]
                                    break
                except Exception as e:
                    logger.debug("Could not get detailed GPU memory info: %s", e)

                gpus.append(gpu_info)
                logger.info("Detected Apple GPU: %s (%sMB shared)", gpu_info["name"], gpu_info["total_memory_mb"])
        except Exception as e:
            logger.debug("Error detecting Apple GPUs: %s", e)

    return gpus


@timing_decorator("Intel GPU Detection")
def _detect_intel_gpus() -> list[dict]:
    """
    Detect Intel GPUs.

    Returns:
        List of Intel GPU information dictionaries
    """
    # Return cached result if available
    cached_intel_gpus = _state._gpu_detection_cache["intel_gpus"]
    if cached_intel_gpus is not None:
        logger.debug("Intel GPU detection: returning cached result with %s GPUs", len(cached_intel_gpus))
        return cached_intel_gpus

    logger.debug("Intel GPU detection: no cached result, performing detection")
    gpus = []

    # Method 1: Try via system info on Windows (the fastest method)
    if platform.system() == "Windows":
        try:
            # WMI output format with faster timeout: Node,AdapterRAM,Name
            output = _state._run_command(
                [
                    "wmic",
                    "path",
                    "win32_VideoController",
                    "where",
                    "name like '%Intel%' and (name like '%Graphics%' or name like '%Iris%' or name like '%UHD%' or name like '%Arc%')",
                    "get",
                    "name,AdapterRAM",
                    "/format:csv",
                ],
                timeout=1,
            )  # Aggressive timeout for startup performance

            if output:
                for line in output.split("\n"):
                    if "Intel" in line and ("Graphics" in line or "Iris" in line or "UHD" in line or "Arc" in line):
                        parts = line.split(",")
                        if len(parts) >= 3:
                            # Format: Node,AdapterRAM,Name
                            # Skip the node part (parts[0]) as it's not used
                            try:
                                ram_bytes = int(parts[1].strip())
                                ram_mb = ram_bytes // (1024 * 1024)
                            except (ValueError, IndexError):
                                ram_mb = None
                            name = parts[2].strip()

                            gpu_info = {
                                "id": len(gpus),
                                "name": name,
                                "vendor": _state.GPU_TYPE_INTEL,
                                "detection_method": "windows_wmi_fast",
                            }
                            if ram_mb:
                                gpu_info["total_memory_mb"] = ram_mb

                            gpus.append(gpu_info)
                            memory_info = f"({ram_mb}MB)" if ram_mb else ""
                            logger.info("Detected Intel GPU via Windows WMI: %s %s", name, memory_info)
        except Exception as e:
            logger.debug("Error detecting Intel GPUs via Windows WMI: %s", e)

    # Early exit if we found GPUs on Windows
    if gpus and platform.system() == "Windows":
        logger.debug("Intel GPU detection: found %s GPUs via Windows WMI, skipping other methods", len(gpus))
        _state._gpu_detection_cache["intel_gpus"] = gpus
        save_gpu_cache()
        return gpus

    # Method 2: Try via intel_gpu_top (Linux only, if no Windows results)
    elif platform.system() == "Linux" and _state._intel_gpu_top_available:
        try:
            output = _state._run_command(["intel_gpu_top", "-l"], timeout=2)  # Reduced timeout
            if output and "Intel" in output:
                # Parse intel_gpu_top output
                gpu_info = {
                    "id": 0,
                    "name": "Intel Integrated Graphics",
                    "vendor": _state.GPU_TYPE_INTEL,
                    "detection_method": "intel_gpu_top",
                }
                gpus.append(gpu_info)
                logger.info("Detected Intel GPU via intel_gpu_top: %s", gpu_info["name"])
        except Exception as e:
            logger.debug("Error detecting Intel GPUs via intel_gpu_top: %s", e)

    # Cache the result
    logger.debug("Intel GPU detection: caching result with %s GPUs", len(gpus))
    _state._gpu_detection_cache["intel_gpus"] = gpus
    save_gpu_cache()
    return gpus


@timing_decorator("OpenCL GPU Detection")
def _detect_opencl_gpus() -> list[dict]:
    """
    Detect GPUs via OpenCL as a fallback method.

    Returns:
        List of GPU information dictionaries detected via OpenCL
    """
    gpus = []

    if _state._clinfo_available:
        try:
            output = _state._run_command(["clinfo", "--list"])
            if output:
                for line in output.split("\n"):
                    if "Device" in line and "GPU" in line:
                        # Extract GPU name from clinfo output
                        match = re.search(r"Device.*?GPU.*?:\s*(.+)", line)
                        if match:
                            name = match.group(1).strip()
                            vendor = _state.GPU_TYPE_UNKNOWN

                            # Try to determine vendor from name
                            if any(x in name.upper() for x in ["NVIDIA", "GEFORCE", "QUADRO", "TESLA"]):
                                vendor = _state.GPU_TYPE_NVIDIA
                            elif any(x in name.upper() for x in ["AMD", "RADEON", "VEGA", "NAVI"]):
                                vendor = _state.GPU_TYPE_AMD
                            elif any(x in name.upper() for x in ["INTEL", "IRIS", "UHD"]):
                                vendor = _state.GPU_TYPE_INTEL

                            gpu_info = {"id": len(gpus), "name": name, "vendor": vendor, "detection_method": "opencl"}
                            gpus.append(gpu_info)
                            logger.info("Detected GPU via OpenCL: %s (%s)", name, vendor)
        except Exception as e:
            logger.debug("Error detecting GPUs via OpenCL: %s", e)

    return gpus


@timing_decorator("Vulkan GPU Detection")
def _detect_vulkan_gpus() -> list[dict]:
    """
    Detect GPUs via Vulkan as a universal method.

    Vulkan provides better cross-platform support and can detect GPUs
    that other methods might miss, especially on newer drivers.

    Returns:
        List of GPU information dictionaries detected via Vulkan
    """
    # Return cached result if available
    if _state._gpu_detection_cache.get("vulkan_gpus") is not None:
        logger.debug("Vulkan GPU detection: returning cached result with %s GPUs", len(_state._gpu_detection_cache["vulkan_gpus"]))
        return _state._gpu_detection_cache["vulkan_gpus"]

    logger.debug("Vulkan GPU detection: no cached result, performing detection")
    gpus = []

    # Early check: if vulkaninfo is not available, skip entirely
    if not _state._vulkaninfo_available:
        logger.debug("vulkaninfo not available, skipping Vulkan detection")
        _state._gpu_detection_cache["vulkan_gpus"] = gpus
        save_gpu_cache()
        return gpus

    # Windows-specific optimization: Skip Vulkan if it's consistently problematic
    if platform.system() == "Windows":
        # noinspection PyBroadException
        try:
            # Quick test with very short timeout on Windows
            # noinspection PyTypeChecker
            test_output = _state._run_command(["vulkaninfo", "--summary"], timeout=0.5)
            if not test_output or "ERROR" in test_output or "No Vulkan" in test_output:
                logger.debug("Vulkan not working properly on Windows, skipping detailed detection")
                _state._gpu_detection_cache["vulkan_gpus"] = gpus
                save_gpu_cache()
                return gpus
        except Exception as e:
            logger.debug("Vulkan detection failed on Windows: %s, skipping", e)
            _state._gpu_detection_cache["vulkan_gpus"] = gpus
            save_gpu_cache()
            return gpus

    try:
        # Quick test to see if Vulkan is working at all with very short timeout
        # noinspection PyTypeChecker
        test_output = _state._run_command(["vulkaninfo", "--summary"], timeout=0.5)  # Aggressive timeout for startup
        if not test_output or "ERROR" in test_output or "No Vulkan" in test_output:
            logger.debug("Vulkan not available or no devices found, skipping detailed detection")
            _state._gpu_detection_cache["vulkan_gpus"] = gpus
            save_gpu_cache()
            return gpus

        # If basic test passes, do more detailed detection with reduced timeout
        output = _state._run_command(["vulkaninfo", "--summary"], timeout=2)  # Reduced from 5s to 2s
        if output:
            current_gpu = None
            for line in output.split("\n"):
                line = line.strip()

                # Look for GPU device listings
                if "GPU" in line and ("Device" in line or "Physical Device" in line):
                    # Extract GPU name and properties
                    # Example: "GPU0: AMD Radeon RX 7900 XTX (RADV NAVI31)"
                    match = re.search(r"GPU\d+:\s*(.+)", line)
                    if match:
                        name = match.group(1).strip()
                        vendor = _state.GPU_TYPE_UNKNOWN

                        # Determine vendor from name
                        if any(x in name.upper() for x in ["NVIDIA", "GEFORCE", "QUADRO", "TESLA", "RTX"]):
                            vendor = _state.GPU_TYPE_NVIDIA
                        elif any(x in name.upper() for x in ["AMD", "RADEON", "VEGA", "NAVI", "RDNA"]):
                            vendor = _state.GPU_TYPE_AMD
                        elif any(x in name.upper() for x in ["INTEL", "IRIS", "UHD", "ARC"]):
                            vendor = _state.GPU_TYPE_INTEL
                        elif any(x in name.upper() for x in ["APPLE", "M1", "M2", "M3", "M4"]):
                            vendor = _state.GPU_TYPE_APPLE

                        current_gpu = {
                            "id": len(gpus),
                            "name": name,
                            "vendor": vendor,
                            "detection_method": "vulkan",
                            "vulkan_capable": True,
                            "supports_compute": True,  # Vulkan GPUs support compute by definition
                        }

                # Look for memory information
                elif current_gpu is not None and "Device Memory" in line:
                    # Try to extract memory size
                    memory_match = re.search(r"(\d+)\s*([MGT]B)", line)
                    if memory_match:
                        size = int(memory_match.group(1))
                        unit = memory_match.group(2)

                        if unit == "GB":
                            current_gpu["total_memory_mb"] = size * 1024
                        elif unit == "MB":
                            current_gpu["total_memory_mb"] = size
                        elif unit == "TB":
                            current_gpu["total_memory_mb"] = size * 1024 * 1024

                # Check for specific Vulkan capabilities
                elif current_gpu is not None and any(cap in line.lower() for cap in ["fp16", "storage", "compute"]):
                    if "fp16" in line.lower() and "support" in line.lower():
                        current_gpu["supports_fp16"] = "true" in line.lower() or "yes" in line.lower()

                # End of device info, add to list
                elif current_gpu is not None and (line == "" or line.startswith("GPU")):
                    gpus.append(current_gpu)
                    logger.info("Detected GPU via Vulkan: %s (%s)", current_gpu["name"], current_gpu["vendor"])
                    current_gpu = None

            # Add the last GPU if we were processing one
            if current_gpu:
                gpus.append(current_gpu)
                logger.info("Detected GPU via Vulkan: %s (%s)", current_gpu["name"], current_gpu["vendor"])

    except Exception as e:
        logger.debug("Error detecting GPUs via Vulkan: %s", e)

    # Only try alternative JSON detection if summary failed and we have no results
    if not gpus:
        try:
            # Try a simpler vulkaninfo command with shorter timeout
            output = _state._run_command(["vulkaninfo", "--json"], timeout=3)  # Reduced timeout
            if output:
                import json

                try:
                    vulkan_data = json.loads(output)
                    if "VkPhysicalDevice" in vulkan_data:
                        devices = vulkan_data["VkPhysicalDevice"]
                        if not isinstance(devices, list):
                            devices = [devices]

                        for i, device in enumerate(devices):
                            properties = device.get("VkPhysicalDeviceProperties", {})
                            device_name = properties.get("deviceName", f"Vulkan Device {i}")
                            device_type = properties.get("deviceType", "Unknown")

                            # Only include GPU devices
                            if "GPU" in device_type.upper() or any(
                                gpu_hint in device_name.upper() for gpu_hint in ["RADEON", "GEFORCE", "QUADRO", "TESLA", "RTX", "ARC", "IRIS"]
                            ):
                                vendor = _state.GPU_TYPE_UNKNOWN
                                if any(x in device_name.upper() for x in ["NVIDIA", "GEFORCE", "QUADRO", "TESLA"]):
                                    vendor = _state.GPU_TYPE_NVIDIA
                                elif any(x in device_name.upper() for x in ["AMD", "RADEON", "VEGA", "NAVI"]):
                                    vendor = _state.GPU_TYPE_AMD
                                elif any(x in device_name.upper() for x in ["INTEL", "IRIS", "UHD", "ARC"]):
                                    vendor = _state.GPU_TYPE_INTEL

                                gpu_info = {
                                    "id": len(gpus),
                                    "name": device_name,
                                    "vendor": vendor,
                                    "detection_method": "vulkan_json",
                                    "vulkan_capable": True,
                                    "device_type": device_type,
                                }

                                # Try to get memory info
                                memory_properties = device.get("VkPhysicalDeviceMemoryProperties", {})
                                if "memoryHeaps" in memory_properties:
                                    total_memory = 0
                                    for heap in memory_properties["memoryHeaps"]:
                                        if isinstance(heap, dict) and "size" in heap:
                                            total_memory += heap["size"]

                                    if total_memory > 0:
                                        gpu_info["total_memory_mb"] = total_memory // (1024 * 1024)

                                gpus.append(gpu_info)
                                logger.info("Detected GPU via Vulkan JSON: %s (%s)", device_name, vendor)

                except json.JSONDecodeError:
                    logger.debug("Failed to parse vulkaninfo JSON output")
        except Exception as e:
            logger.debug("Error with alternative Vulkan detection: %s", e)

    # Cache the result
    logger.debug("Vulkan GPU detection: caching result with %s GPUs", len(gpus))
    _state._gpu_detection_cache["vulkan_gpus"] = gpus
    save_gpu_cache()
    return gpus
