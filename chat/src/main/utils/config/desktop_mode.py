"""
Desktop Mode Utilities

Provides utilities for detecting and managing desktop mode in Scrapalot.
Desktop mode forces SQLite database, local-only authentication, and single-user operation.
"""

import os
from pathlib import Path

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def is_desktop_mode() -> bool:
    """
    Check if the application is running in desktop mode.

    Desktop mode is enabled when SCRAPALOT_DESKTOP_MODE environment variable is set to 'true'.
    In desktop mode:
    - SQLite database is forced (no PostgreSQL)
    - Single local user (no registration/login UI)
    - Data stored in user's home directory (.scrapalot folder)
    - API key-based authentication for local security

    Returns:
        bool: True if desktop mode is enabled, False otherwise
    """
    return os.environ.get("SCRAPALOT_DESKTOP_MODE", "").lower() == "true"


def get_desktop_data_directory() -> Path:
    """
    Get the desktop mode data directory path.

    Priority:
    1. SCRAPALOT_DATA_DIR environment variable (if set)
    2. Default: {user_home}/.scrapalot

    The directory structure:
    .scrapalot/
    ├── scrapalot.db      # SQLite database
    ├── data/             # Uploaded documents
    ├── models/           # Local AI models
    ├── cache/            # Embeddings cache
    └── logs/             # Application logs

    Returns:
        Path: Absolute path to the desktop data directory
    """
    data_dir = os.environ.get("SCRAPALOT_DATA_DIR")

    if data_dir:
        return Path(data_dir).resolve()

    # Default to .scrapalot in user's home directory
    return Path.home() / ".scrapalot"


def get_desktop_database_path() -> str:
    """
    Get the SQLite database path for desktop mode.

    Returns:
        str: Absolute path to the SQLite database file
    """
    db_path = os.environ.get("SQLITE_DATABASE_PATH")

    if db_path:
        return db_path

    # Default: scrapalot.db in the data directory
    return str(get_desktop_data_directory() / "scrapalot.db")


def ensure_desktop_directories() -> None:
    """
    Ensure all required desktop mode directories exist.

    Creates:
    - Main data directory (.scrapalot)
    - data/ subdirectory (for documents)
    - models/ subdirectory (for local AI models)
    - cache/ subdirectory (for embeddings cache)
    - logs/ subdirectory (for application logs)
    """
    if not is_desktop_mode():
        return

    data_dir = get_desktop_data_directory()

    # Create main directory
    data_dir.mkdir(parents=True, exist_ok=True)
    logger.info("Desktop data directory: %s", data_dir)

    # Create subdirectories
    subdirs = ["data", "models", "cache", "logs"]
    for subdir in subdirs:
        subdir_path = data_dir / subdir
        subdir_path.mkdir(parents=True, exist_ok=True)
        logger.debug("Created subdirectory: %s", subdir_path)


def get_desktop_uploads_directory() -> Path:
    """
    Get the directory for uploaded documents in desktop mode.

    Returns:
        Path: Path to the data/ subdirectory
    """
    return get_desktop_data_directory() / "data"


def get_desktop_models_directory() -> Path:
    """
    Get the directory for local AI models in desktop mode.

    Returns:
        Path: Path to the models/ subdirectory
    """
    return get_desktop_data_directory() / "models"


def get_desktop_cache_directory() -> Path:
    """
    Get the directory for cache files in desktop mode.

    Returns:
        Path: Path to the cache/ subdirectory
    """
    return get_desktop_data_directory() / "cache"


def get_desktop_logs_directory() -> Path:
    """
    Get the directory for log files in desktop mode.

    Returns:
        Path: Path to the logs/ subdirectory
    """
    return get_desktop_data_directory() / "logs"


def get_desktop_api_key_from_env() -> str | None:
    """
    Get the desktop API key from environment variable.

    This is set by the Electron main process when starting the backend.

    Returns:
        str | None: Desktop API key if set, None otherwise
    """
    return os.environ.get("SCRAPALOT_DESKTOP_API_KEY")


# Initialize desktop directories when module is imported in desktop mode
if is_desktop_mode():
    logger.info("Desktop mode enabled")
    ensure_desktop_directories()
