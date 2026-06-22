"""Workspace-membership lookup from the Redis snapshot published by the Kotlin backend.

Workspace membership (who a workspace is shared with) is owned by the Kotlin
backend in ``workspace_users``. The backend mirrors the full set into a Redis
snapshot key — ``scrapalot:sync:workspace_members_snapshot`` on Redis DB 1,
refreshed on boot and after every share / unshare — exactly like the
``collection_workspace_map`` snapshot. We read that snapshot here so the Python
service stays decoupled from the backend database schema (no cross-service DB
read).

Used by ``get_user_accessible_collections`` to widen collection access to
shared workspaces. A short in-process cache avoids hitting Redis on every chat
turn; any read failure keeps the last good value (or an empty set on cold
start), degrading to owner-only access rather than erroring.
"""

from __future__ import annotations

import json
import os
import time

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_SNAPSHOT_KEY = "scrapalot:sync:workspace_members_snapshot"
_CACHE_TTL_SECONDS = 30.0

# Module-level cache: { user_id -> set(workspace_id) }, refreshed every TTL.
_cache_by_user: dict[str, set[str]] = {}
_cache_ts: float = 0.0


def _load_snapshot() -> dict[str, set[str]]:
    """Read + parse the membership snapshot from Kotlin's Redis (DB 1)."""
    import redis as redis_lib

    redis_host = os.getenv("REDIS_HOST", "redis")
    redis_port = int(os.getenv("REDIS_PORT", "6379"))
    redis_password = os.getenv("REDIS_PASSWORD", "")
    client = redis_lib.Redis(
        host=redis_host,
        port=redis_port,
        password=redis_password,
        db=1,
        decode_responses=True,
        socket_timeout=5,
    )
    try:
        raw = client.get(_SNAPSHOT_KEY)
    finally:
        client.close()

    by_user: dict[str, set[str]] = {}
    if not raw:
        return by_user
    for row in json.loads(raw):
        uid = str(row.get("user_id") or "")
        wid = str(row.get("workspace_id") or "")
        if uid and wid:
            by_user.setdefault(uid, set()).add(wid)
    return by_user


def get_member_workspace_ids(user_id: str) -> set[str]:
    """Return the set of workspace ids the user is a member of (owner or shared).

    Reads the backend-published Redis snapshot, cached for a few seconds.
    Returns an empty set if the snapshot is missing or unreadable, so callers
    transparently fall back to owner-only collection access.
    """
    global _cache_by_user, _cache_ts
    now = time.monotonic()
    if now - _cache_ts > _CACHE_TTL_SECONDS:
        try:
            _cache_by_user = _load_snapshot()
            _cache_ts = now
        except Exception as e:  # pragma: no cover - degrade gracefully, keep stale cache
            logger.warning("Workspace member snapshot read failed (using cached/empty): %s", e)
            _cache_ts = now
    return set(_cache_by_user.get(str(user_id), set()))
