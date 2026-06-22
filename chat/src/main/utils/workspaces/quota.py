"""
Storage-quota management for user subscription tiers.

Calculates per-user / per-workspace storage usage, returns the user's
tier-based limit, and answers "can this upload proceed?".

Key concept: quotas are enforced against the WORKSPACE OWNER, not the
user performing the upload. When User B uploads to User A's shared
workspace, the bytes count against User A's quota.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from src.main.config.database import DB_TYPE, engine
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Tier configuration
# ---------------------------------------------------------------------------

# Storage limits in bytes (``None`` means unlimited / enterprise).
#
# These are a FALLBACK only. The authoritative per-user limit is the
# ``storage_limit_bytes`` value synced from the Kotlin backend (which owns
# billing) into the ``subscription`` user_setting. This map is used when a
# subscription row carries a tier name but no explicit limit, or for users
# whose subscription has not been synced yet. Plan names mirror the Kotlin
# ``subscription_plans`` table (post-migration 084); ``professional`` is kept
# as a legacy alias for rows seeded by the old Python alembic seed (007).
STORAGE_LIMITS: dict[str, int | None] = {
    "researcher": 1 * 1024**3,
    "pro": 10 * 1024**3,
    "team": 100 * 1024**3,
    "enterprise": None,
    "professional": 10 * 1024**3,  # legacy alias for "pro"
}

# Memory-only document caps (``None`` = unlimited).
MEMORY_ONLY_LIMITS: dict[str, int | None] = {
    "researcher": 1000,
    "pro": None,
    "team": None,
    "enterprise": None,
    "professional": None,  # legacy alias for "pro"
}

_RESEARCHER_DEFAULT_LIMIT = STORAGE_LIMITS["researcher"]


# ---------------------------------------------------------------------------
# Database column / SQL detection
# ---------------------------------------------------------------------------


def _get_available_metadata_columns() -> dict[str, bool]:
    """Return which file-size-bearing columns exist on the ``documents`` table.

    Supports three migration states:
      * post-040 with the dedicated ``file_size`` column
      * post-040 with ``file_metadata`` JSON column
      * pre-040 with the older ``doc_metadata`` JSON column
    """
    try:
        inspector = inspect(engine)
        # noinspection PyUnresolvedReferences
        columns = [col["name"] for col in inspector.get_columns("documents")]
        return {
            "file_size": "file_size" in columns,
            "file_metadata": "file_metadata" in columns,
            "doc_metadata": "doc_metadata" in columns,
        }
    except Exception as e:
        logger.warning("Error checking column availability: %s", e)
        # Default to assuming the old pre-040 schema.
        return {"file_size": False, "file_metadata": False, "doc_metadata": True}


def get_file_size_extraction() -> str:
    """Return a ``COALESCE(...)`` SQL expression that yields the file size in bytes.

    Probes the live schema and emits backward-compatible expressions for
    both PostgreSQL (JSONB operators) and SQLite (``JSON_EXTRACT``).
    """
    available = _get_available_metadata_columns()
    is_postgres = DB_TYPE == "postgresql"
    parts: list[str] = []

    if available["file_size"]:
        parts.append("d.file_size")

    if is_postgres:
        if available["file_metadata"]:
            parts.append(
                """
                CASE
                    WHEN d.file_metadata::jsonb ? 'file_size'
                    THEN (d.file_metadata::jsonb->>'file_size')::BIGINT
                    WHEN d.file_metadata::jsonb ? 'size'
                    THEN (d.file_metadata::jsonb->>'size')::BIGINT
                    ELSE NULL
                END
                """
            )
        if available["doc_metadata"]:
            parts.append(
                """
                CASE
                    WHEN d.doc_metadata::jsonb ? 'file_size'
                    THEN (d.doc_metadata::jsonb->>'file_size')::BIGINT
                    WHEN d.doc_metadata::jsonb ? 'size'
                    THEN (d.doc_metadata::jsonb->>'size')::BIGINT
                    ELSE NULL
                END
                """
            )
    else:
        if available["file_metadata"]:
            parts.append(
                """
                CASE
                    WHEN d.file_metadata IS NOT NULL AND d.file_metadata LIKE '%"file_size"%'
                    THEN CAST(JSON_EXTRACT(d.file_metadata, '$.file_size') AS INTEGER)
                    WHEN d.file_metadata IS NOT NULL AND d.file_metadata LIKE '%"size"%'
                    THEN CAST(JSON_EXTRACT(d.file_metadata, '$.size') AS INTEGER)
                    ELSE NULL
                END
                """
            )
        if available["doc_metadata"]:
            parts.append(
                """
                CASE
                    WHEN d.doc_metadata IS NOT NULL AND d.doc_metadata LIKE '%"file_size"%'
                    THEN CAST(JSON_EXTRACT(d.doc_metadata, '$.file_size') AS INTEGER)
                    WHEN d.doc_metadata IS NOT NULL AND d.doc_metadata LIKE '%"size"%'
                    THEN CAST(JSON_EXTRACT(d.doc_metadata, '$.size') AS INTEGER)
                    ELSE NULL
                END
                """
            )

    parts.append("0")
    sep = ",\n                "
    return f"COALESCE(\n                {sep.join(parts)}\n            )"


# ---------------------------------------------------------------------------
# Usage + limit + tier resolution
# ---------------------------------------------------------------------------


def get_user_storage_usage(db: Session, user_id: str) -> int:
    """Sum bytes across all documents in workspaces owned by ``user_id``."""
    try:
        file_size_sql = get_file_size_extraction()
        result = db.execute(
            text(
                f"""
                SELECT COALESCE(SUM({file_size_sql}), 0) as total_bytes
                FROM documents d
                JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id
                WHERE cwm.owner_user_id = :user_id
                """
            ),
            {"user_id": user_id},
        ).fetchone()
        # noinspection PyUnresolvedReferences
        total_bytes = int(result.total_bytes) if result else 0
        logger.debug(
            "User %s storage usage: %d bytes (%.2f GB)",
            user_id,
            total_bytes,
            total_bytes / (1024**3),
        )
        return total_bytes
    except Exception as e:
        logger.error("Error calculating storage usage for user %s: %s", user_id, e)
        return 0


def _get_subscription_setting(db: Session, user_id: str) -> dict[str, Any] | None:
    """Return the parsed ``subscription`` user_setting dict, or ``None``.

    Subscription tables live in the Kotlin backend DB; the chat-side DB only
    mirrors the plan in ``user_settings`` under the ``"subscription"`` key
    (synced from Kotlin via the Redis Streams SAGA). The value carries both
    ``tier`` (plan name) and the authoritative ``storage_limit_bytes``.
    """
    try:
        result = db.execute(
            text(
                """
                SELECT setting_value
                FROM user_settings
                WHERE user_id = :user_id AND setting_key = 'subscription'
                """
            ),
            {"user_id": user_id},
        ).fetchone()

        # noinspection PyUnresolvedReferences
        if not (result and result.setting_value):
            return None

        import json  # local import — only needed on the slow path

        # noinspection PyUnresolvedReferences
        raw = result.setting_value
        data = json.loads(raw) if isinstance(raw, str) else raw
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, AttributeError, TypeError) as e:
        logger.debug("Could not parse subscription setting for user %s: %s", user_id, e)
        return None
    except Exception as e:
        logger.error("Error reading subscription setting for user %s: %s", user_id, e)
        return None


def get_user_subscription_tier(db: Session, user_id: str) -> str:
    """Resolve a user's plan/tier name (defaulting to ``"researcher"``)."""
    data = _get_subscription_setting(db, user_id)
    if data:
        tier = data.get("tier") or data.get("subscription_tier")
        if tier:
            logger.debug("Found subscription tier '%s' for user %s", tier, user_id)
            return str(tier)
    logger.debug("No subscription found for user %s, defaulting to 'researcher'", user_id)
    return "researcher"


def get_user_storage_limit(db: Session, user_id: str) -> int | None:
    """Return the user's storage limit in bytes (``None`` = unlimited).

    Prefers the authoritative ``storage_limit_bytes`` synced from Kotlin so a
    plan-price/limit change never requires touching this service. Falls back to
    the ``STORAGE_LIMITS`` map by tier name, then to the researcher default.
    """
    try:
        data = _get_subscription_setting(db, user_id)
        if data:
            # Authoritative limit synced from Kotlin (billing owner).
            if "storage_limit_bytes" in data:
                raw_limit = data["storage_limit_bytes"]
                limit = None if raw_limit is None else int(raw_limit)
                logger.debug("User %s storage limit from sync: %s", user_id, limit)
                return limit
            tier = data.get("tier") or data.get("subscription_tier")
            if tier in STORAGE_LIMITS:
                return STORAGE_LIMITS[tier]
        return _RESEARCHER_DEFAULT_LIMIT
    except Exception as e:
        logger.error("Error getting storage limit for user %s: %s", user_id, e)
        return _RESEARCHER_DEFAULT_LIMIT


# ---------------------------------------------------------------------------
# Quota checks
# ---------------------------------------------------------------------------


def _bytes_to_gb(value: int | None) -> float:
    return (value or 0) / (1024**3)


def check_storage_quota(db: Session, user_id: str, additional_bytes: int) -> dict[str, Any]:
    """Decide whether ``additional_bytes`` fits within the user's remaining quota.

    Uses the WORKSPACE OWNER's quota; pass the owner's ``user_id``, not
    the uploader's. Returns a dict with ``allowed`` / ``usage`` /
    ``limit`` / ``tier`` / ``message`` fields suitable for an HTTP 507
    response when ``allowed`` is ``False``.
    """
    try:
        current_usage = get_user_storage_usage(db, user_id)
        storage_limit = get_user_storage_limit(db, user_id)
        tier = get_user_subscription_tier(db, user_id)

        if storage_limit is None:
            logger.info("User %s has unlimited storage (enterprise tier)", user_id)
            return {
                "allowed": True,
                "usage": current_usage,
                "limit": None,
                "tier": tier,
                "message": "Unlimited storage available (enterprise tier)",
            }

        new_total = current_usage + additional_bytes
        usage_gb = _bytes_to_gb(current_usage)
        limit_gb = _bytes_to_gb(storage_limit)
        file_gb = _bytes_to_gb(additional_bytes)
        new_total_gb = _bytes_to_gb(new_total)

        if new_total > storage_limit:
            logger.warning(
                "Storage quota exceeded for user %s: Current %.2fGB + File %.2fGB = %.2fGB > Limit %.2fGB",
                user_id,
                usage_gb,
                file_gb,
                new_total_gb,
                limit_gb,
            )
            return {
                "allowed": False,
                "usage": current_usage,
                "limit": storage_limit,
                "tier": tier,
                "message": (
                    f"Storage quota exceeded. "
                    f"Current usage: {usage_gb:.2f}GB. "
                    f"File size: {file_gb:.2f}GB. "
                    f"Total would be: {new_total_gb:.2f}GB. "
                    f"Limit: {limit_gb:.2f}GB ({tier} tier). "
                    f"Please upgrade to a higher tier for more storage."
                ),
            }

        remaining_gb = (storage_limit - new_total) / (1024**3)
        logger.info(
            "Storage quota check passed for user %s: %.2fGB + %.2fGB = %.2fGB / %.2fGB (%.2fGB remaining)",
            user_id,
            usage_gb,
            file_gb,
            new_total_gb,
            limit_gb,
            remaining_gb,
        )
        return {
            "allowed": True,
            "usage": current_usage,
            "limit": storage_limit,
            "tier": tier,
            "message": f"Storage available: {remaining_gb:.2f}GB remaining of {limit_gb:.2f}GB",
        }

    except Exception as e:
        logger.error("Error checking storage quota for user %s: %s", user_id, e)
        return {
            "allowed": False,
            "usage": 0,
            "limit": 0,
            "tier": "unknown",
            "message": f"Error checking storage quota: {e!s}",
        }


def check_memory_only_quota(db: Session, user_id: str) -> dict[str, Any]:
    """Cap the count of in-memory-only documents per tier.

    Memory-only documents consume zero disk quota but are limited by
    count: ``researcher`` = 1000, ``professional`` / ``enterprise`` =
    unlimited.
    """
    try:
        tier = get_user_subscription_tier(db, user_id)
        # Unknown tiers fall back to the researcher cap (restrictive), not to
        # unlimited — only tiers explicitly mapped to None are uncapped.
        limit = MEMORY_ONLY_LIMITS.get(tier, MEMORY_ONLY_LIMITS["researcher"])

        if limit is None:
            return {
                "allowed": True,
                "count": 0,
                "limit": None,
                "tier": tier,
                "message": "Unlimited memory-only documents",
            }

        count_result = db.execute(
            text(
                """
                SELECT COUNT(d.id)
                FROM documents d
                JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id
                WHERE cwm.owner_user_id = :user_id
                  AND d.file_stored = false
                """
            ),
            {"user_id": user_id},
        ).scalar()

        count = int(count_result or 0)
        if count >= limit:
            logger.warning(
                "Memory-only document limit reached for user %s: %d/%d (%s tier)",
                user_id,
                count,
                limit,
                tier,
            )
            return {
                "allowed": False,
                "count": count,
                "limit": limit,
                "tier": tier,
                "message": (f"Memory-only document limit reached ({count}/{limit} for {tier} tier). Upgrade to a higher tier for unlimited."),
            }

        logger.debug(
            "Memory-only quota check passed for user %s: %d/%d (%s tier)",
            user_id,
            count,
            limit,
            tier,
        )
        return {
            "allowed": True,
            "count": count,
            "limit": limit,
            "tier": tier,
            "message": f"{count}/{limit} memory-only documents used",
        }

    except Exception as e:
        logger.error("Error checking memory-only quota for user %s: %s", user_id, e)
        return {
            "allowed": False,
            "count": 0,
            "limit": 0,
            "tier": "unknown",
            "message": f"Error checking memory-only quota: {e!s}",
        }


# ---------------------------------------------------------------------------
# Workspace-scoped reporting
# ---------------------------------------------------------------------------


_EMPTY_WORKSPACE_USAGE: dict[str, Any] = {
    "workspace_bytes": 0,
    "workspace_gb": 0,
    "document_count_monthly": 0,
    "document_count_total": 0,
    "owner_id": None,
}


def get_workspace_storage_usage(db: Session, workspace_id: str) -> dict[str, Any]:
    """Return storage stats for a specific workspace (bytes + GB + counts + owner)."""
    try:
        file_size_sql = get_file_size_extraction()
        monthly_filter = (
            """
            WHEN d.created_at >= date_trunc('month', CURRENT_DATE)
                AND d.created_at < date_trunc('month', CURRENT_DATE) + interval '1 month'
            """
            if DB_TYPE == "postgresql"
            else """
            WHEN d.created_at >= date('now', 'start of month')
                AND d.created_at < date('now', 'start of month', '+1 month')
            """
        )

        result = db.execute(
            text(
                f"""
                SELECT
                    cwm.owner_user_id as user_id,
                    COUNT(DISTINCT CASE
                        {monthly_filter}
                        THEN d.id
                    END) as document_count_monthly,
                    COUNT(DISTINCT d.id) as document_count_total,
                    COALESCE(SUM({file_size_sql}), 0) as total_bytes
                FROM collection_workspace_map cwm
                LEFT JOIN documents d ON d.collection_id = cwm.collection_id
                WHERE cwm.workspace_id = :workspace_id
                GROUP BY cwm.owner_user_id
                """
            ),
            {"workspace_id": workspace_id},
        ).fetchone()

        if not result:
            return _EMPTY_WORKSPACE_USAGE.copy()

        # noinspection PyUnresolvedReferences
        total_bytes = int(result.total_bytes) if result.total_bytes else 0
        logger.debug(
            "Workspace %s storage usage from database: %s bytes (%s GB) for %s documents this month (%s total documents)",
            workspace_id,
            total_bytes,
            total_bytes / (1024**3),
            # noinspection PyUnresolvedReferences
            result.document_count_monthly,
            # noinspection PyUnresolvedReferences
            result.document_count_total,
        )
        return {
            "workspace_bytes": total_bytes,
            "workspace_gb": total_bytes / (1024**3),
            # noinspection PyUnresolvedReferences
            "document_count_monthly": int(result.document_count_monthly),
            # noinspection PyUnresolvedReferences
            "document_count_total": int(result.document_count_total),
            # noinspection PyUnresolvedReferences
            "owner_id": str(result.user_id),
        }

    except Exception as e:
        logger.error("Error getting workspace storage usage: %s", e)
        return _EMPTY_WORKSPACE_USAGE.copy()
