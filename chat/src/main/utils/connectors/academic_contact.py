"""
Shared access to academic API contact credentials.

Every external academic API we talk to (Crossref, OpenAlex, Unpaywall,
Semantic Scholar, PubMed) benefits from or requires a contact email as
part of the polite-pool / fair-use agreement. Unpaywall in particular
rejects placeholder addresses like "test@example.com" with HTTP 422.

This module is the single point of truth for:
  - `get_academic_contact_email()`: the mailto/email used in polite
    pool parameters and User-Agent headers
  - `get_openalex_api_key()`: optional OpenAlex API key
  - `get_semantic_scholar_api_key()`: optional Semantic Scholar key
  - `get_ncbi_api_key()`: optional NCBI (PubMed) key

Lookup order for each value:
  1. `system_settings` table row with the corresponding upper-case key
     (ACADEMIC_CONTACT_EMAIL / OPENALEX_API_KEY / S2_API_KEY / NCBI_API_KEY)
  2. `academic_apis` block in `configs/config.yaml`
  3. Hardcoded fallback for the contact email; `None` for API keys

System-settings lookup is best-effort: if no database session is
available or the table is missing (e.g., during unit tests or very
early startup), the function silently falls through to config + env.
Results are cached per-process because these values are effectively
static over the lifetime of a worker — callers should not mutate them.
"""

from functools import lru_cache

from sqlalchemy import text

from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_DEFAULT_CONTACT_EMAIL = "research@mail.scrapalot.app"


def _read_system_setting(key: str) -> str | None:
    """Fetch a single system_settings value by key, or None on any failure."""
    try:
        # Imported lazily to avoid circular imports during module load
        from src.main.config.database import SessionLocal

        db = SessionLocal()
        try:
            row = db.execute(
                text("SELECT value FROM system_settings WHERE key = :key"),
                {"key": key},
            ).fetchone()
            if row and row[0]:
                return str(row[0]).strip() or None
        finally:
            db.close()
    except Exception as e:
        logger.debug("system_settings lookup for %s unavailable: %s", key, e)
    return None


def _read_config(path: str) -> str | None:
    """Read a dotted config path like 'academic_apis.contact_email'."""
    node = resolved_config
    for part in path.split("."):
        if not isinstance(node, dict):
            return None
        node = node.get(part)
        if node is None:
            return None
    if isinstance(node, str):
        stripped = node.strip()
        return stripped or None
    return None


@lru_cache(maxsize=1)
def get_academic_contact_email() -> str:
    """
    Return the contact email used for academic API polite pools.

    Never returns an empty string — falls back to the hardcoded default
    so downstream HTTP clients always have a legal value to send.
    """
    value = _read_system_setting("ACADEMIC_CONTACT_EMAIL")
    if value:
        return value

    value = _read_config("academic_apis.contact_email")
    if value:
        return value

    return _DEFAULT_CONTACT_EMAIL


@lru_cache(maxsize=1)
def get_openalex_api_key() -> str | None:
    """OpenAlex API key or None if not configured."""
    return _read_system_setting("OPENALEX_API_KEY") or _read_config("academic_apis.openalex_api_key")


@lru_cache(maxsize=1)
def get_semantic_scholar_api_key() -> str | None:
    """Semantic Scholar API key or None if not configured."""
    return _read_system_setting("S2_API_KEY") or _read_config("academic_apis.semantic_scholar_api_key")


@lru_cache(maxsize=1)
def get_ncbi_api_key() -> str | None:
    """NCBI (PubMed) API key or None if not configured."""
    return _read_system_setting("NCBI_API_KEY") or _read_config("academic_apis.ncbi_api_key")


def get_polite_user_agent(product: str = "Scrapalot/1.0") -> str:
    """
    Return a User-Agent header string that includes the contact email
    in the format the Crossref, OpenAlex, and Unpaywall documentation
    recommend: "<product> (mailto:<email>)".
    """
    return f"{product} (mailto:{get_academic_contact_email()})"
