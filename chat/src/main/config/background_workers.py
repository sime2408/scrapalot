"""
Background worker configuration.

Connector rate limits used by ConnectorRateLimiter.
"""

import os

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# ============================================================================
# Rate Limiting (requests per second per connector type)
# ============================================================================

GOOGLE_DRIVE_RATE_LIMIT = float(os.getenv("GOOGLE_DRIVE_RATE_LIMIT", "10"))
DROPBOX_RATE_LIMIT = float(os.getenv("DROPBOX_RATE_LIMIT", "5"))
NOTION_RATE_LIMIT = float(os.getenv("NOTION_RATE_LIMIT", "3"))
WIKIPEDIA_RATE_LIMIT = float(os.getenv("WIKIPEDIA_RATE_LIMIT", "1"))
ARXIV_RATE_LIMIT = float(os.getenv("ARXIV_RATE_LIMIT", "0.33"))  # ~3 second delay
GOOGLE_SCHOLAR_RATE_LIMIT = float(os.getenv("GOOGLE_SCHOLAR_RATE_LIMIT", "0.5"))
SEMANTIC_SCHOLAR_RATE_LIMIT = float(os.getenv("SEMANTIC_SCHOLAR_RATE_LIMIT", "1"))


def get_rate_limit_for_connector(connector_type: str) -> float | None:
    """
    Get the rate limit for a specific connector type.

    Args:
        connector_type: Type of connector (e.g., 'google_drive', 'wikipedia')

    Returns:
        Rate limit in requests per second, or None if no limit is configured
    """
    rate_limits = {
        "google_drive": GOOGLE_DRIVE_RATE_LIMIT,
        "dropbox": DROPBOX_RATE_LIMIT,
        "notion": NOTION_RATE_LIMIT,
        "wikipedia": WIKIPEDIA_RATE_LIMIT,
        "arxiv": ARXIV_RATE_LIMIT,
        "google_scholar": GOOGLE_SCHOLAR_RATE_LIMIT,
        "semantic_scholar": SEMANTIC_SCHOLAR_RATE_LIMIT,
    }
    return rate_limits.get(connector_type)
