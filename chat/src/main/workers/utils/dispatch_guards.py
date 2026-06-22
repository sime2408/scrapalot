"""Triple-defense dispatch guards for Celery task enqueue paths.

Adapted from onyx-dot-app/onyx ``user_file_processing/tasks.py:197-303``
``check_user_file_processing`` triple-defense pattern.

Even with heartbeat liveness (no more false-positive stuck
detections from ``documents.updated_at``) there's still a race window
between (a) JobRecovery dispatching a fresh reprocess + (b) the
spawned worker actually receiving it and acquiring the doc lock.
During that window, a second beat cycle could observe "no active
Celery task for this doc_id" via ``inspect()`` (the task is reserved
but not yet active) and dispatch a duplicate.

The three defenses:

  1. **Queue-depth backpressure** — if broker queue length exceeds a
     threshold, skip the whole dispatch cycle. Workers are clearly
     behind; adding more tasks would only deepen the backlog.

  2. **Per-doc Redis NX guard with TTL** — before enqueuing, atomic
     ``SET key NX EX ttl``. If the key already exists, a previous
     dispatch is in flight or queued; skip this enqueue. The worker
     calls ``release_dispatch_guard`` as its first line so the next
     beat cycle can re-enqueue once the previous task is actually
     picked up.

  3. **Task self-expiry** — every enqueued task carries an ``expires=``
     timestamp; the broker discards the message if it has been sitting
     in the queue longer than ``expires``. Belt-and-suspenders — even
     if Redis flushes and we lose the NX guard, stale tasks evict
     themselves rather than piling up forever.

Together these eliminate the Pattern A double-dispatch tail that the
fc0de69 / heartbeat fixes left in the corner-case window.
"""

from __future__ import annotations

from src.main.utils.core.logger import get_logger
from src.main.utils.redis.client import get_redis_client

logger = get_logger(__name__)

# ----------------------------------------------------------------------------
# Tunables. Env-overridable so production can adjust without a redeploy.
# ----------------------------------------------------------------------------

# Stop new dispatches onto the documents queue if more than this many tasks
# are already queued. Each reprocess is 1-30 min; queue depth 50 = ~12 h of
# worst-case work pending. Higher than that = beat dispatching faster than
# workers can consume → backlog grows unbounded.
MAX_QUEUE_DEPTH_DOCUMENTS = 50

# Fast queue is much higher throughput (Annas restore ~5-30 s, summary
# backfill ~10-60 s) and has 4 concurrent threads. 200 = ~25-50
# min of worst-case work.
MAX_QUEUE_DEPTH_FAST = 200

# How long a dispatch guard / queued task remains valid before the broker
# discards it. Matches the documents queue's longest-task envelope (3 h
# reprocess soft_time_limit + a buffer).
TASK_EXPIRES_SECONDS = 4 * 3600  # 4 h


# ----------------------------------------------------------------------------
# Queue-depth check (Defense 1)
# ----------------------------------------------------------------------------


def get_queue_length(queue_name: str) -> int:
    """Read broker queue length directly from Redis.

    Celery's Redis broker stores per-queue messages in a LIST keyed by the
    queue name. LLEN is O(1) and doesn't dequeue.
    """
    try:
        from src.main.workers.celery_app import celery_app

        with celery_app.broker_connection() as conn:
            channel = conn.default_channel
            return channel.client.llen(queue_name)
    except Exception:
        logger.exception("dispatch_guards: get_queue_length failed for %s", queue_name)
        return 0


def queue_under_threshold(queue_name: str, threshold: int) -> bool:
    """True if the queue has room for another dispatch."""
    qlen = get_queue_length(queue_name)
    if qlen > threshold:
        logger.warning(
            "dispatch_guards: queue=%s depth=%d > threshold=%d — skip dispatch",
            queue_name,
            qlen,
            threshold,
        )
        return False
    return True


# ----------------------------------------------------------------------------
# Per-doc NX guard (Defense 2)
# ----------------------------------------------------------------------------


def _guard_key(doc_id: str, action: str) -> str:
    """Redis key naming convention. Separate namespace from doc_lock so
    the lock + dispatch guard can coexist (lock = "doc is being worked
    on right now"; guard = "a dispatch for this doc is in flight in
    the broker queue but not yet picked up")."""
    return f"scrapalot:dispatch_guard:{action}:{doc_id}"


def try_acquire_dispatch_guard(doc_id: str, action: str, ttl_seconds: int = TASK_EXPIRES_SECONDS) -> bool:
    """Atomic SET key NX EX ttl. Returns True if we acquired (free to
    dispatch), False if a previous dispatch's guard is still active.

    The worker MUST call ``release_dispatch_guard`` as the first line of
    its body so the next beat cycle can re-enqueue if the work hasn't
    completed by next tick. Without that release, a fresh dispatch is
    locked out for ``ttl_seconds`` even when the previous task is
    already actively processing.
    """
    try:
        redis = get_redis_client()
        return bool(redis.set(_guard_key(doc_id, action), 1, nx=True, ex=ttl_seconds))
    except Exception:
        logger.exception(
            "dispatch_guards: try_acquire failed doc=%s action=%s — assuming free",
            doc_id,
            action,
        )
        # Fail open: better to risk a duplicate dispatch than to freeze
        # dispatch entirely when Redis is briefly unreachable. The worker's
        # `_acquire_doc_lock` (separate Redis key) is the last-line defense
        # against duplicate concurrent execution.
        return True


def release_dispatch_guard(doc_id: str, action: str) -> None:
    """Called as the FIRST LINE of the worker task body.

    Deleting the guard signals "I picked this task up; the next beat
    cycle is welcome to re-enqueue if my work doesn't finish before
    you check". Failure to release means the guard sits for
    ``ttl_seconds`` even though the task is actively running — wastes
    one beat cycle of potential re-dispatch on stuck recovery.
    """
    try:
        redis = get_redis_client()
        redis.delete(_guard_key(doc_id, action))
    except Exception:
        logger.exception(
            "dispatch_guards: release failed doc=%s action=%s — TTL will expire it",
            doc_id,
            action,
        )


# ----------------------------------------------------------------------------
# Combined safe-send helper (all 3 defenses)
# ----------------------------------------------------------------------------


def safe_send_task(
    task_name: str,
    *,
    queue: str,
    doc_id: str,
    action: str,
    kwargs: dict,
    expires: int = TASK_EXPIRES_SECONDS,
    queue_threshold: int | None = None,
) -> str | None:
    """Combines queue-depth check + NX guard + send_task with expires.

    Returns the Celery task ID on successful dispatch, or None if any
    defense gate refused. Rolls back the NX guard if ``send_task``
    itself raises so a transient broker failure doesn't permanently
    block the next dispatch.

    Use this from JobRecovery + any other auto-recovery dispatch site.
    Direct user-initiated dispatches (e.g. admin "Reprocess" button)
    should bypass this — those are explicitly authorised by a human and
    should NOT be debounced by the NX guard.
    """
    if queue_threshold is None:
        queue_threshold = MAX_QUEUE_DEPTH_DOCUMENTS if queue == "documents" else MAX_QUEUE_DEPTH_FAST

    # Defense 1: queue-depth backpressure
    if not queue_under_threshold(queue, queue_threshold):
        return None

    # Defense 2: per-doc NX guard
    if not try_acquire_dispatch_guard(doc_id, action, ttl_seconds=expires):
        logger.debug(
            "dispatch_guards: guard held — skip dispatch doc=%s action=%s task=%s",
            doc_id[:8] if len(doc_id) > 8 else doc_id,
            action,
            task_name,
        )
        return None

    # Defense 3: enqueue with self-expiry
    try:
        from src.main.workers.celery_app import celery_app

        result = celery_app.send_task(task_name, kwargs=kwargs, queue=queue, expires=expires)
        return result.id
    except Exception:
        # Roll back the guard so the next beat cycle can retry
        logger.exception(
            "dispatch_guards: send_task failed doc=%s action=%s — rolling back guard",
            doc_id[:8] if len(doc_id) > 8 else doc_id,
            action,
        )
        release_dispatch_guard(doc_id, action)
        raise
