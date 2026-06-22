"""Beat-scheduler liveness signal for the supervisord beat watchdog.

The watchdog (`scripts/supervisord_watchdog_beat.py`) polls a Redis key
that this task writes. The dual-writer design (dispatched BY beat,
executed BY a worker) catches BOTH failure modes that supervisord's
own `autorestart=true` cannot:

  - **Beat process up but scheduler frozen** (Python deadlock, asyncio
    wedge, event loop starvation). The process is alive, supervisord
    sees nothing wrong, but no task ever ticks — including this one.
    The Redis key TTL expires, the watchdog restarts the program.

  - **Beat dispatching but no worker consuming** (workers all hung on
    a long task, fast-queue starvation, broker disconnect). The task
    queues but never executes, the key never refreshes, same outcome.

See `README_BACKGROUND_JOBS.md` "Phase numbering" table for context
and the `scripts/supervisord_watchdog_beat.py` docstring for the
two-gate restart trigger.
"""

from __future__ import annotations

import time

from celery.exceptions import SoftTimeLimitExceeded

from src.main.utils.core.logger import get_logger
from src.main.workers.celery_app import celery_app

logger = get_logger(__name__)

# Redis key written by the task body, polled by the watchdog. The TTL is
# 10 min: longer than the worst-case watchdog miss window (5 misses ×
# 60 s = 5 min), short enough that a true outage surfaces quickly.
BEAT_HEARTBEAT_KEY = "scrapalot:celery:beat:heartbeat"
BEAT_HEARTBEAT_TTL_SECONDS = 600


@celery_app.task(
    name="scrapalot.celery_beat_heartbeat",
    bind=True,
    max_retries=0,
    soft_time_limit=10,
    time_limit=15,
    # `expires=60` — if this task sits in the queue longer than the beat
    # cadence, drop it rather than execute stale. The next beat tick
    # re-dispatches; we'd rather miss a heartbeat than write a stale
    # one that suppresses an in-progress alert.
    expires=60,
    # `acks_late=False` because the task is idempotent + cheap; redelivery
    # on worker loss is undesired (would write an inaccurate timestamp).
    acks_late=False,
    queue="fast",
)
def celery_beat_heartbeat_task(self) -> dict:
    """Write current epoch timestamp to BEAT_HEARTBEAT_KEY with TTL.

    Returns the timestamp written on success, or an `{"error": ...}` dict
    on failure (Redis unreachable, etc.). Never raises — exceptions are
    captured so the task itself is never the cause of an alert.
    """
    try:
        from src.main.utils.redis.client import get_redis_client

        redis = get_redis_client()
        timestamp = time.time()
        redis.setex(BEAT_HEARTBEAT_KEY, BEAT_HEARTBEAT_TTL_SECONDS, str(timestamp))
        logger.debug("beat heartbeat written: ts=%s ttl=%ds", timestamp, BEAT_HEARTBEAT_TTL_SECONDS)
        return {"ts": timestamp}
    except SoftTimeLimitExceeded:
        logger.warning("beat heartbeat soft time limit exceeded — Redis stuck?")
        raise
    except Exception as exc:
        # Don't let the task itself fail noisily — the watchdog reads
        # the absence of a fresh key, which is the same signal whether
        # the cause is task failure or genuine scheduler death.
        logger.exception("beat heartbeat write failed: %s", exc)
        return {"error": str(exc)[:200]}


# Shared-volume temp dir for memory-only uploads (NamedTemporaryFile lands
# here as ``scrapalot_<docid>_..._<name>``). Keep in sync with the upload
# handler in grpc/services/document_extras_service.py.
RECOVERY_TMP_DIR = "/app/data/tmp"
# Skip files younger than this — protects in-flight uploads that haven't yet
# reached a terminal state (and so haven't recorded recovery_tmp_path).
RECOVERY_TMP_MIN_AGE_HOURS = 24


@celery_app.task(
    name="scrapalot.maintenance.gc_orphan_tmpfiles",
    bind=True,
    max_retries=0,
    soft_time_limit=120,
    time_limit=180,
    expires=3600,
    acks_late=False,
    queue="fast",
)
def gc_orphan_tmpfiles_task(self, min_age_hours: int = RECOVERY_TMP_MIN_AGE_HOURS) -> dict:
    """Sweep ORPHANED memory-only upload tmpfiles from ``/app/data/tmp``.

    A memory-only upload (``file_stored=false``) keeps its only copy of the
    bytes here. On a completed upload the worker deletes the tmpfile; on a
    terminal failure OR an OCR-deferred scanned PDF it is KEPT so a later
    reprocess can recover the bytes (the path is recorded in
    ``documents.file_metadata.recovery_tmp_path``; the reprocess gate prefers
    it when the logical file is absent).

    This sweep is DB-aware: a tmpfile is deleted only if it is older than
    ``min_age_hours`` AND no live document (``deleted_at IS NULL`` and not yet
    ``completed``) still references it via ``recovery_tmp_path``. So bytes a
    recoverable doc still needs are kept for the lifetime of that doc, while
    true orphans — temps of deleted/completed docs, stale pointers, or leaked
    files from interrupted uploads — are reclaimed. The age floor protects
    in-flight uploads whose terminal state (and recovery pointer) hasn't
    landed yet.
    """
    import os
    import time as _t

    cutoff = _t.time() - max(1, min_age_hours) * 3600
    removed = 0
    freed = 0
    try:
        if not os.path.isdir(RECOVERY_TMP_DIR):
            return {"removed": 0, "freed_bytes": 0}

        # Paths still referenced by a recoverable (non-deleted, non-completed)
        # document — keep these regardless of age.
        referenced: set[str] = set()
        try:
            from sqlalchemy import text as _t_sql

            from src.main.config.database import SessionLocal as _SL

            _db = _SL()
            try:
                rows = _db.execute(
                    _t_sql(
                        "SELECT file_metadata->>'recovery_tmp_path' AS p FROM documents "
                        "WHERE deleted_at IS NULL AND processing_status <> 'completed' "
                        "AND file_metadata->>'recovery_tmp_path' IS NOT NULL"
                    )
                ).fetchall()
                referenced = {r[0] for r in rows if r[0]}
            finally:
                _db.close()
        except Exception as e:
            # Fail safe: if we can't read references, do NOT delete anything —
            # better to leak a little disk than drop recoverable bytes.
            logger.warning("gc_orphan_tmpfiles: could not load referenced tmpfiles, skipping sweep: %s", e)
            return {"removed": 0, "freed_bytes": 0, "skipped": "no_reference_set"}

        for name in os.listdir(RECOVERY_TMP_DIR):
            if not name.startswith("scrapalot_"):
                continue
            path = os.path.join(RECOVERY_TMP_DIR, name)
            if path in referenced:
                continue
            try:
                st = os.stat(path)
                if not os.path.isfile(path) or st.st_mtime >= cutoff:
                    continue
                size = st.st_size
                os.remove(path)
                removed += 1
                freed += size
            except FileNotFoundError:
                continue
            except Exception as e:
                logger.warning("gc_orphan_tmpfiles: failed to remove %s: %s", path, e)
        if removed:
            logger.info(
                "gc_orphan_tmpfiles: removed %d orphan tmpfile(s), freed %.1f MB (min_age=%dh, %d referenced kept)",
                removed,
                freed / 1024 / 1024,
                min_age_hours,
                len(referenced),
            )
        return {"removed": removed, "freed_bytes": freed, "referenced_kept": len(referenced)}
    except SoftTimeLimitExceeded:
        logger.warning("gc_orphan_tmpfiles: soft time limit exceeded")
        raise
    except Exception as exc:
        logger.exception("gc_orphan_tmpfiles failed: %s", exc)
        return {"error": str(exc)[:200]}
