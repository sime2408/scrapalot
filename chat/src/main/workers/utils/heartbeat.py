"""Heartbeat counter for long-running Celery tasks.

Adapted from onyx-dot-app/onyx ``docprocessing/heartbeat.py``.

The running task starts a daemon thread that bumps ``jobs.heartbeat_counter``
every ``HEARTBEAT_INTERVAL_SECONDS`` while the task body executes. The
JobRecoveryService beat task reads ``(counter, last_heartbeat_value,
last_heartbeat_time)`` to decide whether a task is alive (counter
advanced since last snapshot), still active (counter idle but within
cutoff), or stuck (counter idle past cutoff → recovery candidate).

This replaces the pre-Phase-2 ``documents.updated_at`` liveness signal
which was a noisy proxy (it advanced for many reasons unrelated to task
progress — status transitions, manual edits, ACL updates) and was the
race-prone source of the JobRecovery Pattern A double-dispatch bug
fixed in commit ``fc0de69``.

Usage::

    job_id = f"reprocess-{document_id}"
    heartbeat_thread, stop_event = start_heartbeat(job_id)
    try:
        # ... long-running task body ...
    finally:
        stop_heartbeat(heartbeat_thread, stop_event)

The heartbeat thread runs in the Celery thread (watchdog), NOT the
spawned subprocess. If the Celery thread dies (rare with --pool=threads),
the heartbeat dies with it. If the spawned subprocess dies (common
under OOM), the watchdog notices via ``job.done()`` and exits the
Celery thread cleanly — heartbeat stops then too. Both failure modes
converge on "counter stops advancing" which the beat task picks up.
"""

from __future__ import annotations

import contextvars
import threading

from sqlalchemy import text

from src.main.config.database import SessionLocal
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Bump cadence — short enough that JobRecovery (default cutoff 30 min)
# sees plenty of ticks before declaring stuck, light enough that 2
# concurrent tasks only add ~4 UPDATEs/min to the jobs table.
HEARTBEAT_INTERVAL_SECONDS = 30


def start_heartbeat(job_id: str) -> tuple[threading.Thread, threading.Event]:
    """Spawn a daemon thread that bumps ``jobs.heartbeat_counter`` periodically.

    Returns ``(thread, stop_event)`` — caller must invoke ``stop_heartbeat``
    in its ``finally`` block to terminate the loop cleanly.

    The loop wraps each DB write in try/except so a transient PG failure
    doesn't crash the watchdog thread. False-negative liveness (heartbeat
    skipped a tick due to DB error) is preferred over watchdog death —
    the snapshot pattern in JobRecovery tolerates occasional skipped
    ticks within the cutoff window.
    """
    stop_event = threading.Event()

    def heartbeat_loop() -> None:
        while not stop_event.wait(HEARTBEAT_INTERVAL_SECONDS):
            try:
                with SessionLocal() as db:
                    db.execute(
                        text("UPDATE jobs SET heartbeat_counter = heartbeat_counter + 1 WHERE job_id = :jid"),
                        {"jid": job_id},
                    )
                    db.commit()
            except Exception:
                logger.exception("heartbeat: failed update for job %s", job_id)

    # Preserve outer context (tenant id, request id, etc.) inside the
    # daemon thread so logger / SessionLocal access behaves the same.
    context = contextvars.copy_context()
    thread = threading.Thread(target=context.run, args=(heartbeat_loop,), daemon=True)
    thread.start()
    logger.debug("heartbeat: started for job %s (interval=%ds)", job_id, HEARTBEAT_INTERVAL_SECONDS)
    return thread, stop_event


def stop_heartbeat(thread: threading.Thread, stop_event: threading.Event) -> None:
    """Signal the heartbeat thread to stop and wait briefly for clean shutdown."""
    stop_event.set()
    thread.join(timeout=5)
