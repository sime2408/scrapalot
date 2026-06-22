"""
Internal API-key utilities.

Used for service-to-service auth in desktop mode and a handful of
internal scripts. Keys carry the ``scp-`` prefix and are stored as
SHA-256 hashes only.
"""

from __future__ import annotations

import hashlib
import secrets

_KEY_PREFIX = "scp-"
_RANDOM_PART_LEN = 20


def hash_api_key(api_key: str) -> str:
    """Return the hex-encoded SHA-256 digest of ``api_key``."""
    return hashlib.sha256(api_key.encode()).hexdigest()


def generate_api_key() -> tuple[str, str, str]:
    """Generate a new API key.

    Returns:
        ``(full_key, key_hash, key_prefix)``. The ``key_prefix`` is the
        first 8 characters of the full key (the visible portion shown
        in the UI; the rest is only ever stored hashed).
    """
    random_part = secrets.token_urlsafe(15)[:_RANDOM_PART_LEN]
    full_key = f"{_KEY_PREFIX}{random_part}"
    return full_key, hash_api_key(full_key), full_key[:8]


def verify_api_key(provided_key: str, stored_hash: str) -> bool:
    """Constant-time-ish compare of ``hash(provided_key)`` against ``stored_hash``."""
    return hash_api_key(provided_key) == stored_hash
