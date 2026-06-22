"""Datetime parsing helpers (no external dependencies).

A single source of truth for ISO-8601 parsing that accepts the trailing
``Z`` (UTC) suffix, which ``datetime.fromisoformat`` rejects on older
Python and several external APIs emit (Google Drive, SharePoint,
Confluence, Firecrawl, ...).
"""

from __future__ import annotations

from datetime import datetime


def parse_iso_datetime(date_str: str) -> datetime:
    """Parse an ISO-8601 datetime string, tolerating a trailing ``Z``.

    ``"2024-01-01T00:00:00Z"`` and ``"2024-01-01T00:00:00+00:00"`` both
    parse to the same timezone-aware ``datetime``. Raises ``ValueError``
    on malformed input, exactly as ``datetime.fromisoformat`` does.
    """
    return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
