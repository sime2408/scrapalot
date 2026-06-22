"""Cross-process registry of active background jobs.

UI visibility for graph rebuild tasks (``extract_entities``,
``sync_document_hierarchy_to_neo4j``).

Why a separate registry: ``JobService.processing_status`` is an in-memory
dict on the scrapalot-chat process. Background tasks run in
scrapalot-workers (separate container) and can't write to that dict.
They also don't flip ``documents.processing_status`` because the doc is
already ``completed`` — only its graph layer is being rebuilt. So the
existing two read sources of ``get_active_jobs`` (in-memory + docs DB)
return empty for background work, and the UI's ``/jobs/active`` endpoint
returns ``{}`` even when entity extraction has been running for 8
minutes.

This registry bridges the gap: workers ``register_bg_job`` on start and
``unregister_bg_job`` on terminal state. ``get_active_jobs`` merges the
hash into its response so the UI sees ALL active work, not just upload
or reprocess.

Storage layout: ``HSET scrapalot:active_bg_jobs:{user_id} {job_id} JSON``
with the hash itself TTL'd at 4 h (matches the dispatch_guard TTL)
as a safety net against orphan entries when a worker dies before
``unregister``.

Key namespace is ``scrapalot:active_bg_jobs:`` — distinct from
``scrapalot:lock:doc:`` (doc lock) and ``scrapalot:dispatch_guard:``
(the NX dispatch guard) so the three concerns don't collide.
"""

from __future__ import annotations

import json
import time

from src.main.utils.core.logger import get_logger
from src.main.utils.redis.client import get_redis_client

logger = get_logger(__name__)

_HASH_PREFIX = "scrapalot:active_bg_jobs:"
_HASH_TTL_SECONDS = 4 * 3600


def _key(user_id: str) -> str:
    return f"{_HASH_PREFIX}{user_id}"


def register_bg_job(user_id: str, job_id: str, payload: dict) -> None:
    """Add a background job entry to the per-user Redis hash.

    ``payload`` should include at minimum: ``document_id``, ``collection_id``,
    ``task_name``, ``status``, ``progress``, ``message``. ``filename`` and
    ``collection_name`` are optional but improve UI rendering.

    A missing ``started_at`` is auto-filled with the current epoch second so
    the UI can show "running for Xs". The hash's TTL is bumped on every
    register call to keep the entry alive while work continues.
    """
    if not user_id or not job_id:
        return
    try:
        redis = get_redis_client()
        data = dict(payload or {})
        data.setdefault("started_at", time.time())
        data.setdefault("job_id", job_id)
        redis.hset(_key(user_id), job_id, json.dumps(data, default=str))
        redis.expire(_key(user_id), _HASH_TTL_SECONDS)
    except Exception:
        logger.exception("active_bg_jobs: register failed user=%s job=%s", user_id, job_id)


def update_bg_job_progress(user_id: str, job_id: str, progress: float, message: str) -> None:
    """Update progress + message on an existing entry without disturbing other fields."""
    if not user_id or not job_id:
        return
    try:
        redis = get_redis_client()
        raw = redis.hget(_key(user_id), job_id)
        if raw is None:
            return
        val = raw.decode() if isinstance(raw, bytes) else raw
        data = json.loads(val)
        data["progress"] = float(progress)
        data["message"] = str(message)
        redis.hset(_key(user_id), job_id, json.dumps(data, default=str))
        redis.expire(_key(user_id), _HASH_TTL_SECONDS)
    except Exception:
        logger.exception("active_bg_jobs: progress-update failed user=%s job=%s", user_id, job_id)


def unregister_bg_job(user_id: str, job_id: str) -> None:
    """Remove an entry on terminal state (success/failure/cancel)."""
    if not user_id or not job_id:
        return
    try:
        redis = get_redis_client()
        redis.hdel(_key(user_id), job_id)
    except Exception:
        logger.exception("active_bg_jobs: unregister failed user=%s job=%s", user_id, job_id)


def get_bg_job(user_id: str, job_id: str) -> dict | None:
    """Return a single registered background job, or None if absent.

    The hash is keyed by user_id, so a hit inherently belongs to the caller —
    ownership is implicit, no extra access check needed. Fail-open (None) on a
    Redis error so the host endpoint falls through to its existing 404 path.
    """
    if not user_id or not job_id:
        return None
    try:
        redis = get_redis_client()
        raw = redis.hget(_key(user_id), job_id)
        if raw is None:
            return None
        val = raw.decode() if isinstance(raw, bytes) else raw
        return json.loads(val)
    except Exception:
        logger.exception("active_bg_jobs: get_bg_job failed user=%s job=%s", user_id, job_id)
        return None


def get_active_bg_jobs(user_id: str) -> dict[str, dict]:
    """Return all background jobs registered for a user.

    Keys are job IDs, values are the registered payload dicts. Empty dict
    if no entries (or Redis unreachable — fail-open so the host endpoint
    still returns the in-memory + DB results).
    """
    if not user_id:
        return {}
    try:
        redis = get_redis_client()
        raw = redis.hgetall(_key(user_id))
        result: dict[str, dict] = {}
        for k, v in (raw or {}).items():
            job_id = k.decode() if isinstance(k, bytes) else k
            val = v.decode() if isinstance(v, bytes) else v
            try:
                result[job_id] = json.loads(val)
            except Exception:
                continue
        return result
    except Exception:
        logger.exception("active_bg_jobs: get failed user=%s", user_id)
        return {}
