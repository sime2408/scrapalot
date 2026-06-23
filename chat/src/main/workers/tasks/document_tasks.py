"""
Celery task for document processing.

Thin wrapper around the synchronous process_uploaded_document() function.
The heavy lifting (OCR, chunking, embedding, graph) happens inside that function
which manages its own DB session — safe to run in a separate worker process.
"""

from datetime import UTC
import re

from celery.exceptions import SoftTimeLimitExceeded

from src.main.utils.core.logger import get_logger
from src.main.workers.celery_app import celery_app

logger = get_logger(__name__)

# Redis key prefix for per-user concurrency tracking (must match documents.py)
_USER_TASK_KEY_PREFIX = "scrapalot:worker:user_tasks:"

# Redis key prefix for per-document processing lock (prevents duplicate processing)
_DOC_LOCK_PREFIX = "scrapalot:lock:doc:"
_DOC_LOCK_TTL = 7200  # 2 hours — long enough for large PDFs

# Redis key prefix for per-collection batch lock (prevents duplicate batch processing)
_BATCH_LOCK_PREFIX = "scrapalot:lock:batch:"
_BATCH_LOCK_TTL = 3600  # 1 hour

# Global Docling OCR lock — only 1 document can run Docling at a time.
# Two concurrent Docling instances (each ~3GB on CPU) exceed the 6GB worker container limit.
_DOCLING_LOCK_KEY = "scrapalot:lock:docling"
_DOCLING_LOCK_TTL = 7200  # 2 hours — large scanned PDFs can take 1-2h
_DOCLING_LOCK_POLL_INTERVAL = 10  # seconds between lock acquisition attempts


def _acquire_doc_lock(document_id: str, task_id: str | None = None) -> bool:
    """Acquire a Redis lock for a document.

    Returns True if the lock was acquired (or forcibly reclaimed from a dead
    holder), False if a live task is still holding it.

    The lock value stores the current Celery task ID so that a later retry
    attempt can detect a stale lock and reclaim it. Without this, a SIGKILL
    (OOM, Docker stop, billiard crash) leaves the finally-block of the crashed
    task unexecuted, `_release_doc_lock` is never called, and the lock sits
    until its 2 h TTL expires — blocking every subsequent retry for the same
    document for up to two hours.

    Contention path (new): when the atomic `SET NX` fails, query Celery's
    `inspect()` for active and reserved task IDs. If the current lock holder's
    task ID is not among them, the holder crashed — reclaim the lock. The
    inspect() RPC only runs on contention, so happy-path acquires are
    unchanged.
    """
    try:
        from src.main.utils.redis.client import get_redis_client

        redis = get_redis_client()
        key = f"{_DOC_LOCK_PREFIX}{document_id}"
        lock_value = task_id or "legacy"

        # Happy path — first attempt wins atomically.
        acquired = redis.set(key, lock_value, nx=True, ex=_DOC_LOCK_TTL)
        if acquired:
            return True

        # Contention path — someone else holds the lock. Without a task_id we
        # cannot safely reclaim, so fall back to the old conservative refusal.
        if not task_id:
            return False

        raw_holder = redis.get(key)
        if raw_holder is None:
            # Raced with expiry between set-nx and get — retry once.
            return bool(redis.set(key, lock_value, nx=True, ex=_DOC_LOCK_TTL))

        current_holder = raw_holder.decode() if isinstance(raw_holder, bytes) else raw_holder
        if current_holder == lock_value:
            # Own lock from a previous attempt of this same task (shouldn't
            # happen under normal flow, but treat as acquired).
            return True
        if current_holder == "legacy":
            # Pre-fix lock with no task ID — cannot verify, refuse to reclaim.
            return False

        # Ask Celery whether the holder task is still alive.
        try:
            from src.main.workers.celery_app import celery_app

            insp = celery_app.control.inspect(timeout=2)
            active = insp.active() or {}
            reserved = insp.reserved() or {}
            alive_task_ids: set[str] = set()
            for tasks in active.values():
                for t in tasks or []:
                    tid = t.get("id") if isinstance(t, dict) else None
                    if tid:
                        alive_task_ids.add(str(tid))
                    # Extra hint: the task's own id may also expose the locked document
            for tasks in reserved.values():
                for t in tasks or []:
                    tid = t.get("id") if isinstance(t, dict) else None
                    if tid:
                        alive_task_ids.add(str(tid))

            if current_holder in alive_task_ids:
                # Legitimate live lock — refuse.
                return False

            # Holder is not in active or reserved — crashed or evicted. Reclaim.
            logger.warning(
                "Reclaiming stale doc lock for %s (previous holder task %s no longer in celery active/reserved)",
                document_id,
                current_holder,
            )
            redis.set(key, lock_value, ex=_DOC_LOCK_TTL)
            return True
        except Exception as inspect_err:
            # If we can't verify, stay conservative and refuse. The original
            # behavior of this function on contention was "refuse", so we are
            # strictly no worse than before.
            logger.warning(
                "Stale-lock check failed for %s (%s); refusing to reclaim",
                document_id,
                inspect_err,
            )
            return False
    except Exception as e:
        logger.warning("Failed to acquire doc lock for %s: %s", document_id, e)
        return True  # fail open — allow processing if Redis is down


def _release_doc_lock(document_id: str) -> None:
    """Release the Redis lock for a document.

    Note: This only runs when the task reaches its finally-block. If the
    worker child is SIGKILLed (OOM, billiard crash, docker stop without a
    grace period), this is never called. The stale-lock reclaim logic in
    `_acquire_doc_lock` is what recovers from that case.
    """
    try:
        from src.main.utils.redis.client import get_redis_client

        redis = get_redis_client()
        redis.delete(f"{_DOC_LOCK_PREFIX}{document_id}")
    except Exception as e:
        logger.warning("Failed to release doc lock for %s: %s", document_id, e)


def _acquire_docling_lock(document_id: str, timeout: int = 3600) -> bool:
    """
    Block until the global Docling lock is acquired.

    Only one worker may run Docling OCR at a time (each instance uses ~3 GB on CPU;
    two concurrent instances exceed the 6 GB container memory limit).

    Returns True if the lock was acquired, False if timed out.
    """
    import time

    from src.main.utils.redis.client import get_redis_client

    redis = get_redis_client()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        acquired = redis.set(_DOCLING_LOCK_KEY, document_id, nx=True, ex=_DOCLING_LOCK_TTL)
        if acquired:
            logger.info("Acquired Docling lock for document %s", document_id)
            return True
        logger.debug("Docling lock held, waiting %ds (doc=%s)", _DOCLING_LOCK_POLL_INTERVAL, document_id)
        time.sleep(_DOCLING_LOCK_POLL_INTERVAL)
    logger.warning("Timed out waiting for Docling lock (doc=%s)", document_id)
    return False


def _release_docling_lock(document_id: str) -> None:
    """Release the global Docling lock, but only if this document holds it."""
    try:
        from src.main.utils.redis.client import get_redis_client

        redis = get_redis_client()
        current = redis.get(_DOCLING_LOCK_KEY)
        # noinspection PyUnresolvedReferences
        if current and current.decode() == document_id:
            redis.delete(_DOCLING_LOCK_KEY)
            logger.info("Released Docling lock for document %s", document_id)
    except Exception as e:
        logger.warning("Failed to release Docling lock for %s: %s", document_id, e)


def _retain_recovery_tmpfile(document_id: str, tmp_path: str) -> None:
    """Record a retained memory-only tmpfile path in ``documents.file_metadata``.

    A memory-only doc (``file_stored=false``) keeps its only copy of the bytes
    as the shared-volume tmpfile. On terminal upload FAILURE we KEEP that file
    (instead of deleting it) so a later reprocess can recover the bytes — the
    reprocess gate reads ``recovery_tmp_path`` from file_metadata when the
    logical file_path isn't on disk. Best-effort: a failure here only costs the
    recovery affordance, not correctness. The nightly tmp GC bounds the disk.
    """
    try:
        from sqlalchemy import text as _t

        from src.main.config.database import SessionLocal as _SL

        _db = _SL()
        try:
            _db.execute(
                _t(
                    "UPDATE documents "
                    "SET file_metadata = COALESCE(file_metadata, '{}'::jsonb) "
                    "    || jsonb_build_object('recovery_tmp_path', CAST(:p AS text)) "
                    "WHERE id = :did"
                ),
                {"p": tmp_path, "did": document_id},
            )
            _db.commit()
            logger.info("Retained recovery tmpfile for failed memory-only doc %s: %s", document_id[:8], tmp_path)
        finally:
            _db.close()
    except Exception as e:
        logger.warning("Failed to record recovery tmpfile for doc %s: %s", document_id[:8], e)


def _doc_is_completed(document_id: str) -> bool:
    """True iff the doc reached ``processing_status='completed'``.

    A memory-only tmpfile is only safe to drop once the doc is genuinely done
    (content persisted). A clean subprocess exit is NOT sufficient: an
    OCR-deferred scanned PDF returns cleanly but lands in
    ``processing_status='failed'`` with ``processing_error='errorScannedPdfOcrDeferred'``
    and empty content — its bytes must be retained so a later reprocess with
    OCR enabled can run. Returns False (→ retain) on any read error, biasing
    toward keeping the bytes.
    """
    try:
        from sqlalchemy import text as _t

        from src.main.config.database import SessionLocal as _SL

        _db = _SL()
        try:
            row = _db.execute(
                _t("SELECT processing_status FROM documents WHERE id = :did"),
                {"did": document_id},
            ).fetchone()
            return bool(row) and row[0] == "completed"
        finally:
            _db.close()
    except Exception as e:
        logger.warning("Could not read processing_status for doc %s: %s", document_id[:8], e)
        return False


@celery_app.task(
    name="scrapalot.process_document",
    bind=True,
    max_retries=2,
    default_retry_delay=30,
    # This task is now a
    # thin watchdog over a spawn subprocess. Heavy imports (PyTorch,
    # Docling, LangChain, sentence-transformers) live ONLY inside
    # _process_heavy_body so the Celery thread stays at ~600 MB. Same
    # design as reprocess_document_task above.
    #
    # max_retries=2 preserved (was 1 for reprocess) — initial uploads are
    # SHORT (1-10 min typically) and a transient PyMuPDF parse failure
    # often resolves on retry. We surface subprocess errors as exceptions
    # so self.retry() still works from the Celery thread.
    #
    # acks_late + reject_on_worker_lost stay at the celery_app.py global
    # defaults (True / False). Initial uploads can tolerate
    # broker re-delivery (idempotent — doc_lock catches duplicates).
    soft_time_limit=3600,
    time_limit=4200,
    queue="documents",
)
def process_document_task(
    self,
    job_id: str,
    document_id: str,
    collection_id: str,
    user_id: str,
    file_path: str,
    build_graph: bool = False,
    generate_summary: bool = False,
    cleanup_file_after: bool = False,
) -> dict:
    """Watchdog wrapper. Acquires doc_lock, does the OCR-deferred fast
    skip, then submits `_process_heavy_body` to SubprocessJobClient.

    Subprocess body does: process_uploaded_document(...) + optional
    post-processing (graph build, summary). Watchdog polls every 5s,
    emits memory diagnostics every 60s, enforces RSS cap (3.5 GB),
    and surfaces subprocess outcome back through Celery's retry
    machinery via re-raise on the Celery thread.
    """
    import time

    from src.main.workers.subprocess_job import SubprocessJobClient
    from src.main.workers.utils.heartbeat import start_heartbeat, stop_heartbeat

    logger.info(
        "Celery process_document watchdog start: job=%s document=%s build_graph=%s generate_summary=%s",
        job_id,
        document_id,
        build_graph,
        generate_summary,
    )

    if not _acquire_doc_lock(document_id, task_id=self.request.id):
        logger.warning(
            "Document %s already being processed — skipping duplicate task (job=%s)",
            document_id,
            job_id,
        )
        return {"success": True, "skipped": True, "reason": "duplicate"}

    # Lightweight OCR-deferred fast skip — no heavy imports, stays in
    # Celery thread. Avoids spawning a subprocess just to short-circuit.
    try:
        from sqlalchemy import text as _sa_text

        from src.main.config.database import SessionLocal as _SL

        _db = _SL()
        try:
            _row = _db.execute(
                _sa_text("SELECT processing_status, processing_error FROM documents WHERE id = :did"),
                {"did": document_id},
            ).fetchone()
            _ocr_deferred = False
            if _row:
                _status, _err = _row[0], _row[1] or ""
                if _status in ("failed", "deferred") and (_err == "errorScannedPdfOcrDeferred" or _err.startswith("Scanned PDF")):
                    _ocr_deferred = True
            if _ocr_deferred:
                _release_doc_lock(document_id)
                _decrement_user_counter(user_id)
                logger.info(
                    "Skipping %s — flagged as scanned-PDF needing OCR (status=%s error=%s)",
                    document_id[:8],
                    _row[0],
                    _row[1],
                )
                return {"success": True, "skipped": True, "reason": "scanned_pdf_deferred"}
        finally:
            _db.close()
    except Exception as _precheck_err:
        logger.debug("Pre-check skipped: %s", _precheck_err)

    # Heartbeat — same pattern as reprocess. Job row passed in
    # by caller already exists in the db, so heartbeat UPDATE hits the
    # right row from tick 1.
    heartbeat_thread, heartbeat_stop = start_heartbeat(job_id)

    _is_terminal = False
    _succeeded = False
    try:
        client = SubprocessJobClient(n_workers=1)
        job = client.submit(
            _process_heavy_body,
            job_id,
            document_id,
            collection_id,
            user_id,
            file_path,
            build_graph,
            generate_summary,
        )
        if job is None:
            logger.error("subprocess spawn refused (cap reached) for upload doc=%s", document_id[:8])
            _mark_job_failed(job_id, "errorSubprocessSpawnRefused")
            _is_terminal = True
            return {"success": False, "error": "subprocess_spawn_refused"}

        last_mem_log = 0.0
        loop_start = time.monotonic()
        try:
            import psutil
        except ImportError:
            psutil = None

        # Same defensive RSS cap as reprocess.
        SUBPROCESS_RSS_CAP_MB = 3500

        while not job.done():
            time.sleep(5)
            now = time.monotonic()
            if now - last_mem_log >= 60.0 and psutil is not None and job.process is not None:
                try:
                    p = psutil.Process(job.process.pid)
                    rss_mb = p.memory_info().rss / 1024 / 1024
                    elapsed_s = int(now - loop_start)
                    logger.info(
                        "process_document subprocess job=%s pid=%s rss=%.1fMB elapsed=%ds",
                        job_id,
                        job.process.pid,
                        rss_mb,
                        elapsed_s,
                    )
                    if rss_mb > SUBPROCESS_RSS_CAP_MB:
                        logger.error(
                            "process_document subprocess job=%s rss=%.1fMB > cap=%dMB — killing",
                            job_id,
                            rss_mb,
                            SUBPROCESS_RSS_CAP_MB,
                        )
                        job.terminate_and_wait(sigterm_grace_seconds=10)
                        _mark_job_failed(job_id, "errorSubprocessOomCap")
                        _is_terminal = True
                        return {
                            "success": False,
                            "error": f"subprocess_rss_cap_exceeded_{int(rss_mb)}MB",
                        }
                except (psutil.NoSuchProcess, AttributeError) as e:
                    logger.debug("Subprocess RSS poll skipped (process gone): %s", e)
                last_mem_log = now

        if job.status == "error":
            err = job.exception()
            err_short = err.splitlines()[-1][:500] if err else "errorSubprocessExit"
            logger.error(
                "process_document subprocess failed job=%s exit_code=%s last_line=%s",
                job_id,
                job.process.exitcode if job.process else "?",
                err_short,
            )
            # Match the old behaviour: retry on transient errors until
            # max_retries exhausted, then mark failed. We re-raise a
            # synthesised exception so Celery's retry machinery fires.
            from src.main.utils.core.error_codes import to_status_code

            if self.request.retries >= self.max_retries:
                _mark_job_failed(job_id, to_status_code(Exception(err_short)))
                _is_terminal = True
                return {"success": False, "error": err_short}
            # Re-raise so self.retry() schedules a new attempt
            raise self.retry(exc=Exception(err_short)) from None

        if job.status == "cancelled":
            logger.warning("process_document subprocess cancelled job=%s", job_id)
            _mark_job_failed(job_id, "errorSubprocessCancelled")
            _is_terminal = True
            return {"success": False, "error": "cancelled"}

        # finished — subprocess returned cleanly. Subprocess body already
        # wrote the final status to the documents/jobs rows.
        elapsed_s = int(time.monotonic() - loop_start)
        logger.info("Celery process_document subprocess succeeded: job=%s elapsed=%ds", job_id, elapsed_s)
        _is_terminal = True
        _succeeded = True
        return {"success": True, "document_id": document_id, "elapsed_s": elapsed_s}

    except SoftTimeLimitExceeded:
        logger.error("Celery process_document soft-timeout job=%s — terminating subprocess", job_id)
        try:
            if "job" in locals() and job is not None:
                job.terminate_and_wait(sigterm_grace_seconds=30)
        except Exception:
            logger.exception("subprocess terminate failed during soft-timeout")
        _mark_job_failed(job_id, "errorSoftTimeLimit")
        _is_terminal = True
        raise

    finally:
        # Stop heartbeat before releasing the doc lock.
        try:
            stop_heartbeat(heartbeat_thread, heartbeat_stop)
        except Exception:
            logger.exception("heartbeat: stop failed for job=%s (non-fatal)", job_id)
        _release_doc_lock(document_id)
        # Always decrement the per-user concurrency counter so the user can
        # submit new documents after this task completes (success or failure).
        _decrement_user_counter(user_id)
        # Shared-volume tmpfile handling for memory-only uploads, only once
        # this attempt is terminal (intermediate failures keep the bytes the
        # next retry needs):
        #   * COMPLETED (content persisted) → drop the tmpfile, preserving the
        #     ephemeral semantic.
        #   * NOT completed (terminal failure OR OCR-deferred scanned PDF, which
        #     exits the subprocess cleanly but lands in failed/errorScannedPdfOcrDeferred
        #     with empty content) → KEEP the tmpfile and record its path in
        #     file_metadata so a later reprocess (re-parse, or OCR with the
        #     setting enabled) can recover the bytes. A memory-only doc has no
        #     other copy; deleting here is what used to turn failed/deferred
        #     uploads into unrecoverable stubs (the errorFileNotFound dead-ends).
        #     The DB-aware tmp GC (scrapalot.maintenance.gc_orphan_tmpfiles)
        #     bounds the disk while keeping bytes a live doc still references.
        if cleanup_file_after and file_path and _is_terminal:
            if _succeeded and _doc_is_completed(document_id):
                try:
                    import os as _os

                    if _os.path.exists(file_path):
                        _os.remove(file_path)
                        logger.info("Cleaned up memory-only tmpfile %s", file_path)
                except Exception as cleanup_err:
                    logger.warning("Failed to cleanup tmpfile %s: %s", file_path, cleanup_err)
            else:
                _retain_recovery_tmpfile(document_id, file_path)


def _process_heavy_body(
    job_id: str,
    document_id: str,
    collection_id: str,
    user_id: str,
    file_path: str,
    build_graph: bool = False,
    generate_summary: bool = False,
) -> None:
    """The actual heavy upload-processing work — runs INSIDE the spawned subprocess.

    Mirrors `_reprocess_heavy_body` design. Must be module-level so spawn
    can pickle the function reference. All heavy imports (PyTorch, Docling,
    LangChain, etc.) live inside this body so the Celery worker process
    never loads them. Raises on failure; SubprocessJobClient captures the
    traceback via mp.Queue and the watchdog surfaces it.
    """
    logger.info(
        "Heavy process_document (subprocess) started: job=%s document=%s build_graph=%s generate_summary=%s",
        job_id,
        document_id,
        build_graph,
        generate_summary,
    )

    from src.main.background.tasks.document_pipeline import process_uploaded_document

    result = process_uploaded_document(
        job_id=job_id,
        document_id=document_id,
        collection_id=collection_id,
        user_id=user_id,
        file_path=file_path,
    )
    logger.info("Heavy process_document subprocess pipeline returned: job=%s success=%s", job_id, result.get("success"))

    # Post-processing only when core pipeline succeeded. Failed docs have
    # no usable chunks for graph hierarchy and nothing to summarise.
    if result.get("success"):
        if build_graph:
            _post_upload_build_graph(document_id, collection_id, user_id)
        if generate_summary:
            _post_upload_generate_summary(document_id, user_id)


def _post_upload_build_graph(document_id: str, collection_id: str, user_id: str) -> None:
    """Neo4j hierarchy + entity extraction is a hosted-only feature and is not
    available in the Community Edition. The document is already parsed, chunked
    and embedded (RAG-searchable); this graph step is a no-op in CE.
    """
    logger.debug("Post-upload build_graph skipped (hosted-only) in CE for %s", document_id[:8])


def _post_upload_generate_summary(document_id: str, user_id: str) -> None:
    """Run the document-summary LLM for a freshly processed doc."""
    try:
        import asyncio as _aio
        from uuid import UUID

        from src.main.config.database import SessionLocal
        from src.main.service.document.document_summary_service import DocumentSummaryService

        db = SessionLocal()
        try:
            svc = DocumentSummaryService(db)
            _aio.run(
                svc.generate_document_summaries(
                    document_id=UUID(document_id),
                    user_id=UUID(user_id),
                )
            )
            logger.info("Summary generated for %s", document_id[:8])

            # Collection memory-digest enrichment lives in the graph housekeeping
            # tasks, which are a hosted-only feature absent from the Community
            # Edition. The per-document summary above is still generated.
            logger.debug("Collection digest dispatch skipped (hosted-only) in CE for %s", document_id[:8])
        finally:
            db.close()
    except Exception as exc:
        logger.warning("Post-upload generate_summary failed for %s: %s", document_id[:8], exc)


def _decrement_user_counter(user_id: str) -> None:
    """Decrement the Redis per-user concurrency counter after task completion."""
    try:
        from src.main.utils.redis.client import get_redis_client

        redis = get_redis_client()
        key = f"{_USER_TASK_KEY_PREFIX}{user_id}"
        # noinspection PyTypeChecker
        value = int(redis.decr(key))
        # Clamp to zero — guard against double-decrement on unexpected restarts
        if value < 0:
            redis.delete(key)
    except Exception as e:
        logger.warning("Failed to decrement user task counter for user %s: %s", user_id, e)


@celery_app.task(
    name="scrapalot.process_batch",
    bind=True,
    max_retries=0,
    queue="documents",
    soft_time_limit=72000,  # 20-hour soft limit (large batches)
    time_limit=75600,  # 21-hour hard limit
)
def process_batch_task(self, docs_to_process: list, collection_id: str, user_id: str) -> dict:
    """
    Celery task that processes a batch of pending documents sequentially
    with a single shared DB session.

    Each document failure is logged and skipped — the batch continues.
    Progress is published to Redis pub/sub for real-time UI updates.

    Args:
        self: The Celery task instance (bound task)
        docs_to_process: List of dicts with document_id, file_path, has_content
        collection_id: The collection UUID
        user_id: The user UUID

    Returns:
        Dict with batch processing results
    """
    import asyncio
    from datetime import datetime
    import os

    from src.main.config.database import SessionLocal
    from src.main.models.enums import JobStatus
    from src.main.models.sqlmodel_jobs import Job
    from src.main.models.sqlmodel_models import Document  # noqa: F401 — register FK target before Job
    from src.main.utils.jobs.progress import publish_job_progress

    total = len(docs_to_process)
    logger.info("Celery batch task started: %d documents in collection %s", total, collection_id)

    # Acquire collection-level lock — if another batch for this collection is already running, skip
    batch_lock_key = f"{_BATCH_LOCK_PREFIX}{collection_id}"
    try:
        from src.main.utils.redis.client import get_redis_client

        _redis = get_redis_client()
        _batch_locked = _redis.set(batch_lock_key, f"worker-{self.request.id}", nx=True, ex=_BATCH_LOCK_TTL)
        if not _batch_locked:
            logger.warning(
                "Collection %s already has a batch task running — skipping duplicate (task=%s)",
                collection_id,
                self.request.id,
            )
            return {"success": True, "skipped": True, "reason": "duplicate_batch", "total": total}
    except Exception as e:
        logger.warning("Failed to acquire batch lock for collection %s: %s", collection_id, e)

    completed = 0
    failed = 0
    db = SessionLocal()

    # Create a single event loop for all async operations in this batch.
    # Multiple asyncio.run() calls create separate loops, causing asyncpg
    # InterfaceError when connections from one loop are used in another.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    try:
        for idx, doc_info in enumerate(docs_to_process, 1):
            doc_id = doc_info["document_id"]
            file_path = doc_info["file_path"]
            has_content = doc_info.get("has_content", False)

            logger.info("Batch [%d/%d]: processing document %s", idx, total, doc_id)

            if not _acquire_doc_lock(doc_id, task_id=self.request.id):
                logger.warning("Batch [%d/%d]: document %s already being processed — skipping", idx, total, doc_id)
                continue

            try:
                # Load content from DB for memory-only documents (no file on disk)
                markdown_content = None
                if not os.path.exists(file_path) and has_content:
                    from sqlalchemy import text as sa_text

                    row = db.execute(
                        sa_text("SELECT content FROM documents WHERE id = :id"),
                        {"id": doc_id},
                    ).fetchone()
                    if row and row.content:
                        markdown_content = row.content
                        logger.info("Loaded %d chars from DB for document %s", len(markdown_content), doc_id)

                # Find or create job for this document
                # noinspection PyPep8Naming
                from uuid import UUID as PyUUID

                doc_uuid = PyUUID(doc_id)
                # Find ANY existing job for this document (including failed/completed from previous runs)
                # noinspection PyTypeChecker,PyUnresolvedReferences
                job = db.query(Job).filter(Job.document_id == doc_uuid).order_by(Job.created_at.desc()).first()

                if not job:
                    # Create a job record for tracking
                    job = Job(
                        job_id=f"batch-{doc_id}",
                        job_type="document_processing",
                        document_id=doc_uuid,
                        user_id=user_id,
                        status=JobStatus.PROCESSING.value,
                        progress=5.0,
                        description="startingProcessing",
                        started_at=datetime.now(UTC),
                    )
                    db.add(job)
                    db.commit()
                else:
                    # Reset existing job (handles re-runs after failure)
                    job.status = JobStatus.PROCESSING.value
                    job.progress = 5.0
                    job.error_message = None
                    job.started_at = datetime.now(UTC)
                    job.completed_at = None
                    db.commit()

                job_id = job.job_id

                # Get filename for progress notifications
                _filename = None
                try:
                    from sqlalchemy import text as sa_text

                    fn_row = db.execute(
                        sa_text("SELECT filename FROM documents WHERE id = :doc_id"),
                        {"doc_id": doc_id},
                    ).fetchone()
                    if fn_row:
                        _filename = fn_row.filename
                except Exception as e:
                    logger.debug("Suppressed exception: %s", e)

                publish_job_progress(job_id, doc_id, user_id, collection_id, 5.0, "startingProcessing", "processing", _filename)

                # Mark document as processing
                from sqlalchemy import text as sa_text

                db.execute(
                    sa_text("UPDATE documents SET processing_status = 'processing' WHERE id = :doc_id"),
                    {"doc_id": doc_id},
                )
                db.commit()

                # Process the document with a timeout to prevent infinite hangs
                import signal

                _DOC_TIMEOUT = 3600  # 60 minutes max per document

                def _timeout_handler(_signum, _frame):
                    raise TimeoutError(f"Document processing exceeded {_DOC_TIMEOUT}s timeout")

                old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
                signal.alarm(_DOC_TIMEOUT)
                try:
                    _process_single_in_batch(db, job, doc_id, file_path, collection_id, user_id, _filename, markdown_content, loop)
                finally:
                    signal.alarm(0)  # Cancel alarm
                    signal.signal(signal.SIGALRM, old_handler)

                # _process_single_in_batch now marks BOTH job + document
                # completed atomically in its Step 6. The previous duplicate
                # UPDATE here was the source of the non-atomic-status bug
                # (see Step 6 docstring in _process_single_in_batch). Do not
                # reintroduce the second commit.

                _release_doc_lock(doc_id)
                completed += 1
                logger.info("Batch [%d/%d]: completed document %s", idx, total, doc_id)

            except SoftTimeLimitExceeded:
                _release_doc_lock(doc_id)
                logger.error("Batch soft time limit exceeded at document %d/%d", idx, total)
                raise
            except Exception as doc_error:
                _release_doc_lock(doc_id)
                failed += 1
                logger.exception("Batch [%d/%d]: failed document %s: %s", idx, total, doc_id, doc_error)
                # Roll back any partial state for this document and mark as failed.
                # Status code per CLAUDE.md rule #3.
                try:
                    from sqlalchemy import text as sa_text

                    from src.main.utils.core.error_codes import to_status_code

                    db.rollback()
                    db.execute(
                        sa_text("UPDATE documents SET processing_status = 'failed', processing_error = :err WHERE id = :doc_id"),
                        {"doc_id": doc_id, "err": to_status_code(doc_error)},
                    )
                    db.commit()
                except Exception as e:
                    logger.debug("Suppressed exception: %s", e)
                continue

    finally:
        db.close()
        loop.close()
        # Release the collection-level batch lock
        try:
            from src.main.utils.redis.client import get_redis_client

            get_redis_client().delete(batch_lock_key)
        except Exception as e:
            logger.debug("Suppressed exception: %s", e)

    logger.info("Celery batch task finished: %d/%d completed, %d failed", completed, total, failed)
    return {
        "success": True,
        "total": total,
        "completed": completed,
        "failed": failed,
        "collection_id": collection_id,
    }


def _process_single_in_batch(
    db,
    job,
    document_id: str,
    file_path: str,
    collection_id: str,
    user_id: str,
    filename: str | None,
    markdown_content: str | None,
    loop=None,
):
    """Process a single document within a batch using the shared DB session and event loop."""
    import asyncio
    from datetime import datetime
    import os

    from sqlalchemy import text as sa_text

    from src.main.models.enums import JobStatus
    from src.main.service.document.documents import DocumentService
    from src.main.utils.jobs.progress import publish_job_progress

    job_id = job.job_id

    def progress_callback(job_id_inner: str, progress_data: dict):
        try:
            job.progress = progress_data.get("progress", job.progress)
            job.description = progress_data.get("message", job.description)
            db.commit()
            publish_job_progress(
                job_id_inner,
                document_id,
                user_id,
                collection_id,
                progress_data.get("progress", 0),
                progress_data.get("message", "Processing..."),
                "processing",
                filename,
            )
        except Exception as prog_err:
            logger.warning("Error updating progress: %s", prog_err)

    # Step 1: Validate workspace ACL
    document_service = DocumentService(db)
    workspace_info = document_service.get_workspace_for_collection_sync(collection_id, user_id)
    if not workspace_info:
        raise ValueError("errorWorkspacePermission")

    workspace_id = workspace_info["workspace_id"]

    # Step 2: Process document - extract text -> chunk -> embed
    job.progress = 15.0
    job.description = "extractingText"
    db.commit()
    publish_job_progress(
        job_id,
        document_id,
        user_id,
        collection_id,
        15.0,
        "extractingText",
        "processing",
        filename,
    )

    # Get OCR setting (use shared loop to avoid asyncpg cross-loop errors)
    from src.main.service.settings import get_user_settings

    _loop = loop or asyncio.new_event_loop()
    user_settings = _loop.run_until_complete(get_user_settings(user_id, db))
    doc_processing = user_settings.get("document_processing", {})
    ocr_enabled = doc_processing.get("ocr_enabled", False)

    file_extension = os.path.splitext(file_path)[1].lower() if file_path else ""

    # Determine the content source.
    # PDF and EPUB processing uses Docling (heavy OCR models, ~3 GB RAM on CPU).
    # A global Redis lock ensures only one Docling instance runs at a time to
    # prevent OOM on the 6 GB worker container.
    # Text, RTF and tabular files are parsed in-process (no Docling) — they must
    # not acquire the heavy Docling lock nor fall through to the PDF parser.
    _non_docling_extensions = [".md", ".markdown", ".txt", ".rtf", ".csv", ".tsv", ".xlsx", ".xls"]
    _needs_docling_lock = file_extension not in _non_docling_extensions and not markdown_content
    if _needs_docling_lock:
        if not _acquire_docling_lock(document_id):
            raise RuntimeError("Timed out waiting for Docling lock")

    try:
        if markdown_content:
            from langchain_core.documents import Document as LCDocument

            documents = [LCDocument(page_content=markdown_content, metadata={"source": file_path or document_id})]
        elif file_extension == ".epub":
            from src.main.service.document.document_processor import document_processor

            documents = document_processor.process_epub(
                file_path=file_path,
                job_id=job_id,
                progress_callback=progress_callback,
                db=db,
                user_id=user_id,
            )
        elif file_extension in [".md", ".markdown", ".txt", ".rtf"]:
            documents = DocumentService.process_text_file(
                file_path=file_path,
                job_id=job_id,
                progress_callback=progress_callback,
                user_id=user_id,
            )
        elif file_extension in [".csv", ".tsv", ".xlsx", ".xls"]:
            documents = DocumentService.process_tabular(
                file_path=file_path,
                job_id=job_id,
                progress_callback=progress_callback,
                db=db,
                user_id=user_id,
            )
        else:
            from src.main.service.document.document_processor import document_processor
            from src.main.service.document_processing.multimodal_pipeline import is_multimodal_enabled

            multimodal_collector: list = [] if is_multimodal_enabled() else None  # type: ignore[assignment]

            try:
                documents = document_processor.process_pdf(
                    file_path=file_path,
                    ocr_enabled=ocr_enabled,
                    job_id=job_id,
                    progress_callback=progress_callback,
                    db=db,
                    user_id=user_id,
                    multimodal_collector=multimodal_collector,
                )
            except Exception as pdf_err:
                if "not valid" in str(pdf_err):
                    raise ValueError(
                        "This PDF file appears to be corrupted or uses an unsupported format. The document parser could not open it."
                    ) from pdf_err
                raise

            if multimodal_collector:
                from src.main.service.document_processing.multimodal_persister import persist_drafts
                from src.main.service.document_processing.multimodal_pipeline import describe_pending

                persist_drafts(db, document_id, multimodal_collector)
                describe_pending(db, document_id, loop=_loop)
    finally:
        if _needs_docling_lock:
            _release_docling_lock(document_id)

    if not documents:
        if file_extension in [".epub"]:
            raise ValueError("Failed to extract text from EPUB. The file may be DRM-protected, corrupted, or use an unsupported format.")
        else:
            raise ValueError(
                "No text could be extracted from this document. "
                "It may be a scanned/image-only PDF with text in a non-Latin script (e.g., old German Fraktur, Arabic, Chinese) "
                "that the OCR engine cannot read, or the file may be corrupted/password-protected."
            )

    # Step 2b: Extract and store document metadata (title, author)
    # noinspection PyProtectedMember
    from src.main.background.tasks.document_pipeline import _extract_and_store_document_metadata

    _extract_and_store_document_metadata(db, document_id, file_path, file_extension, documents)

    # Step 3: Enrich with metadata
    job.progress = 50.0
    job.description = "enrichingMetadata"
    db.commit()
    publish_job_progress(job_id, document_id, user_id, collection_id, 50.0, "enrichingMetadata", "processing", filename)

    from src.main.utils.documents.utils import enrich_documents_with_metadata_core

    enriched_documents = enrich_documents_with_metadata_core(documents, collection_id, user_id, document_id, job_id=job_id)

    # Step 4: Store embeddings
    job.progress = 65.0
    job.description = "storingEmbeddings"
    db.commit()
    publish_job_progress(
        job_id,
        document_id,
        user_id,
        collection_id,
        65.0,
        "storingEmbeddings",
        "processing",
        filename,
    )

    from src.main.service.retriever.retriever_manager import retriever_manager

    # Initialize RetrieverManager if not yet initialized (worker process has no startup sequence)
    # noinspection PyProtectedMember
    if not retriever_manager._config:
        from src.main.utils.config.loader import resolved_config, resolved_secrets

        _loop.run_until_complete(retriever_manager.initialize(resolved_config, resolved_secrets))

    # Store embeddings using the shared event loop to keep asyncpg connections valid
    # noinspection PyProtectedMember
    from src.main.utils.documents.utils import _store_embeddings_async

    _loop.run_until_complete(_store_embeddings_async(enriched_documents, collection_id, user_id, db, retriever_manager))

    # Step 4b: Inject embedding UUIDs for Neo4j chunk ID alignment
    try:
        embedding_rows = db.execute(
            sa_text(
                """
                SELECT id, (cmetadata->>'chunk_index')::int as ci
                FROM langchain_pg_embedding
                WHERE cmetadata->>'document_id' = :doc_id
                ORDER BY ci NULLS LAST
            """
            ),
            {"doc_id": document_id},
        ).fetchall()
        if embedding_rows and len(embedding_rows) == len(enriched_documents):
            for row, doc in zip(embedding_rows, enriched_documents, strict=False):
                if hasattr(doc, "metadata"):
                    doc.metadata["chunk_id"] = str(row[0])
            logger.info("Injected %d embedding UUIDs", len(embedding_rows))
    except Exception as e:
        logger.warning("Failed to inject embedding UUIDs: %s", e)

    # Step 5: Graph integration (hierarchy + entity extraction) is a hosted-only
    # feature and is not available in the Community Edition. The document is
    # already parsed, chunked and embedded above (RAG-searchable); this step is
    # skipped in CE.
    logger.debug("Graph integration skipped (hosted-only) in CE for %s", document_id[:8])

    # Step 6: Mark BOTH job + document completed in ONE transaction.
    #
    # Previously the document UPDATE lived in the parent process_batch_task
    # (line 444+) AFTER a separate db.commit() in this function for the
    # job. A worker crash, OOM kill, or container restart between the two
    # commits left job=completed with document.processing_status=pending
    # forever — root cause of the 29 stuck-pending agriculture docs from
    # the 2026-03-08 memory crisis. Single transaction now makes the two
    # state changes atomic; either both land or neither does.
    job.status = JobStatus.COMPLETED.value
    job.progress = 100.0
    job.description = "documentProcessingCompleted"
    job.completed_at = datetime.now(UTC)
    db.execute(
        sa_text("UPDATE documents SET processing_status = 'completed', processing_error = NULL, process_retry_count = 0 WHERE id = :doc_id"),
        {"doc_id": document_id},
    )
    db.commit()
    publish_job_progress(
        job_id,
        document_id,
        user_id,
        collection_id,
        100.0,
        "documentProcessingCompleted",
        "completed",
        filename,
    )


def _mark_job_failed(job_id: str, message: str) -> None:
    """Update the job status to 'failed' in the database."""
    try:
        from datetime import datetime

        from src.main.config.database import SessionLocal
        from src.main.models.enums import JobStatus
        from src.main.models.sqlmodel_jobs import Job
        from src.main.models.sqlmodel_models import Document  # noqa: F401 — register FK target before Job

        db = SessionLocal()
        try:
            # noinspection PyTypeChecker
            job = db.query(Job).filter(Job.job_id == job_id).first()
            if job:
                job.status = JobStatus.FAILED.value
                job.description = message
                job.completed_at = datetime.now(UTC)
                db.commit()
        finally:
            db.close()
    except Exception as e:
        logger.error("Failed to mark job %s as failed: %s", job_id, e)


# ──────────────────────────────────────────────
# REPROCESS TASK (moved from asyncio in scrapalot-chat to Celery worker)
# ──────────────────────────────────────────────


@celery_app.task(
    name="scrapalot.reprocess_document",
    bind=True,
    # The Celery task is now a thin
    # watchdog over a spawned subprocess (SubprocessJobClient). All heavy
    # imports (PyTorch, Docling, LangChain, sentence-transformers) live
    # ONLY inside the subprocess body — Celery thread stays at ~600 MB.
    #
    # max_retries=0: Celery retries are disabled at the task level. If the
    # subprocess fails we mark the doc failed via `_mark_reprocess_failed`
    # and let JobRecovery (heartbeat-driven) handle re-dispatch
    # with proper backoff + dispatch-side guards. Celery's own
    # retry semantics race with the doc_lock + JobRecovery layer.
    #
    # acks_late=False: ack the message immediately. State of the work
    # lives in the doc + jobs rows, not the broker. Broker re-delivery on
    # long tasks (visibility timeout) is exactly what we DON'T want —
    # avoids the prefork-era infinite re-queue loop that was partially
    # mitigated by setting `task_reject_on_worker_lost=False`.
    #
    # reject_on_worker_lost stays False (global default).
    #
    # soft_time_limit stays 3h — protects against runaway subprocess that
    # the watchdog can't kill cleanly. Hard time_limit at 3h10min.
    max_retries=0,
    soft_time_limit=10800,
    time_limit=11400,
    queue="documents",
    acks_late=False,
    reject_on_worker_lost=False,
)
def reprocess_document_task(
    self,
    document_id: str,
    collection_id: str,
    user_id: str,
    cleanup_file_after: bool = False,
    force_parse_from_file: bool = False,
    skip_graph_build: bool = False,
) -> dict:
    """
    Reprocess a document via a spawn-subprocess watchdog.

    The actual heavy work (DB validation, destructive cleanup, optional PDF parse,
    chunking, embedding, hierarchy + entity rebuild, status finalisation,
    Cat-I cleanup_file_after) runs inside ``_reprocess_heavy_body`` in a
    ``multiprocessing.get_context("spawn")`` subprocess. The Celery thread
    holds the doc lock, polls the subprocess every 5 s, emits memory
    diagnostics every 60 s, and surfaces success/failure.

    Args:
        cleanup_file_after: When True, after the pipeline completes successfully,
            delete the disk file and flip ``documents.file_stored`` back to false.
            Used by Cat-I (Annas restore) when the pre-restore doc was
            file_stored=false — Cat-I must NOT silently flip a markdown-only doc
            into a file-on-disk doc just because it ran a restore.
        force_parse_from_file: When True, ignore existing ``documents.content``
            and re-extract from the disk file (PDF/EPUB/DOCX). Default False
            means: if ``documents.content`` already holds a non-trivial body
            (>=1000 chars), reuse it directly and skip the parse step. The
            common Cat-F replay only needs a chunker re-run on already-clean
            content, so the default avoids the Docling / pymupdf re-extract
            (which on large scanned PDFs can deadlock or take hours). Set
            True only when the stored content itself is suspected to be
            truncated, corrupt, or extraction-bug polluted at the source level.
        skip_graph_build: When True, force-suppress the Neo4j graph build
            phase (Workspace → Collection → Book → Chapter → Section → Chunk
            + entity extraction + REFERENCES / MENTIONS / CO_OCCURS rels).
            Default False keeps the historical behavior: graph build runs
            iff Neo4j is reachable. Cat-F dispatchers operating in the parse
            phase (where pgvector chunks + JSONB document_hierarchy + doc
            summaries are the deliverable, and the graph layer is the
            sibling ``scrapalot-postprocess-graph`` skill's domain) pass
            True so a parse-only replay doesn't get tied up in a 30+ min
            entity-extraction step that the parse phase neither owns nor
            verifies. The sibling graph skill rebuilds the graph layer
            after parse_done lands.
    """
    import time

    from src.main.workers.subprocess_job import SubprocessJobClient
    from src.main.workers.utils.dispatch_guards import release_dispatch_guard
    from src.main.workers.utils.heartbeat import start_heartbeat, stop_heartbeat

    # Release the JobRecovery dispatch guard ASAP so the
    # next beat cycle can re-enqueue if THIS task crashes before the
    # heartbeat detects the stall. JobRecovery's safe_send_task set the
    # guard with action="reprocess_recovery"; user-initiated reprocess
    # (admin gRPC, UI button) didn't set one, so this delete is a
    # harmless no-op in those cases.
    release_dispatch_guard(document_id, action="reprocess_recovery")

    logger.info("Celery reprocess watchdog start: document=%s", document_id[:8])

    if not _acquire_doc_lock(document_id, task_id=self.request.id):
        logger.warning("Document %s already being processed — skipping", document_id[:8])
        return {"success": True, "skipped": True, "reason": "duplicate"}

    # Start heartbeat thread that bumps jobs.heartbeat_counter
    # every 30 s while the subprocess does the actual work. JobRecovery uses
    # this monotonic counter (not documents.updated_at) to decide whether
    # the task is alive, idle within tolerance, or stuck past the cutoff.
    # The job_id matches the one written by _reprocess_heavy_body's Step 2
    # so the heartbeat UPDATE lands on the right row even if the subprocess
    # is the one that INSERTTs / re-uses the Job record.
    job_id_for_heartbeat = f"reprocess-{document_id}"
    heartbeat_thread, heartbeat_stop = start_heartbeat(job_id_for_heartbeat)

    try:
        client = SubprocessJobClient(n_workers=1)
        job = client.submit(
            _reprocess_heavy_body,
            document_id,
            collection_id,
            user_id,
            cleanup_file_after,
            force_parse_from_file,
            skip_graph_build,
        )
        if job is None:
            logger.error("subprocess spawn refused (cap reached) for doc=%s", document_id[:8])
            _mark_reprocess_failed(document_id, "errorSubprocessSpawnRefused")
            return {"success": False, "error": "subprocess_spawn_refused"}

        last_mem_log = 0.0
        loop_start = time.monotonic()
        try:
            import psutil  # optional — degrade gracefully if unavailable
        except ImportError:
            psutil = None

        # Defensive RSS cap. With
        # threads pool + spawn subprocess we lost `worker_max_memory_per_child`
        # (removed — irrelevant for threads). Container memory
        # limit (8 GB) is the only hard ceiling. A PyTorch /
        # Docling memory leak inside a long subprocess could OOM-kill the
        # ENTIRE container, taking down beat + fast queue too. Watchdog
        # SIGKILLs the subprocess at ~3.5 GB so the container survives.
        SUBPROCESS_RSS_CAP_MB = 3500

        # Watchdog loop: 5s tick, memory diagnostics every 60s, RSS cap check.
        while not job.done():
            time.sleep(5)
            now = time.monotonic()
            if now - last_mem_log >= 60.0 and psutil is not None and job.process is not None:
                try:
                    p = psutil.Process(job.process.pid)
                    rss_mb = p.memory_info().rss / 1024 / 1024
                    elapsed_s = int(now - loop_start)
                    logger.info(
                        "reprocess subprocess doc=%s pid=%s rss=%.1fMB elapsed=%ds",
                        document_id[:8],
                        job.process.pid,
                        rss_mb,
                        elapsed_s,
                    )
                    # Defensive RSS cap — kill before container OOM-killer hits.
                    if rss_mb > SUBPROCESS_RSS_CAP_MB:
                        logger.error(
                            "reprocess subprocess doc=%s pid=%s rss=%.1fMB > cap=%dMB — killing to protect container",
                            document_id[:8],
                            job.process.pid,
                            rss_mb,
                            SUBPROCESS_RSS_CAP_MB,
                        )
                        job.terminate_and_wait(sigterm_grace_seconds=10)
                        _mark_reprocess_failed(document_id, "errorSubprocessOomCap")
                        return {
                            "success": False,
                            "error": f"subprocess_rss_cap_exceeded_{int(rss_mb)}MB",
                        }
                except (psutil.NoSuchProcess, AttributeError) as e:
                    logger.debug("Reprocess RSS poll skipped (process gone): %s", e)
                last_mem_log = now

        # Subprocess exited — interpret outcome.
        if job.status == "error":
            err = job.exception()
            err_short = err.splitlines()[-1][:500] if err else "errorSubprocessExit"
            logger.error(
                "reprocess subprocess failed doc=%s exit_code=%s last_line=%s",
                document_id[:8],
                job.process.exitcode if job.process else "?",
                err_short,
            )
            # Signal-killed subprocess (CICD redeploy, docker restart, OOM
            # killer, host SIGKILL) reports the fallback string because the
            # mp.Queue was never populated. Leave processing_status='pending'
            # so JobRecovery (scheduled every 30 min) can auto-retry with
            # `process_retry_count` accounting. Marking 'failed' here would
            # take the doc out of JobRecovery's `_find_candidates` query
            # (which filters d.processing_status='pending').
            if "did not report an exception" in err:
                logger.warning(
                    "reprocess subprocess signal-killed doc=%s — leaving pending for JobRecovery",
                    document_id[:8],
                )
                return {"success": False, "error": "signal_killed_pending_recovery"}
            _mark_reprocess_failed(document_id, err_short)
            return {"success": False, "error": err_short}

        if job.status == "cancelled":
            logger.warning(
                "reprocess subprocess cancelled doc=%s — leaving pending for JobRecovery",
                document_id[:8],
            )
            return {"success": False, "error": "cancelled_pending_recovery"}

        # status == "finished": subprocess exited cleanly with code 0.
        # The heavy body wrote the final status (`completed`) to the doc row
        # itself. We just need to log + return.
        elapsed_s = int(time.monotonic() - loop_start)
        logger.info("Celery reprocess subprocess succeeded: document=%s elapsed=%ds", document_id[:8], elapsed_s)
        return {"success": True, "document_id": document_id, "elapsed_s": elapsed_s}

    except SoftTimeLimitExceeded:
        logger.error("Celery reprocess soft-timeout doc=%s — terminating subprocess", document_id[:8])
        try:
            if "job" in locals() and job is not None:
                job.terminate_and_wait(sigterm_grace_seconds=30)
        except Exception:
            logger.exception("subprocess terminate failed during soft-timeout")
        _mark_reprocess_failed(document_id, "errorReprocessTimeout")
        raise
    except Exception as exc:
        logger.exception("Celery reprocess watchdog crashed doc=%s", document_id[:8])
        try:
            if "job" in locals() and job is not None:
                job.terminate_and_wait(sigterm_grace_seconds=10)
        except Exception as e:
            logger.debug("Job termination after watchdog crash failed: %s", e)
        _mark_reprocess_failed(document_id, "errorWatchdogCrash")
        return {"success": False, "error": str(exc)[:500]}
    finally:
        # Stop the heartbeat thread before releasing the doc
        # lock. Order matters: heartbeat must stop FIRST so the next
        # JobRecovery cycle (whose `_find_candidates` reads the counter)
        # sees a stable snapshot. doc_lock release is the final cleanup.
        try:
            stop_heartbeat(heartbeat_thread, heartbeat_stop)
        except Exception:
            logger.exception("heartbeat: stop failed for doc=%s (non-fatal)", document_id[:8])
        _release_doc_lock(document_id)


def _reprocess_heavy_body(
    document_id: str,
    collection_id: str,
    user_id: str,
    cleanup_file_after: bool = False,
    force_parse_from_file: bool = False,
    skip_graph_build: bool = False,
) -> None:
    """The actual heavy reprocess work — runs INSIDE the spawned subprocess.

    Must be a module-level function (not nested) because spawn pickles the
    function reference. All heavy imports (PyTorch, Docling, LangChain, etc.)
    live INSIDE this function body so the Celery worker process never loads
    them. After this function returns, the subprocess exits and releases
    all RAM back to the OS.

    Raises on failure; SubprocessJobClient captures the traceback via mp.Queue
    and the watchdog surfaces it as ``status="error"``.
    """
    import asyncio
    import os
    from uuid import UUID

    logger.info("Heavy reprocess (subprocess) started: document=%s", document_id[:8])
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    try:
        from sqlalchemy import text

        from src.main.config.database import SessionLocal

        # Step 1: Validate that the document exists and get file_path + content (read-only).
        # Content-only docs (file_stored=false with Markdown in documents.content — e.g.,
        # agriculture collection) have no disk artifact by design. We carry the Markdown
        # forward as fallback content instead of failing on the disk check.
        db = SessionLocal()
        try:
            row = db.execute(
                text("SELECT file_path, content, file_stored, deleted_at, file_metadata FROM documents WHERE id = :doc_id"),
                {"doc_id": document_id},
            ).fetchone()
            if not row:
                logger.error("Document %s not found, aborting reprocess", document_id[:8])
                return {"success": False, "error": "Document not found"}
            # Short-circuit soft-deleted docs: a task may have been queued before
            # the user/admin soft-deleted the document. Running reprocess would
            # create orphan chunks/embeddings/Neo4j nodes for a doc that's meant
            # to be gone. Bail cleanly so the queue drains without side effects.
            if row[3] is not None:
                logger.info("Reprocess skipped for doc %s: deleted_at set (%s)", document_id[:8], row[3])
                return {"success": True, "skipped": True, "reason": "deleted"}
            # Short-circuit redelivered tasks for already-completed docs.
            # Celery's task_acks_late=True + task_reject_on_worker_lost=True
            # requeues reprocess messages that were interrupted (e.g. SIGKILL
            # on hard-timeout, `docker stop`). After the retry clock elapses
            # they come back — and on a completed doc this re-does 30+ min
            # of parse+chunk+embed+graph work, holding a Celery slot that
            # should be servicing newer uploads. The idempotent bailout
            # below is safe because subsequent retries only fire for docs
            # whose prior run finished successfully.
            # Redelivered-task short-circuit removed. With
            # `acks_late=False` on the Celery task, the broker never
            # re-delivers (state lives in jobs + documents rows). Doc
            # lock at the Celery watchdog layer already prevents duplicate
            # subprocess spawn. If the doc has graph_done='completed' AND
            # status='completed', the watchdog wouldn't have submitted to
            # this subprocess in the first place — the caller would have
            # short-circuited at the lock or at the worker pre-flight stage.
            # Keeping the read for future telemetry but no longer skipping.
            graph_done = db.execute(
                text("SELECT status FROM graph_sync_status WHERE document_id = :did AND status = 'completed'"),
                {"did": document_id},
            ).fetchone()
            if graph_done:
                logger.debug("Reprocess: doc %s graph_sync_status=completed (informational)", document_id[:8])
            file_path = row[0] or ""
            content_fallback = row[1] if (row[1] and len(row[1]) > 100) else None
            file_stored = bool(row[2])
            file_metadata = row[4]
            resolved_path = os.path.join("/app", file_path) if file_path and not file_path.startswith("/") else file_path
        finally:
            db.close()

        # Recovery fallback: a memory-only doc that failed an earlier attempt
        # keeps its bytes under /app/data/tmp, with the path recorded in
        # file_metadata.recovery_tmp_path (see the upload watchdog). When the
        # logical file_path isn't on disk, parse from that retained tmpfile
        # instead of dead-ending on errorFileNotFound.
        if not (file_path and os.path.exists(resolved_path)):
            _meta = file_metadata
            if isinstance(_meta, str):
                try:
                    import json as _json

                    _meta = _json.loads(_meta)
                except (ValueError, TypeError):
                    _meta = None
            _recovery = _meta.get("recovery_tmp_path") if isinstance(_meta, dict) else None
            if _recovery and os.path.exists(_recovery):
                logger.info("Reprocess doc %s: recovering bytes from retained tmpfile %s", document_id[:8], _recovery)
                file_path = _recovery
                resolved_path = _recovery

        file_on_disk = bool(file_path and os.path.exists(resolved_path))
        if not file_on_disk and not content_fallback:
            logger.error("Reprocess aborted for doc %s: no disk file and no content (file_stored=%s)", document_id[:8], file_stored)
            _mark_reprocess_failed(document_id, "errorFileNotFound")
            return {"success": False, "error": "errorFileNotFound"}

        # Default Cat-F replay path: if documents.content already holds a
        # non-trivial body, re-chunk from it instead of re-parsing the disk
        # file. The common pollution mode (garbage chapter_titles like 'I I',
        # '-:', '-- --' on legacy ingests) lives in the chunker's OUTPUT, not
        # in the extracted content — re-running the modern chunker on the
        # existing content reliably fixes chunk pollution without paying for
        # a fresh Docling / pymupdf extract that can deadlock on large
        # scanned PDFs (e.g. 33 MB Qigong PDF that hung 2h13m at zero
        # progress before SIGUSR1 cleanup, 2026-05-28). Override with
        # force_parse_from_file=True when the stored content itself is
        # truncated, corrupt, or extraction-bug polluted at the source level.
        content_present = bool(content_fallback) and len(content_fallback) >= 1000
        use_content_only = content_present and not force_parse_from_file
        if use_content_only:
            logger.info(
                "Reprocess doc %s: content-only rechunk path (content_chars=%d, file_on_disk=%s) — skipping disk parse",
                document_id[:8],
                len(content_fallback),
                file_on_disk,
            )
        elif not file_on_disk:
            logger.info(
                "Reprocess doc %s: using content-only path (file_stored=%s, %d chars)", document_id[:8], file_stored, len(content_fallback or "")
            )
        elif force_parse_from_file:
            logger.info(
                "Reprocess doc %s: force_parse_from_file=True — re-extracting from disk file (%s)",
                document_id[:8],
                resolved_path,
            )

        # Step 1.5: Validate workspace ACL BEFORE any destructive operation.
        # The pipeline's own ACL check (process_uploaded_document) runs only
        # AFTER Step 3 wipes chunks + Neo4j hierarchy nodes — so a bad
        # user_id (e.g. bash `$UID` substitution that resolves to the
        # integer process UID like `1001` instead of the doc-owner UUID)
        # wipes the doc, then fails validation, leaving a fully-cleared
        # row until a clean re-dispatch. Move the check up here so a bad
        # user_id aborts cleanly with the doc still intact.
        try:
            db_acl = SessionLocal()
            try:
                from src.main.service.document.documents import DocumentService

                workspace_info = DocumentService(db_acl).get_workspace_for_collection_sync(  # type: ignore[attr-defined]
                    collection_id, user_id
                )
                if not workspace_info:
                    logger.error(
                        "Reprocess aborted for doc %s: errorWorkspacePermission (user_id=%s, collection_id=%s) — no destructive ops performed",
                        document_id[:8],
                        user_id,
                        collection_id,
                    )
                    _mark_reprocess_failed(document_id, "errorWorkspacePermission")
                    return {"success": False, "error": "errorWorkspacePermission"}
            finally:
                db_acl.close()
        except Exception as acl_err:
            logger.error("Reprocess ACL pre-check failed for doc %s: %s", document_id[:8], acl_err)
            _mark_reprocess_failed(document_id, "errorWorkspacePermission")
            return {"success": False, "error": "errorWorkspacePermission"}

        # Step 2: Create Job record FIRST (before any destructive ops)
        # If this fails (e.g., schema violation), nothing has been deleted yet.
        from src.main.background.tasks.document_pipeline import process_uploaded_document
        from src.main.models.enums import JobStatus
        from src.main.models.sqlmodel_jobs import Job
        from src.main.models.sqlmodel_models import Document  # noqa: F401

        job_id = f"reprocess-{document_id}"
        db_job = SessionLocal()
        try:
            # noinspection PyTypeChecker
            existing_job = db_job.query(Job).filter(Job.job_id == job_id).first()
            if existing_job:
                existing_job.status = JobStatus.PROCESSING.value
                existing_job.progress = 0.0
                existing_job.description = "Reprocessing document"
                db_job.commit()
            else:
                # `user_id` is mandatory for downstream attribution: the
                # `JobRecoveryService` summary-backfill dispatch reads it
                # to figure out who owns the doc when re-queueing a
                # `scrapalot.generate_document_summaries` task. Earlier
                # versions of this constructor omitted the field, which
                # silently fell back to the model default `None` — every
                # reprocess job in production therefore had `user_id=NULL`,
                # so when recovery promoted a doc to `completed` without
                # summaries, the dispatch step skipped silently and the
                # operator had to backfill by hand.
                new_job = Job(
                    job_id=job_id,
                    job_type="document_processing",
                    document_id=UUID(document_id),
                    user_id=UUID(user_id) if user_id else None,
                    status=JobStatus.PROCESSING.value,
                    description="Reprocessing document",
                )
                db_job.add(new_job)
                db_job.commit()
        finally:
            db_job.close()

        # Step 3: Destructive cleanup — reset status, delete old embeddings
        # Only runs AFTER Job creation succeeds, preventing partial state on schema errors.
        db = SessionLocal()
        try:
            # Invalidate PageRank: reprocess rebuilds the Neo4j hierarchy +
            # entity layer, which is the graph PageRank ran on. The stored
            # `pagerank_score` (used by retriever_neo4j + bridge_service for
            # ranking) reflects the pre-reprocess graph and would silently
            # bias ranking until the next workspace-wide PageRank recompute.
            # NULL signals "needs recompute" — the subsequent housekeeping
            # `recompute_pagerank` task picks it up.
            db.execute(
                text(
                    """
                    UPDATE documents SET processing_status = 'pending',
                    processing_progress = 0, processing_error = NULL,
                    pagerank_score = NULL, pagerank_computed_at = NULL
                    WHERE id = :doc_id
                """
                ),
                {"doc_id": document_id},
            )
            # Delete by document_id ALONE — never gate on collection_id. The
            # langchain_pg_collection row is recreated (new uuid) whenever the
            # collection is re-provisioned, so old chunks can sit under a STALE
            # collection_uuid while the lookup returns the CURRENT one. Gating
            # the delete on `collection_id = (current uuid)` then misses every
            # chunk written under a prior uuid → they survive the reprocess and
            # collide with the freshly-written chunk_index range (observed on
            # 9966e658: 121 stale chunks under 43373274… + 94 new under
            # 4fae8e88… = 215 rows, 94 chunk_index collisions). document_id is a
            # globally-unique UUID, so filtering on it alone is both sufficient
            # and correct — a reprocess must wipe ALL of the document's chunks.
            db.execute(
                text(
                    """
                    DELETE FROM langchain_pg_embedding
                    WHERE cmetadata->>'document_id' = :doc_id
                """
                ),
                {"doc_id": document_id},
            )
            db.commit()
        finally:
            db.close()
        logger.info("Pre-reprocess cleanup done for doc %s", document_id[:8])

        # Step 4: Neo4j hierarchy cleanup is a hosted-only feature absent from
        # the Community Edition — there is no graph to delete.
        logger.debug("Hierarchy cleanup skipped (hosted-only) in CE for doc %s", document_id[:8])

        # force_graph_build is gated on Neo4j reachability. Earlier this
        # was hard-coded True with the rationale "we just deleted the old
        # hierarchy, MUST rebuild now" — but if Neo4j is down (admin
        # restart, GC thrashing, container stopped) that True forced the
        # pipeline into a graph step it couldn't possibly satisfy, the
        # exception bubbled past the chunk-write + hierarchy-populate
        # commits, and the doc landed half-finished in
        # `processing_status='pending'`. Now: probe Neo4j; if down, run
        # the chunk + embed + JSONB-hierarchy half (which is sufficient
        # for retrieval) and let a future graph-rebuild admin pass close
        # the gap.
        #
        # Caller-side override: skip_graph_build=True forces the parse-only
        # path regardless of Neo4j status. Used by the parse-phase Cat-F
        # dispatcher (scrapalot-postprocess-parse) so a parse replay never
        # gets tied up in a 30+ min entity-extraction step that the parse
        # phase neither owns nor verifies — the sibling graph skill
        # (scrapalot-postprocess-graph) rebuilds the Neo4j layer later.
        # Knowledge-graph build is a hosted-only feature absent from the
        # Community Edition. The reprocess always runs the parse-only path
        # (chunks + JSONB hierarchy), never a Neo4j build.
        _graph_alive = False
        logger.debug(
            "Reprocess doc %s: graph build skipped (hosted-only) in CE — parse-only path",
            document_id[:8],
        )

        process_uploaded_document(
            job_id=job_id,
            document_id=document_id,
            collection_id=collection_id,
            user_id=user_id,
            file_path=file_path,
            force_graph_build=_graph_alive,
            # Pass markdown_content when either (a) caller opted into the
            # default content-reuse path (use_content_only) OR (b) the file
            # is genuinely missing from disk. Both cases skip the parse
            # step and feed the existing markdown straight into the chunker.
            markdown_content=content_fallback if (use_content_only or not file_on_disk) else None,
        )

        # Step 4: Entity-link rebuild is a hosted-only feature absent from the
        # Community Edition — there is no graph to re-link.
        logger.debug("Reprocess doc %s: entity-link rebuild skipped (hosted-only) in CE", document_id[:8])

        # Final completion guarantee. process_uploaded_document SHOULD
        # have set `processing_status='completed'` already (its Step 7);
        # this is a defensive backstop for edge cases where the pipeline
        # exits past the chunk + hierarchy commits but before the status
        # UPDATE (worker SIGKILL on max_tasks_per_child, ProcessPoolExecutor
        # cancellation, etc.). If chunks + JSONB hierarchy are present
        # the doc is functionally complete from a retrieval standpoint;
        # promoting status here avoids the half-baked `pending` rows
        # observed in production.
        try:
            from sqlalchemy import text as _txt

            db2 = SessionLocal()
            try:
                row = db2.execute(
                    _txt(
                        "SELECT processing_status, "
                        "       (SELECT COUNT(*) FROM langchain_pg_embedding e "
                        "        WHERE e.cmetadata->>'document_id' = :did) AS chunks, "
                        "       document_hierarchy IS NOT NULL AS has_hier "
                        "FROM documents WHERE id = :did"
                    ),
                    {"did": document_id},
                ).first()
                if row and row.processing_status == "pending" and (row.chunks or 0) > 0 and row.has_hier:
                    db2.execute(
                        _txt(
                            "UPDATE documents SET processing_status='completed', processing_error=NULL, "
                            "processing_progress=100 WHERE id = :did AND processing_status='pending'"
                        ),
                        {"did": document_id},
                    )
                    db2.commit()
                    logger.info(
                        "Reprocess doc %s: promoted to completed via backstop (chunks=%d, has_hier=%s)",
                        document_id[:8],
                        row.chunks,
                        row.has_hier,
                    )
            finally:
                db2.close()
        except Exception as _final_err:
            logger.warning("Reprocess doc %s: completion backstop failed: %s", document_id[:8], _final_err)

        # Cat-D mirror — process_uploaded_document calls
        # DocumentJobManager.complete_job() on the normal upload path, which
        # writes processing_stats + page_count via document_job_manager.py:240-274
        # (commit a32395c). The reprocess subprocess path bypasses complete_job()
        # — it calls process_uploaded_document() directly and updates status via
        # the raw-SQL backstop above. Without this mirror, every Cat-F replay
        # leaves processing_stats=NULL and page_count=NULL even after chunk +
        # hierarchy succeed (verified on doc 45a6228e Jung Alchemical, 2026-05-29).
        # Idempotent: only writes when columns are NULL.
        try:
            import json as _json2

            from sqlalchemy import text as _ctxt2

            db_d = SessionLocal()
            try:
                d_row = db_d.execute(
                    _ctxt2(
                        "SELECT (SELECT COUNT(*) FROM langchain_pg_embedding e "
                        "        WHERE e.cmetadata->>'document_id' = :did) AS chunks, "
                        "       processing_stats IS NULL AS stats_null, "
                        "       page_count IS NULL AS pages_null "
                        "FROM documents WHERE id = :did"
                    ),
                    {"did": document_id},
                ).first()
                if d_row and (d_row.chunks or 0) > 0:
                    if d_row.stats_null:
                        stats_payload = _json2.dumps(
                            {
                                "chunk_count": int(d_row.chunks),
                                "embedding_count": int(d_row.chunks),
                                "processor_used": "reprocess_cat_d_mirror",
                                "backfilled_by": "reprocess_cat_d_mirror",
                                "backfill_reason": "reprocess_path_bypassed_complete_job_finalizer",
                            }
                        )
                        db_d.execute(
                            _ctxt2("UPDATE documents SET processing_stats = :s::json WHERE id = :did AND processing_stats IS NULL"),
                            {"did": document_id, "s": stats_payload},
                        )
                    if d_row.pages_null:
                        # chunk_count as page_count proxy for content-only /
                        # EPUB / markdown_imported paths (no PDF page total).
                        db_d.execute(
                            _ctxt2("UPDATE documents SET page_count = :pc WHERE id = :did AND page_count IS NULL"),
                            {"did": document_id, "pc": int(d_row.chunks)},
                        )
                    db_d.commit()
                    logger.info(
                        "Reprocess doc %s: Cat-D mirror applied (stats_was_null=%s pages_was_null=%s chunks=%d)",
                        document_id[:8],
                        d_row.stats_null,
                        d_row.pages_null,
                        d_row.chunks,
                    )
            finally:
                db_d.close()
        except Exception as _d_err:
            logger.warning("Reprocess doc %s: Cat-D mirror failed: %s", document_id[:8], _d_err)

        # Cat-I post-restore cleanup: when the caller (annas_restore_service)
        # signalled the doc was file_stored=false before restore, we must
        # delete the disk file and flip the flag back. Without this, every
        # Cat-I silently violates the per-doc file_stored policy by promoting
        # markdown-only docs to file-on-disk docs. Runs ONLY on successful
        # pipeline completion — failures keep the file so the operator can
        # inspect or retry.
        if cleanup_file_after and file_path:
            try:
                if os.path.exists(resolved_path):
                    os.remove(resolved_path)
                    logger.info(
                        "Reprocess doc %s: deleted disk file (cleanup_file_after) %s",
                        document_id[:8],
                        resolved_path,
                    )
                from sqlalchemy import text as _ctxt

                db_cleanup = SessionLocal()
                try:
                    db_cleanup.execute(
                        _ctxt("UPDATE documents SET file_stored = FALSE, file_size = NULL WHERE id = :did"),
                        {"did": document_id},
                    )
                    db_cleanup.commit()
                    logger.info(
                        "Reprocess doc %s: flipped file_stored=false (per pre-restore policy)",
                        document_id[:8],
                    )
                finally:
                    db_cleanup.close()
            except Exception as cleanup_err:
                logger.warning(
                    "Reprocess doc %s: post-restore cleanup failed (non-fatal): %s",
                    document_id[:8],
                    cleanup_err,
                )

        logger.info("Celery reprocess completed: document=%s", document_id[:8])
        return {"success": True, "document_id": document_id, "graph_built": _graph_alive}

    except Exception as exc:
        # No `self` here — we're in a spawned subprocess function. Mark the
        # doc failed, then re-raise so SubprocessJobClient captures the
        # traceback via mp.Queue and the watchdog surfaces it.
        # SoftTimeLimitExceeded doesn't fire here because Celery's signal
        # handler lives in the parent process, not the subprocess. The
        # watchdog enforces the timeout by calling job.terminate_and_wait
        # when it observes SoftTimeLimitExceeded itself.
        logger.exception("Heavy reprocess (subprocess) failed: document=%s", document_id[:8])
        from src.main.utils.core.error_codes import to_status_code

        try:
            _mark_reprocess_failed(document_id, to_status_code(exc))
        except Exception:
            logger.exception("Failed to mark doc failed (continuing to re-raise)")
        raise

    finally:
        loop.close()
        # NOTE: _release_doc_lock is NOT called here — it's owned by the
        # Celery watchdog parent (reprocess_document_task's `finally`).
        # The doc lock value is the Celery task ID, which the subprocess
        # doesn't have access to anyway.


def _mark_reprocess_failed(document_id: str, message: str) -> None:
    """Mark the document and its reprocessing Job as failed after a reprocessing error."""
    try:
        from sqlalchemy import text

        from src.main.config.database import SessionLocal

        db = SessionLocal()
        try:
            # Reprocess's destructive pre-cleanup already wiped pgvector chunks +
            # Neo4j subtree. If we now fail before the new chunker writes anything,
            # documents.document_hierarchy still references chunk indices that no
            # longer exist. chat_agentic_rag's tagged-doc path then reads phantom
            # entries. Clear hierarchy here so the row is honest. Verified on
            # d1bf4a5a (Lévi-Strauss "Structural Anthropology", parse_file_lost
            # 2026-05-22) — hierarchy had 39 entries referencing indices 0-461
            # against 0 actual chunks. Backfill cleaned 172 system-wide orphans.
            db.execute(
                text("UPDATE documents SET processing_status = 'failed', processing_error = :msg, document_hierarchy = NULL WHERE id = :did"),
                {"did": document_id, "msg": message[:500]},
            )
            # Transition the reprocessing Job record out of PROCESSING so admin UI / job polling
            # don't show zombie "running" jobs forever. Job id is deterministic: reprocess-{doc_id}.
            db.execute(
                text(
                    """
                    UPDATE jobs
                    SET status = 'failed', error_message = :msg, updated_at = NOW()
                    WHERE job_id = :job_id
                """
                ),
                {"job_id": f"reprocess-{document_id}", "msg": message[:500]},
            )
            db.commit()
        finally:
            db.close()
    except Exception as e:
        logger.error("Failed to mark reprocess as failed for %s: %s", document_id[:8], e)


# ──────────────────────────────────────────────
# JOB RECOVERY (Bug B fix — periodic auto-reconciliation of stuck jobs)
# ──────────────────────────────────────────────


@celery_app.task(
    name="scrapalot.recover_stuck_document_jobs",
    bind=True,
    max_retries=0,  # idempotent — next beat tick retries naturally
    soft_time_limit=600,  # 10 min — should never take more than seconds
    time_limit=900,
    queue="documents",
)
def recover_stuck_document_jobs_task(self, max_age_hours: float = 2, dry_run: bool = False) -> dict:
    """
    Periodic job-state reconciler. Runs every 30 min via Celery beat.

    For each document with status='pending' whose latest job is either
    `processing` (older than `max_age_hours`) or `completed` (the
    Bug A split-transaction case), check whether the actual processing
    artifacts (pgvector embeddings + Neo4j Book) exist:

      * artifacts present → mark job + document `completed` (recovery)
      * artifacts missing → mark job + document `failed` so the user
        can re-process

    Always releases any stale Redis doc-lock for the affected document
    so the next attempt is not blocked by a dead worker's lock.

    See `service/document/job_recovery_service.py` for the full impl.
    """
    logger.info("recover_stuck_document_jobs: max_age_hours=%.2f dry_run=%s", max_age_hours, dry_run)
    try:
        from src.main.config.database import SessionLocal
        from src.main.service.document.job_recovery_service import JobRecoveryService

        db = SessionLocal()
        try:
            report = JobRecoveryService(db).recover(
                max_age_hours=max_age_hours,
                dry_run=dry_run,
            )
            return report.to_dict()
        finally:
            db.close()
    except Exception as exc:
        logger.exception("recover_stuck_document_jobs failed: %s", exc)
        return {"success": False, "error": str(exc)}


# ──────────────────────────────────────────────
# STANDALONE SUMMARY GENERATION
# ──────────────────────────────────────────────


@celery_app.task(
    name="scrapalot.generate_document_summaries",
    bind=True,
    max_retries=2,
    # Realistic ceiling: large books with 20+ chapters take ~3-5 min each at
    # gpt-4o-mini speeds → 20 min cap, hard 25 min.
    soft_time_limit=1200,
    time_limit=1500,
    queue="fast",
)
def generate_document_summaries_task(self, document_id: str, user_id: str) -> dict:
    """
    Generate chapter + book summaries for a single document, separately
    from the heavy reprocess pipeline.

    Used in two places:

      1. Recovery — when JobRecoveryService promotes a doc to `completed`
         because the chunk + Book artifacts are present, but realises that
         no `document_summaries` rows exist (the worker died between
         entity-pipeline finalisation and the summary phase).
      2. Operator hot-fix — admin gRPC / scripts trigger this directly
         to backfill summaries for a single doc without re-doing the
         hour-long entity pipeline.

    Idempotent: if summaries already exist, the underlying
    `DocumentSummaryService` overwrites and the operation is cheap.
    """
    import asyncio as _aio
    from uuid import UUID

    from src.main.config.database import SessionLocal
    from src.main.service.document.document_summary_service import DocumentSummaryService

    logger.info("generate_document_summaries_task: doc=%s", document_id[:8])
    db = SessionLocal()
    try:
        svc = DocumentSummaryService(db)
        result = _aio.run(
            svc.generate_document_summaries(
                document_id=UUID(document_id),
                user_id=UUID(user_id),
            )
        )
        return {"success": True, "document_id": document_id, **{k: v for k, v in result.items() if k not in {"document_id"}}}
    except SoftTimeLimitExceeded:
        logger.warning("generate_document_summaries_task: soft time limit hit on %s", document_id[:8])
        raise
    except Exception as exc:
        logger.exception("generate_document_summaries_task failed for %s: %s", document_id[:8], exc)
        return {"success": False, "document_id": document_id, "error": str(exc)}
    finally:
        db.close()


# ──────────────────────────────────────────────
# STANDALONE HIERARCHY REBUILD (from chunk metadata)
# ──────────────────────────────────────────────


@celery_app.task(
    name="scrapalot.rebuild_document_hierarchy",
    bind=True,
    max_retries=2,
    # Cheap operation — one ORDER BY query against pgvector + one
    # UPDATE. Cap at 5 min / 7 min hard, generous for outliers.
    soft_time_limit=300,
    time_limit=420,
    queue="fast",
)
def rebuild_document_hierarchy_task(self, document_id: str) -> dict:
    """
    Rebuild the `documents.document_hierarchy` JSONB tree from chunk
    metadata in `langchain_pg_embedding`. Used to fix the historical
    accumulation of completed-but-NULL-hierarchy rows produced by older
    pipeline versions and by recovered docs whose original processing
    crashed before the hierarchy-write step.

    Strictly read-only against Neo4j (does not touch Book/Chapter/Section
    nodes) — chunk metadata in pgvector already carries `chunk_index`,
    `chapter_title`, and `section_heading`, which is everything the
    rebuild needs.
    """
    from uuid import UUID

    from src.main.config.database import SessionLocal
    from src.main.utils.documents.hierarchy import (
        rebuild_hierarchy_from_chunk_metadata,
        store_document_hierarchy,
    )

    logger.info("rebuild_document_hierarchy_task: doc=%s", document_id[:8])
    db = SessionLocal()
    try:
        doc_uuid = UUID(document_id)
        hierarchy = rebuild_hierarchy_from_chunk_metadata(db, doc_uuid)
        if hierarchy is None:
            return {"success": False, "document_id": document_id, "error": "no_chunks"}
        ok = store_document_hierarchy(db, doc_uuid, hierarchy)
        if not ok:
            return {"success": False, "document_id": document_id, "error": "store_failed"}
        return {
            "success": True,
            "document_id": document_id,
            "chapters": len(hierarchy),
            "sections": sum(len(v.get("children", {})) for v in hierarchy.values()),
        }
    except SoftTimeLimitExceeded:
        logger.warning("rebuild_document_hierarchy_task: soft time limit hit on %s", document_id[:8])
        raise
    except Exception as exc:
        logger.exception("rebuild_document_hierarchy_task failed for %s: %s", document_id[:8], exc)
        return {"success": False, "document_id": document_id, "error": str(exc)}
    finally:
        db.close()


# ──────────────────────────────────────────────
# NEO4J HIERARCHY SYNC FROM EXISTING PGVECTOR STATE
# ──────────────────────────────────────────────


@celery_app.task(
    name="scrapalot.sync_document_hierarchy_to_neo4j",
    bind=True,
    max_retries=2,
    # Network-bound MERGE calls against Neo4j; large books with 1000+
    # chunks finish in 30-90 s. 5 min soft / 7 min hard is generous.
    soft_time_limit=300,
    time_limit=420,
    queue="fast",
)
def sync_document_hierarchy_to_neo4j_task(self, document_id: str) -> dict:
    """Sync a fully-chunked doc's hierarchy to Neo4j Book/Chapter/Section.

    Use when pgvector has chunks + JSONB hierarchy but the Neo4j Book node
    is missing — typical for legacy ingests where Neo4j was unreachable
    during the initial upload and the pipeline took the graceful degrade
    path (`force_graph_build=False`).

    Idempotent: `node_factory.bulk_create_document_hierarchy` MERGE-creates
    Workspace/Collection/Book/Chapter/Section/Chunk nodes — safe to re-run.
    Entity extraction is NOT performed here; dispatch
    `scrapalot.extract_entities` separately on the same doc afterwards.

    Neo4j knowledge-graph sync is a hosted-only feature and is not available in
    the Community Edition. The task stays registered so dispatchers don't fail,
    but it is a no-op here — the document remains fully chunked, embedded and
    RAG-searchable in pgvector.
    """
    logger.debug("sync_document_hierarchy_to_neo4j_task skipped (hosted-only) in CE for %s", document_id[:8])
    return {"success": True, "document_id": document_id, "skipped": "hosted_only_in_ce"}


# ──────────────────────────────────────────────
# METADATA ENRICHMENT BACKFILL FOR LEGACY DOCS
# ──────────────────────────────────────────────


@celery_app.task(
    name="scrapalot.backfill_document_metadata",
    bind=True,
    max_retries=2,
    # OpenLibrary + Crossref + identifier scan; bounded by external API
    # timeouts. 3 min soft / 5 min hard covers the typical worst case.
    soft_time_limit=180,
    time_limit=300,
    queue="fast",
)
def backfill_document_metadata_task(self, document_id: str) -> dict:
    """Run OpenLibrary + identifier-based enrichment on an existing doc.

    Use when a legacy ingest landed with a title (from filename parsing) but
    no `extracted_metadata.resolved` block — `document_pipeline._extract_basic_metadata`
    gates the OpenLibrary call behind `if not title:` so any doc whose
    filename produced a usable title skips enrichment entirely.

    Side-effects:
    - Writes/merges `extracted_metadata.identifiers` (DOI/ISBN/PMID/arxiv_id
      scanned from content) and `extracted_metadata.resolved` (OpenLibrary
      hit) when either source returns a confident answer.
    - Backfills `documents.page_count` from `resolved.pages` when present
      and currently NULL.
    - Backfills `documents.word_count` from content split when NULL/0.
    - Leaves existing fields untouched (idempotent: re-running is a no-op
      when metadata is already populated).
    """
    import json
    import re as _re
    from uuid import UUID

    from sqlalchemy import text as sa_text

    from src.main.config.database import SessionLocal

    logger.info("backfill_document_metadata_task: doc=%s", document_id[:8])
    db = SessionLocal()
    try:
        doc_uuid = UUID(document_id)
        row = db.execute(
            sa_text("SELECT filename, title, content, page_count, word_count, extracted_metadata FROM documents WHERE id = :did"),
            {"did": doc_uuid},
        ).fetchone()
        if not row:
            return {"success": False, "document_id": document_id, "error": "doc_not_found"}
        filename, title, content, page_count, word_count, ext_meta = row
        if not filename:
            return {"success": False, "document_id": document_id, "error": "no_filename"}

        current_meta = dict(ext_meta) if isinstance(ext_meta, dict) else {}
        changes = []

        # Identifier scan (DOI/ISBN/PMID/arxiv_id) from first ~30k chars of content
        if "identifiers" not in current_meta or not current_meta.get("identifiers"):
            try:
                from src.main.service.metadata.identifier_extractor import extract_identifiers

                scan_text = (content or "")[:30000]
                idents = extract_identifiers(scan_text, max_pages=2)
                if idents.has_any:
                    current_meta["identifiers"] = {
                        "doi": idents.primary_doi,
                        "isbn": idents.primary_isbn,
                        "pmid": idents.pmids[0] if idents.pmids else None,
                        "arxiv_id": idents.arxiv_ids[0] if idents.arxiv_ids else None,
                    }
                    changes.append(f"identifiers={current_meta['identifiers']}")
            except Exception as exc:
                logger.debug("identifier extraction skipped for %s: %s", document_id[:8], exc)

        # OpenLibrary / Google Books bibliographic resolution is a hosted-only
        # feature absent from the Community Edition. Identifier scan,
        # page_count, publication_year and word_count backfill below still run.
        logger.debug("Bibliographic resolution skipped (hosted-only) in CE for %s", document_id[:8])

        # Persist extracted_metadata if any change
        if changes:
            db.execute(
                sa_text("UPDATE documents SET extracted_metadata = :meta WHERE id = :did"),
                {"meta": json.dumps(current_meta), "did": doc_uuid},
            )

        # Backfill page_count from resolved.pages (numeric only)
        new_pc = None
        if page_count is None:
            resolved = current_meta.get("resolved") or {}
            pages_val = str(resolved.get("pages", "")).strip()
            if _re.fullmatch(r"\d{1,5}", pages_val):
                new_pc = int(pages_val)
                db.execute(
                    sa_text("UPDATE documents SET page_count = :pc WHERE id = :did AND page_count IS NULL"),
                    {"pc": new_pc, "did": doc_uuid},
                )
                changes.append(f"page_count={new_pc}")

        # Backfill publication_year from resolved.year (Google Books / OpenLibrary).
        # Stored as a dedicated indexable column so temporal-graph queries and
        # per-decade filters don't have to parse JSON every row. Loose range check
        # rejects pathological values from bad metadata sources.
        resolved = current_meta.get("resolved") or {}
        year_val = resolved.get("year")
        if year_val is not None:
            try:
                year_int = int(year_val)
                if 1500 <= year_int <= 2100:
                    db.execute(
                        sa_text("UPDATE documents SET publication_year = :py WHERE id = :did AND publication_year IS NULL"),
                        {"py": year_int, "did": doc_uuid},
                    )
                    changes.append(f"publication_year={year_int}")
            except (ValueError, TypeError) as e:
                logger.debug("Could not coerce publication year %r to int: %s", year_val, e)

        # Backfill word_count from content (whitespace split)
        new_wc = None
        if (word_count is None or word_count == 0) and content:
            new_wc = len(content.split())
            db.execute(
                sa_text("UPDATE documents SET word_count = :wc WHERE id = :did AND (word_count IS NULL OR word_count = 0)"),
                {"wc": new_wc, "did": doc_uuid},
            )
            changes.append(f"word_count={new_wc}")

        if changes:
            db.commit()
            logger.info("backfill_document_metadata_task: doc=%s changes=%s", document_id[:8], ", ".join(changes))
        return {
            "success": True,
            "document_id": document_id,
            "changes": changes,
        }
    except SoftTimeLimitExceeded:
        logger.warning("backfill_document_metadata_task: soft time limit on %s", document_id[:8])
        raise
    except Exception as exc:
        logger.exception("backfill_document_metadata_task failed for %s: %s", document_id[:8], exc)
        return {"success": False, "document_id": document_id, "error": str(exc)}
    finally:
        db.close()


# ──────────────────────────────────────────────
# ANNAS ARCHIVE — RESTORE BOOK SOURCE FROM ISBN
# ──────────────────────────────────────────────


@celery_app.task(
    name="scrapalot.restore_book_from_annas",
    bind=True,
    max_retries=1,
    # 5 min covers a typical Annas search + 16 MB download. The actual
    # reprocess work is dispatched as a separate `scrapalot.reprocess_document`
    # task and is NOT counted toward this timeout.
    soft_time_limit=300,
    time_limit=420,
    queue="fast",
)
def restore_book_from_annas_task(self, document_id: str) -> dict:
    """Recover a document's source artifact from Anna's Archive by ISBN.

    Anna's Archive source restoration is a hosted-only feature and is not
    available in the Community Edition. The task stays registered so any
    dispatcher keeps working, but it is a no-op here.
    """
    logger.debug("restore_book_from_annas_task skipped (hosted-only) in CE for %s", document_id[:8])
    return {"success": False, "document_id": document_id, "error": "hosted_only_in_ce"}
