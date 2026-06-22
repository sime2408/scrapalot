"""
Production diagnostics utilities for debugging 502 errors and deployment issues.

Synchronous probes for system resources, the host environment, and basic
outbound connectivity. Designed to be safe to call before the database
is initialised — no heavyweight imports happen at module load.
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import sys
import time
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Port + system + cloud probes
# ---------------------------------------------------------------------------


def check_port_availability(port: int, host: str = "0.0.0.0") -> tuple[bool, str | None]:
    """Return ``(True, None)`` if ``host:port`` is bindable, else ``(False, message)``."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
            return True, None
    except OSError as e:
        return False, f"Port {port} on {host} is not available: {e}"


_IMPORTANT_ENV_VARS: tuple[str, ...] = (
    "POSTGRES_HOST",
    "POSTGRES_PORT",
    "POSTGRES_USER",
    "POSTGRES_DB",
    "REDIS_URL",
    "ENVIRONMENT",
    "HOSTNAME",
    "STATIC_DIR",
    "ENABLE_MIGRATIONS",
)
_SENSITIVE_SUBSTRINGS: tuple[str, ...] = ("password", "key", "secret", "token")


def check_system_resources() -> dict[str, str]:
    """Memory + disk usage + a curated env-var snapshot (sensitive keys masked)."""
    resources: dict[str, str] = {}

    try:
        import psutil

        memory = psutil.virtual_memory()
        resources["memory_total"] = f"{memory.total // (1024**3)}GB"
        resources["memory_available"] = f"{memory.available // (1024**3)}GB"
        resources["memory_percent"] = f"{memory.percent}%"
    except ImportError:
        resources["memory"] = "psutil not available"
    except Exception as e:
        resources["memory_error"] = str(e)

    try:
        import shutil

        total, used, free = shutil.disk_usage("/")
        resources["disk_total"] = f"{total // (1024**3)}GB"
        resources["disk_free"] = f"{free // (1024**3)}GB"
        resources["disk_used_percent"] = f"{(used / total) * 100:.1f}%"
    except Exception as e:
        resources["disk_error"] = str(e)

    for var in _IMPORTANT_ENV_VARS:
        value = os.environ.get(var)
        if not value:
            resources[f"env_{var.lower()}"] = "not_set"
            continue
        if any(s in var.lower() for s in _SENSITIVE_SUBSTRINGS):
            resources[f"env_{var.lower()}"] = "***masked***"
        else:
            resources[f"env_{var.lower()}"] = value

    return resources


_CLOUD_ENV_VARS: tuple[str, ...] = (
    "PORT",
    "NODE_ENV",
    "ENVIRONMENT",
    "DYNO",  # Heroku
    "VERCEL",
    "RAILWAY_ENVIRONMENT",
)


def detect_cloud_environment() -> dict[str, str]:
    """Detect deployment context (docker vs local) and capture cloud-specific env vars."""
    env_info: dict[str, str] = {
        "hostname": os.environ.get("HOSTNAME", socket.gethostname()),
    }

    if os.path.exists("/.dockerenv"):
        env_info["deployment_type"] = "docker"
        env_info["cloud_provider"] = "unknown"
    else:
        env_info["deployment_type"] = "local"
        env_info["cloud_provider"] = "none"

    for var in _CLOUD_ENV_VARS:
        value = os.environ.get(var)
        if value:
            env_info[f"cloud_{var.lower()}"] = value
    return env_info


def check_network_connectivity() -> dict[str, str]:
    """DNS + outbound HTTP + app-port-availability checks."""
    connectivity: dict[str, str] = {}

    try:
        socket.gethostbyname("google.com")
        connectivity["dns_resolution"] = "working"
    except Exception as e:
        connectivity["dns_resolution"] = f"failed: {e}"

    try:
        import urllib.request

        with urllib.request.urlopen("https://httpbin.org/get", timeout=5) as response:
            if response.status == 200:
                connectivity["http_outbound"] = "working"
            else:
                connectivity["http_outbound"] = f"failed: HTTP {response.status}"
    except Exception as e:
        connectivity["http_outbound"] = f"failed: {e}"

    port_available, port_error = check_port_availability(8090)
    connectivity["port_8090_available"] = "yes" if port_available else f"no: {port_error}"
    return connectivity


# ---------------------------------------------------------------------------
# Comprehensive entrypoint
# ---------------------------------------------------------------------------


_STATIC_CANDIDATES: tuple[str, ...] = (
    "/app/static",
    "static",
)


async def run_comprehensive_diagnostics() -> dict[str, Any]:
    """Run every diagnostic and aggregate results (with per-section error keys)."""
    logger.info("Running comprehensive production diagnostics...")

    diagnostics: dict[str, Any] = {
        "timestamp": time.time(),
        "python_version": sys.version,
        "platform": sys.platform,
    }

    for key, fn in (
        ("system_resources", check_system_resources),
        ("cloud_environment", detect_cloud_environment),
        ("network_connectivity", check_network_connectivity),
    ):
        try:
            diagnostics[key] = fn()
        except Exception as e:
            diagnostics[f"{key}_error"] = str(e)

    try:
        from src.main.config.database import DATABASE_URL, engine

        if engine:
            diagnostics["database_engine"] = "initialized"
            diagnostics["database_url_type"] = "postgresql" if "postgresql" in DATABASE_URL.lower() else "sqlite"
        else:
            diagnostics["database_engine"] = "not_initialized"
    except Exception as e:
        diagnostics["database_error"] = str(e)

    try:
        candidates = (
            *_STATIC_CANDIDATES,
            os.path.join(os.getcwd(), "static"),
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "static"),
        )
        for path in candidates:
            if os.path.exists(path):
                index_exists = os.path.exists(os.path.join(path, "index.html"))
                diagnostics[f"static_path_{path.replace('/', '_')}"] = f"exists, index.html: {index_exists}"
                if index_exists:
                    diagnostics["static_files_found"] = path
                    break
        else:
            diagnostics["static_files_found"] = "none"
    except Exception as e:
        diagnostics["static_files_error"] = str(e)

    logger.info("Production diagnostics completed")
    return diagnostics


def log_startup_diagnostics() -> None:
    """Log a one-shot snapshot of system / cloud / network state."""
    logger.info("=== PRODUCTION STARTUP DIAGNOSTICS ===")
    try:
        logger.info("System resources: %s", check_system_resources())
        logger.info("Cloud environment: %s", detect_cloud_environment())
        logger.info("Network connectivity: %s", check_network_connectivity())
    except Exception as e:
        logger.error("Failed to run startup diagnostics: %s", e)
    logger.info("=== END STARTUP DIAGNOSTICS ===")


if __name__ == "__main__":  # pragma: no cover — manual diagnostics runner
    logging.basicConfig(level=logging.INFO)
    log_startup_diagnostics()

    async def _main() -> None:
        diagnostics = await run_comprehensive_diagnostics()
        print("=== COMPREHENSIVE DIAGNOSTICS ===")
        for key, value in diagnostics.items():
            print(f"{key}: {value}")

    asyncio.run(_main())
