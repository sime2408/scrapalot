"""GPU and accelerator utilities.

- ``devices`` - Device detection, memory allocation helpers, CUDA / MPS / CPU
                 dispatch logic, and PyTorch device wrappers.
"""

# Re-export commonly imported helpers so callers can use
# `from src.main.utils.gpu import get_all_gpus, get_device_type, ...`
# without reaching into the `devices` submodule. The container health
# probe (`python -c "from src.main.utils.gpu import get_all_gpus; ..."`
# in docker-compose) depends on this — without the re-export the probe
# fails with ImportError every ~10 s and docker compose flips the
# container into restart-loop, killing any in-flight subprocess
# (notably long Cat-F reprocess runs).
from src.main.utils.gpu.devices import (
    get_all_gpus,
    get_device_type,
    get_system_capabilities,
    is_gpu_available,
)

__all__ = [
    "get_all_gpus",
    "get_device_type",
    "get_system_capabilities",
    "is_gpu_available",
]
