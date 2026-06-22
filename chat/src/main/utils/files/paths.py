"""
Path utility functions for handling file paths and URL construction.

Supports two storage path patterns:
    - ``data/upload/``  — traditional direct uploads
    - ``data/content/`` — content-addressable storage (deduplication)
"""

from __future__ import annotations

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Known data path prefixes (checked in order). Tuple so it can't be mutated.
_DATA_PATH_PREFIXES: tuple[str, ...] = ("data/upload/", "data/content/")


def _normalize_separators(path: str) -> str:
    """Convert any backslashes to forward slashes."""
    return path.replace("\\", "/")


def _find_data_path(normalized_path: str) -> str | None:
    """Return the substring beginning at the first known data prefix, else ``None``."""
    for prefix in _DATA_PATH_PREFIXES:
        idx = normalized_path.find(prefix)
        if idx != -1:
            return normalized_path[idx:]
    return None


def normalize_upload_path_to_url(full_path: str, source: str) -> str:
    """Normalise a file path to a document URL.

    Extracts the relative path from ``data/upload/`` or ``data/content/``
    and prepends ``/documents/file/``. Handles both forward and back
    slashes; falls back to ``/documents/file/data/upload/{source}`` when
    no known prefix is present.

    Examples::

        >>> normalize_upload_path_to_url("/app/data/upload/file.pdf", "file.pdf")
        '/documents/file/data/upload/file.pdf'
        >>> normalize_upload_path_to_url("/app/data/content/23/3a/abc/file.pdf", "file.pdf")
        '/documents/file/data/content/23/3a/abc/file.pdf'
    """
    if not full_path:
        logger.warning("Empty file path provided, using fallback with source: %s", source)
        return f"/documents/file/data/upload/{source}"

    relative_path = _find_data_path(_normalize_separators(full_path))
    if relative_path:
        url = f"/documents/file/{relative_path}"
        logger.debug("Constructed URL: %s from path: %s", url, full_path)
        return url

    logger.warning(
        "Path does not contain data/upload/ or data/content/: %s, using fallback with source: %s",
        full_path,
        source,
    )
    return f"/documents/file/data/upload/{source}"


def extract_relative_upload_path(full_path: str) -> str | None:
    """Return the relative path starting from a known data prefix, or ``None``."""
    return _find_data_path(_normalize_separators(full_path))


def normalize_path_for_db(path: str) -> str:
    """Normalise a file path for database storage.

    Converts absolute paths to relative paths starting from
    ``data/upload/`` or ``data/content/`` and replaces all backslashes
    with forward slashes. Returns the input unchanged (modulo separator
    normalisation) when no known prefix is present.
    """
    if not path:
        return path

    normalized = _normalize_separators(path)
    relative_path = _find_data_path(normalized)
    if relative_path:
        return relative_path

    logger.warning(
        "Path does not contain 'data/upload/' or 'data/content/': %s - storing as-is",
        path,
    )
    return normalized
