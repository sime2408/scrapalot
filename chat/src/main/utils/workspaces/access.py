"""
Workspace access utilities — ownership and role lookups.

In shared workspaces files live under the OWNER's directory, so resolving
"the owner of this collection" is the canonical primitive every upload /
delete / read path needs. All queries hit the
``collection_workspace_map`` cache table, which replaces the dropped
``workspaces`` and ``collections`` tables.

Shared access (editor / viewer roles) is managed by the Kotlin backend.
Python only checks workspace ownership.
"""

from __future__ import annotations

import threading
import time as _time

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Short-TTL cache for accessible-collection lookups. A single agentic turn hits
# this 8+ times (discovery + every library tool the agent calls), each a join
# over collection_workspace_map + documents — pure redundant DB work within one
# request. A 15s TTL collapses that burst while keeping staleness negligible
# (newly added collections appear on the next turn). Module-level dict + lock
# per the async rule (no contextvars for cross-task sharing).
_ACCESSIBLE_TTL_S = 15.0
_accessible_cache: dict[tuple[str, str], tuple[float, list[dict]]] = {}
_accessible_cache_lock = threading.Lock()


def get_workspace_owner_for_collection(
    db: Session,
    collection_id: str,
) -> tuple[str, str, str] | None:
    """Return ``(owner_user_id, workspace_id, collection_id)`` or ``None``.

    Use the returned ``owner_user_id`` to build file paths in shared
    workspaces — not ``current_user.id``::

        owner_id, workspace_id, coll_id = get_workspace_owner_for_collection(db, collection_id)
        file_path = f"data/upload/{owner_id}/{workspace_id}/{coll_id}/file.pdf"
    """
    try:
        result = db.execute(
            text(
                """
                SELECT owner_user_id, workspace_id, collection_id
                FROM collection_workspace_map
                WHERE collection_id = :collection_id
                """
            ),
            {"collection_id": collection_id},
        ).fetchone()

        if result:
            # noinspection PyUnresolvedReferences
            return str(result.owner_user_id), str(result.workspace_id), str(result.collection_id)

        logger.warning("No workspace owner found for collection %s", collection_id)
        return None

    except Exception as e:
        logger.error("Error getting workspace owner for collection %s: %s", collection_id, e)
        return None


def check_user_workspace_role(db: Session, user_id: str, workspace_id: str) -> str | None:
    """Return ``"owner"`` when ``user_id`` owns ``workspace_id``, else ``None``."""
    try:
        result = db.execute(
            text(
                """
                SELECT 1
                FROM collection_workspace_map
                WHERE workspace_id = :workspace_id AND owner_user_id = :user_id
                LIMIT 1
                """
            ),
            {"workspace_id": workspace_id, "user_id": user_id},
        ).fetchone()
        return "owner" if result else None
    except Exception as e:
        logger.error("Error checking user workspace role: %s", e)
        return None


def _user_owns_collection(db: Session, user_id: str, collection_id: str) -> bool:
    """Shared primitive: ``True`` when the user owns the workspace that holds the collection."""
    try:
        result = db.execute(
            text(
                """
                SELECT 1
                FROM collection_workspace_map
                WHERE collection_id = :collection_id AND owner_user_id = :user_id
                """
            ),
            {"collection_id": collection_id, "user_id": user_id},
        ).fetchone()
        return result is not None
    except Exception as e:
        logger.error("Error checking collection ownership: %s", e)
        return False


def can_user_modify_collection(db: Session, user_id: str, collection_id: str) -> bool:
    """Return ``True`` when the user can upload / delete in ``collection_id``."""
    return _user_owns_collection(db, user_id, collection_id)


def can_user_read_collection(db: Session, user_id: str, collection_id: str) -> bool:
    """Return ``True`` when the user can read files in ``collection_id``.

    All roles (owner, editor, viewer) can read; shared access is managed
    by the Kotlin backend, so Python only checks ownership.
    """
    return _user_owns_collection(db, user_id, collection_id)


def get_workspace_id_for_collection(db: Session, collection_id: str) -> str | None:
    """Return the workspace UUID containing ``collection_id`` (or ``None``)."""
    try:
        result = db.execute(
            text(
                """
                SELECT workspace_id
                FROM collection_workspace_map
                WHERE collection_id = :collection_id
                """
            ),
            {"collection_id": collection_id},
        ).fetchone()
        # noinspection PyUnresolvedReferences
        return str(result.workspace_id) if result else None
    except Exception as e:
        logger.error("Error getting workspace for collection %s: %s", collection_id, e)
        return None


def get_user_accessible_collections(db: Session, user_id: str, workspace_id: str) -> list[dict]:
    """Return collections the user can access in ``workspace_id`` (with document counts).

    Used by agentic RAG to discover relevant collections when none are
    explicitly specified, and by the library inventory tools. Empty collections
    are excluded.

    Access model: collection_workspace_map only records the collection *owner*,
    so an owner-only filter hides workspaces that were *shared* with the user.
    We therefore widen access to every collection in the workspace when the user
    is a member of it (membership comes from the backend DB), and otherwise keep
    the owner-only filter. Either way the result is scoped to a single
    ``workspace_id`` the caller is already operating in.
    """
    from src.main.utils.workspaces.backend_membership import get_member_workspace_ids

    cache_key = (str(user_id), str(workspace_id))
    now = _time.monotonic()
    with _accessible_cache_lock:
        cached = _accessible_cache.get(cache_key)
        if cached and now - cached[0] < _ACCESSIBLE_TTL_S:
            return cached[1]

    try:
        is_member = str(workspace_id) in get_member_workspace_ids(user_id)
        # Member → all collections in the workspace; non-member → owned only.
        owner_clause = "" if is_member else "\n                  AND cwm.owner_user_id = :user_id"
        result = db.execute(
            text(
                f"""
                SELECT
                    cwm.collection_id,
                    cwm.collection_name,
                    cwm.workspace_id,
                    cwm.workspace_name,
                    cwm.description,
                    cwm.updated_at,
                    COUNT(d.id) as document_count
                FROM collection_workspace_map cwm
                LEFT JOIN documents d ON d.collection_id = cwm.collection_id
                WHERE cwm.workspace_id = :workspace_id{owner_clause}
                GROUP BY cwm.collection_id, cwm.workspace_id, cwm.owner_user_id,
                         cwm.collection_name, cwm.workspace_name, cwm.description, cwm.updated_at
                HAVING COUNT(d.id) > 0
                ORDER BY document_count DESC
                """
            ),
            {"user_id": user_id, "workspace_id": workspace_id},
        ).fetchall()

        collections = [
            {
                "id": str(row.collection_id),
                "name": getattr(row, "collection_name", None),
                "description": getattr(row, "description", None),
                "workspace_id": str(row.workspace_id),
                "document_count": getattr(row, "document_count", 0),
            }
            for row in result
        ]
        logger.info("Found %d accessible collections for user %s in workspace %s", len(collections), user_id, workspace_id)
        with _accessible_cache_lock:
            _accessible_cache[cache_key] = (now, collections)
        return collections

    except Exception as e:
        logger.error("Error getting accessible collections for user %s: %s", user_id, e)
        return []


def validate_workspace_access(db: Session, user_id: str, workspace_id: str) -> str:
    """Validate workspace existence + ownership, returning the user's role.

    Raises:
        HTTPException 404: workspace not found in cache
        HTTPException 403: user has no access
    """
    workspace = db.execute(
        text("SELECT 1 FROM collection_workspace_map WHERE workspace_id = :id LIMIT 1"),
        {"id": workspace_id},
    ).fetchone()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    role = check_user_workspace_role(db, user_id, workspace_id)
    if not role:
        raise HTTPException(status_code=403, detail="You do not have access to this workspace")
    return role
