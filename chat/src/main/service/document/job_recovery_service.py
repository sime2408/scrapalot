"""
Job recovery service — reconcile inconsistent document/job state.

Two failure modes accumulate in production over time:

  1. "completed-but-pending"
     A worker successfully ran the entire processing pipeline (chunking,
     embedding, graph integration) and committed `job.status='completed'`
     in one transaction, but crashed (OOM, SIGKILL, container restart)
     before the parent task could commit `documents.processing_status=
     'completed'` in a second transaction. Bug A — fixed in
     `workers/tasks/document_tasks._process_single_in_batch` so future
     runs are atomic, but historical rows are stuck.

  2. "stuck-processing"
     A worker started the pipeline, marked `job.status='processing'`,
     and died mid-flight. Nothing ever moves the job back to a terminal
     state. The 2 h Redis doc-lock TTL means the document cannot be
     re-processed even by hand until the lock expires. Bug B — there
     was a `cleanup_stuck_jobs` helper in `utils/job_utils.py` but it
     had zero callers and would have just marked the row FAILED without
     checking if the work was actually done.

This service implements idempotent recovery with **artifact verification**
— before declaring a job failed, we check whether the actual work (pgvector
embeddings, Neo4j Book node) is on disk. If it is, the only thing missing
is the status flag → mark completed (recovery). If not, the job genuinely
died mid-flight → mark failed so the user can re-process.

Designed to run on a Celery beat schedule (every 30 min) AND on demand
via the admin gRPC `RecoverStuckDocumentJobs`. Both paths share the same
core function, dry_run flag included for the admin operator who wants
to preview the action.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
import logging
from typing import Any

from sqlalchemy import text as sa_text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


# Default age threshold for "stuck" — must be safely larger than the
# soft_time_limit on the Celery task (60 min) so we never tear down a
# legitimately-running long PDF parse. Two hours is the same window as
# the Redis doc-lock TTL (`_DOC_LOCK_TTL`).
DEFAULT_MAX_AGE_HOURS = 2

# Bounded auto-retry. When a worker dies mid-flight without producing
# artifacts the recovery service ALMOST always saw a transient cause —
# CI/CD redeploy, ``docker restart``, host SIGKILL — that resolves on a
# second attempt. We give every doc one free retry before falling back
# to the historic ``processing_status='failed'`` + ``errorWorkerDied``
# path. Pinned at 1 because retry-storming a doc that consistently
# crashes (OOM on a giant PDF, parser bug on malformed input) burns
# worker slots and LLM tokens for zero gain. ``documents.process_retry_count``
# stores how many retries a single doc has consumed.
MAX_AUTO_RETRIES = 1


@dataclass
class RecoveryReport:
    """Per-run summary returned to the caller (admin gRPC + Celery)."""

    inspected: int = 0
    recovered: int = 0  # had artifacts → marked completed
    failed: int = 0  # no artifacts AND retry budget exhausted → marked failed
    retried: int = 0  # no artifacts AND retry budget left → reprocess dispatched
    still_processing: int = 0  # too young, left alone
    locks_released: int = 0
    summaries_dispatched: int = 0  # recovered docs missing summaries → fast-queue dispatch
    hierarchies_dispatched: int = 0  # recovered docs missing document_hierarchy → fast-queue dispatch
    # Separate counters for entity_extraction jobs
    # so the operator can see at a glance which lane reclaimed which work.
    entity_extraction_inspected: int = 0
    entity_extraction_recovered: int = 0  # entities present in Neo4j → mark Job completed
    entity_extraction_failed: int = 0  # heartbeat dead AND entities missing → mark Job failed
    dry_run: bool = False
    sample_recovered: list[dict[str, Any]] = field(default_factory=list)
    sample_failed: list[dict[str, Any]] = field(default_factory=list)
    sample_retried: list[dict[str, Any]] = field(default_factory=list)
    sample_entity_extraction: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "inspected": self.inspected,
            "recovered": self.recovered,
            "failed": self.failed,
            "retried": self.retried,
            "still_processing": self.still_processing,
            "locks_released": self.locks_released,
            "summaries_dispatched": self.summaries_dispatched,
            "hierarchies_dispatched": self.hierarchies_dispatched,
            "entity_extraction_inspected": self.entity_extraction_inspected,
            "entity_extraction_recovered": self.entity_extraction_recovered,
            "entity_extraction_failed": self.entity_extraction_failed,
            "dry_run": self.dry_run,
            "sample_recovered": self.sample_recovered,
            "sample_failed": self.sample_failed,
            "sample_retried": self.sample_retried,
            "sample_entity_extraction": self.sample_entity_extraction,
        }


class JobRecoveryService:
    """Reconcile inconsistent document/job state. Safe to run repeatedly."""

    def __init__(self, db: Session) -> None:
        self.db = db

    # ──────────────────────────────────────────────────────────────────
    # Entry point
    # ──────────────────────────────────────────────────────────────────

    def recover(
        self,
        max_age_hours: float = DEFAULT_MAX_AGE_HOURS,
        collection_id: str | None = None,
        dry_run: bool = False,
        sample_size: int = 10,
    ) -> RecoveryReport:
        """
        Find and reconcile stuck document jobs.

        Args:
            max_age_hours: Jobs in `processing` status younger than this
                are considered legitimately running and left alone.
            collection_id: Limit recovery to a single collection. None
                processes the whole database.
            dry_run: If True, report what WOULD be done without writing.
            sample_size: How many doc IDs to include in the report's
                `sample_*` arrays for the operator to spot-check.
        """
        report = RecoveryReport(dry_run=dry_run)
        cutoff = datetime.now(UTC) - timedelta(hours=max_age_hours)

        candidates = list(self._find_candidates(cutoff, collection_id))
        report.inspected = len(candidates)
        logger.info(
            "JobRecovery: %d candidates to reconcile (cutoff=%s, collection=%s, dry_run=%s)",
            len(candidates),
            cutoff.isoformat(),
            collection_id,
            dry_run,
        )

        for cand in candidates:
            doc_id = cand["doc_id"]
            job_id = cand["job_id"]
            job_status = cand["job_status"]
            updated_at = cand["job_updated_at"]
            lock_already_handled = False

            # If a Celery worker is actively processing this document right
            # now, don't touch it — `_artifacts_present` returns True as soon
            # as chunks + Book node are persisted, but entity extraction
            # and link rebuild may still be running silently
            # afterwards (no progress updates → job.updated_at stops being
            # touched → falls under the cutoff). Premature recovery marks
            # the doc completed and the in-flight entity-extraction task gets revoked
            # by the next beat.
            if self._is_task_active_in_celery(doc_id):
                report.still_processing += 1
                continue

            has_work = self._artifacts_present(doc_id)

            if has_work:
                # Pipeline finished, only the flag is missing — recover.
                if not dry_run:
                    self._mark_completed(doc_id, job_id)

                # The split-transaction pattern that produces "completed-but-
                # pending" rows often kills the worker between the entity
                # pipeline and the (separate) summary phase. Artifacts =
                # chunks + Book → recovery promotes the doc to `completed`,
                # but `document_summaries` is still empty and the user sees
                # a doc with no chapter or book summary. Detect that here
                # and queue a stand-alone summary task on the `fast` queue
                # so the next user-visible read has them.
                if not dry_run and not self._summaries_present(doc_id):
                    user_id = cand.get("user_id") or self._lookup_doc_user_id(doc_id)
                    if user_id and self._dispatch_summary_task(doc_id, user_id):
                        report.summaries_dispatched += 1

                # The same split-transaction window that loses summaries
                # often loses the document_hierarchy JSONB write too —
                # `_create_document_hierarchy` in documents.py runs after
                # graph build, and a worker crash between graph and that
                # write leaves `documents.document_hierarchy = NULL`.
                # The standalone rebuild task reads chunk metadata
                # (which already carries chapter_title / section_heading)
                # and writes the JSONB tree without re-running entity
                # extraction.
                if not dry_run and not self._hierarchy_present(doc_id) and self._eligible_for_hierarchy(doc_id):
                    if self._dispatch_hierarchy_rebuild_task(doc_id):
                        report.hierarchies_dispatched += 1

                report.recovered += 1
                if len(report.sample_recovered) < sample_size:
                    report.sample_recovered.append(
                        {
                            "doc_id": doc_id,
                            "job_id": job_id,
                            "job_status_before": job_status,
                            "updated_at": str(updated_at) if updated_at else None,
                        }
                    )
            else:
                # No artifacts → genuinely died mid-flight.
                # Bounded auto-retry: if the doc still has retry budget AND
                # we know who owns it, dispatch a fresh ``scrapalot.reprocess_document``
                # task and leave it as ``pending`` for the next worker run.
                # Otherwise (budget exhausted or attribution missing) fall
                # through to the historic mark-failed path so the user sees
                # the doc and can manually re-process.
                retry_count = int(cand.get("retry_count") or 0)
                user_id = cand.get("user_id") or self._lookup_doc_user_id(doc_id)
                collection_id = cand.get("collection_id")

                if retry_count < MAX_AUTO_RETRIES and user_id and collection_id:
                    if not dry_run:
                        retried = self._auto_retry(
                            doc_id=doc_id,
                            job_id=job_id,
                            user_id=user_id,
                            collection_id=collection_id,
                            current_retry_count=retry_count,
                        )
                    else:
                        retried = True
                    if retried:
                        report.retried += 1
                        # ``_auto_retry`` released the stale lock as part of
                        # the dispatch handshake — don't double-release.
                        lock_already_handled = True
                        if len(report.sample_retried) < sample_size:
                            report.sample_retried.append(
                                {
                                    "doc_id": doc_id,
                                    "job_id": job_id,
                                    "job_status_before": job_status,
                                    "updated_at": str(updated_at) if updated_at else None,
                                    "retry_attempt": retry_count + 1,
                                }
                            )
                    else:
                        # Dispatch failed (broker outage, etc.) — fall through
                        # to mark-failed so the doc surfaces in the UI.
                        if not dry_run:
                            self._mark_failed(doc_id, job_id, reason="errorWorkerDied")
                        report.failed += 1
                        if len(report.sample_failed) < sample_size:
                            report.sample_failed.append(
                                {
                                    "doc_id": doc_id,
                                    "job_id": job_id,
                                    "job_status_before": job_status,
                                    "updated_at": str(updated_at) if updated_at else None,
                                }
                            )
                else:
                    # CLAUDE.md rule #3: status code, never English.
                    # Frontend translates via knowledge.uploader.<code>.
                    if not dry_run:
                        self._mark_failed(doc_id, job_id, reason="errorWorkerDied")
                    report.failed += 1
                    if len(report.sample_failed) < sample_size:
                        report.sample_failed.append(
                            {
                                "doc_id": doc_id,
                                "job_id": job_id,
                                "job_status_before": job_status,
                                "updated_at": str(updated_at) if updated_at else None,
                                "retry_count": retry_count,
                            }
                        )

            # Whether recovered OR failed, the doc lock must go so the
            # next process / reprocess attempt is not blocked by a stale
            # Redis lock from the dead worker. Auto-retry already released
            # the lock before dispatching, so skip in that case to avoid
            # racing with the freshly-acquired lock.
            if not dry_run and not lock_already_handled:
                if self._release_lock(doc_id):
                    report.locks_released += 1

        # Reconcile stuck entity_extraction jobs
        # alongside the main document_processing pass. Different table
        # constraints (entity_extraction runs on completed docs) require a
        # separate query path; recovery action is intentionally minimal
        # (mark Job terminal, no auto-redispatch) — the user re-triggers
        # from the UI when Neo4j / LLM provider is healthy again.
        # `collection_id` isn't honoured here: entity_extraction jobs span
        # the whole workspace and the SQL doesn't join `documents` so we
        # cannot filter without an extra round-trip.
        entity_candidates = list(self._find_entity_extraction_candidates(cutoff))
        if entity_candidates:
            self._reconcile_entity_extraction(entity_candidates, report, dry_run, sample_size)

        if not dry_run:
            self.db.commit()

        # How many jobs are still legitimately running (younger than cutoff)?
        report.still_processing = self._count_active(cutoff, collection_id)

        logger.info(
            "JobRecovery: inspected=%d recovered=%d retried=%d failed=%d still_processing=%d locks_released=%d summaries_dispatched=%d hierarchies_dispatched=%d ee_inspected=%d ee_recovered=%d ee_failed=%d dry_run=%s",
            report.inspected,
            report.recovered,
            report.retried,
            report.failed,
            report.still_processing,
            report.locks_released,
            report.summaries_dispatched,
            report.hierarchies_dispatched,
            report.entity_extraction_inspected,
            report.entity_extraction_recovered,
            report.entity_extraction_failed,
            dry_run,
        )
        return report

    # ──────────────────────────────────────────────────────────────────
    # Internals
    # ──────────────────────────────────────────────────────────────────

    def _find_candidates(self, cutoff: datetime, collection_id: str | None) -> Iterable[dict[str, Any]]:
        """Find documents where the running task is stuck OR finished without
        flipping ``documents.processing_status='completed'``.

        Two complementary patterns (heartbeat + restored
        post-review Pattern B artifact fast path):

        **Pattern A — heartbeat-driven**
          ``job.status='processing'``. Liveness via ``jobs.heartbeat_counter``;
          the running task's daemon thread bumps it every 30 s.

            * counter advanced since snapshot → alive, refresh, skip
            * counter idle but ``last_heartbeat_time >= cutoff`` → still
              within tolerance, leave alone
            * counter idle AND ``last_heartbeat_time < cutoff`` → stuck
              → recovery candidate

          First observation (``last_heartbeat_time IS NULL``) seeds the
          snapshot without invalidating.

        **Pattern B — artifact-verified split-tx fast path (RESTORED)**
          ``job.status='completed' AND documents.processing_status='pending'
          AND documents.updated_at < cutoff``. The pipeline wrote chunks
          + hierarchy + flipped the Job row to ``completed`` in one
          transaction, but the parent task crashed before flipping
          ``documents.processing_status='completed'`` in a second
          transaction. Originally documented as "Bug A".

          The ``documents.updated_at < cutoff`` gate avoids racing fresh
          Cat-I dispatches (which set ``processing_status='pending'`` with
          ``updated_at = NOW()``).

          Pattern B is a FAST PATH — recovery happens on the very next
          beat cycle after the gate clears (no heartbeat-cutoff wait).
          ``_artifacts_present`` verification at the caller is the
          correctness guard.

        We pick the LATEST job per document via ``DISTINCT ON
        (document_id)`` so a doc with multiple historical attempts is
        reconciled exactly once.

        Side effect: writes to ``jobs`` when Pattern A observes an
        advanced counter — refreshes the snapshot. Pattern B does no
        writes here (recovery decision happens at the caller after the
        artifact check).
        """
        params: dict[str, Any] = {"cutoff": cutoff}
        coll_clause = ""
        if collection_id:
            coll_clause = "AND d.collection_id = CAST(:collection_id AS uuid)"
            params["collection_id"] = collection_id

        # Step 1: pull all candidate rows. Two predicates combined —
        # Pattern A (status='processing', heartbeat liveness) + Pattern B
        # (status='completed' AND doc.updated_at < cutoff). Per-row dispatch
        # below routes each row through the correct branch.
        rows = (
            self.db.execute(
                sa_text(f"""
                SELECT DISTINCT ON (j.document_id)
                       j.document_id::text       AS doc_id,
                       j.job_id::text            AS job_id,
                       j.status                  AS job_status,
                       j.updated_at              AS job_updated_at,
                       j.heartbeat_counter       AS heartbeat_counter,
                       j.last_heartbeat_value    AS last_heartbeat_value,
                       j.last_heartbeat_time     AS last_heartbeat_time,
                       j.user_id::text           AS user_id,
                       d.collection_id::text     AS collection_id,
                       d.process_retry_count     AS retry_count,
                       d.updated_at              AS doc_updated_at
                FROM jobs j
                JOIN documents d ON d.id::text = j.document_id::text
                WHERE d.deleted_at IS NULL
                  AND d.processing_status = 'pending'
                  AND j.job_type = 'document_processing'
                  AND (
                        j.status = 'processing'
                        OR (j.status = 'completed' AND d.updated_at < :cutoff)
                  )
                  {coll_clause}
                ORDER BY j.document_id, j.updated_at DESC
            """),
                params,
            )
            .mappings()
            .all()
        )

        # Step 2: per-row branch (Pattern A heartbeat vs Pattern B artifact).
        candidates: list[dict[str, Any]] = []
        now_utc = datetime.now(UTC)
        for r in rows:
            row = dict(r)
            job_status = row["job_status"]

            # ── Pattern B: completed-but-pending fast path ─────────────
            # No heartbeat semantics — the task is gone (job.status=
            # 'completed'). Surface as candidate; caller's
            # _artifacts_present verifies chunks + Book exist before
            # promoting doc via _mark_completed.
            if job_status == "completed":
                candidates.append(row)
                continue

            # ── Pattern A: heartbeat liveness for processing jobs ──────
            counter = row["heartbeat_counter"] or 0
            last_value = row["last_heartbeat_value"]
            last_time = row["last_heartbeat_time"]

            # First observation: snapshot, do NOT invalidate.
            if last_time is None:
                self.db.execute(
                    sa_text("UPDATE jobs SET last_heartbeat_value = :v, last_heartbeat_time = :t WHERE job_id = :jid"),
                    {"v": counter, "t": now_utc, "jid": row["job_id"]},
                )
                self.db.commit()
                continue

            # Counter advanced → alive, refresh snapshot, skip.
            if counter > (last_value or 0):
                self.db.execute(
                    sa_text("UPDATE jobs SET last_heartbeat_value = :v, last_heartbeat_time = :t WHERE job_id = :jid"),
                    {"v": counter, "t": now_utc, "jid": row["job_id"]},
                )
                self.db.commit()
                continue

            # Counter idle. Still within cutoff window → wait.
            if last_time >= cutoff:
                continue

            # Counter idle past cutoff → stuck, recovery candidate.
            candidates.append(row)

        return candidates

    @staticmethod
    def _is_task_active_in_celery(doc_id: str) -> bool:
        """
        Return True if a Celery worker is currently processing a task whose
        kwargs reference this document_id. Used to keep recovery from
        clobbering tasks that ARE running but have stopped updating
        `job.updated_at` (e.g. silent entity-extraction).

        Defensive: any inspect failure (broker unreachable, no workers
        replying within the timeout) returns False so the existing
        artifact check still runs — preserving behaviour when the broker
        is down rather than freezing recovery.
        """
        try:
            from src.main.workers.celery_app import celery_app

            inspector = celery_app.control.inspect(timeout=2)
            active_map = inspector.active() or {}
            for worker_tasks in active_map.values():
                for task in worker_tasks:
                    kwargs = task.get("kwargs") or {}
                    if kwargs.get("document_id") == doc_id:
                        return True
        except Exception as exc:
            logger.debug(
                "JobRecovery: Celery inspect failed for %s, falling through: %s",
                doc_id,
                exc,
            )
        return False

    def _find_entity_extraction_candidates(self, cutoff: datetime) -> Iterable[dict[str, Any]]:
        """Find stuck entity_extraction jobs.

        The extract_entities tasks register their own
        jobs row (job_type='entity_extraction') with the
        same heartbeat shape as document_processing — but they run on
        documents whose ``processing_status`` is already ``'completed'``
        (the doc itself is fine; only its graph layer is being rebuilt).
        The original `_find_candidates` query filters on
        ``processing_status='pending'`` which by definition excludes
        these — hence this separate query.

        Criteria:
          - ``j.job_type = 'entity_extraction'``
          - ``j.status = 'processing'`` (live, not already terminal)
          - heartbeat idle past cutoff (counter not advanced since
            ``last_heartbeat_time``, AND ``last_heartbeat_time < cutoff``)

        Returns candidate rows for `_reconcile_entity_extraction` to act
        on. Same first-observation-snapshot pattern as the main path.
        """
        params: dict[str, Any] = {"cutoff": cutoff}
        rows = (
            self.db.execute(
                sa_text("""
                SELECT j.job_id::text            AS job_id,
                       j.document_id::text       AS doc_id,
                       j.status                  AS job_status,
                       j.updated_at              AS job_updated_at,
                       j.heartbeat_counter       AS heartbeat_counter,
                       j.last_heartbeat_value    AS last_heartbeat_value,
                       j.last_heartbeat_time     AS last_heartbeat_time,
                       j.user_id::text           AS user_id
                FROM jobs j
                WHERE j.job_type = 'entity_extraction'
                  AND j.status = 'processing'
            """),
                params,
            )
            .mappings()
            .all()
        )

        candidates: list[dict[str, Any]] = []
        now_utc = datetime.now(UTC)
        for r in rows:
            row = dict(r)
            counter = row["heartbeat_counter"] or 0
            last_value = row["last_heartbeat_value"]
            last_time = row["last_heartbeat_time"]

            # First observation: snapshot, do NOT invalidate.
            if last_time is None:
                self.db.execute(
                    sa_text("UPDATE jobs SET last_heartbeat_value = :v, last_heartbeat_time = :t WHERE job_id = :jid"),
                    {"v": counter, "t": now_utc, "jid": row["job_id"]},
                )
                self.db.commit()
                continue

            # Counter advanced → alive, refresh snapshot, skip.
            if counter > (last_value or 0):
                self.db.execute(
                    sa_text("UPDATE jobs SET last_heartbeat_value = :v, last_heartbeat_time = :t WHERE job_id = :jid"),
                    {"v": counter, "t": now_utc, "jid": row["job_id"]},
                )
                self.db.commit()
                continue

            # Counter idle. Still within cutoff window → wait.
            if last_time >= cutoff:
                continue

            # Counter idle past cutoff → stuck, recovery candidate.
            candidates.append(row)

        return candidates

    def _reconcile_entity_extraction(self, candidates: list[dict[str, Any]], report: RecoveryReport, dry_run: bool, sample_size: int) -> None:
        """Reconcile stuck entity_extraction jobs.

        For each candidate:
          - If task is still active in Celery → leave alone (heartbeat
            thread can hang while the inner LLM/Neo4j work continues —
            same defensive pattern as document_processing recovery).
          - If `_entities_present` (Neo4j Book has any MENTIONS) → mark
            Job completed. Assume the task crashed AFTER doing the work
            but before flipping its own status.
          - Else → mark Job failed with errorEntityExtractionStuck.
            User can re-trigger from UI; we don't auto-redispatch yet
            (different failure modes have different cures: Neo4j OOM
            wants operator action, transient blip wants retry, LLM
            quota wants new key).
        """
        for cand in candidates:
            doc_id = cand["doc_id"]
            job_id = cand["job_id"]
            report.entity_extraction_inspected += 1

            if self._is_task_active_in_celery(doc_id):
                # Active task, leave it alone — heartbeat thread may just be
                # blocked on a long LLM call.
                continue

            entities_present = self._entities_present(doc_id)
            if entities_present:
                if not dry_run:
                    self._mark_job_terminal(job_id, "completed")
                report.entity_extraction_recovered += 1
                outcome = "recovered"
            else:
                if not dry_run:
                    self._mark_job_terminal(job_id, "failed", error="errorEntityExtractionStuck")
                report.entity_extraction_failed += 1
                outcome = "failed"

            if len(report.sample_entity_extraction) < sample_size:
                report.sample_entity_extraction.append(
                    {
                        "doc_id": doc_id,
                        "job_id": job_id,
                        "outcome": outcome,
                        "updated_at": str(cand.get("job_updated_at")) if cand.get("job_updated_at") else None,
                    }
                )

    def _entities_present(self, doc_id: str) -> bool:
        """True iff this doc has at least one Book→MENTIONS→Entity edge in
        Neo4j. Cheap probe (COUNT LIMIT 1) — bounded by Neo4j outage
        timeout from the singleton; on failure we return False so the
        caller marks the Job failed rather than spuriously completed.

        Wrapped in `run_with_reconnect` so a transient blip during
        recovery self-heals — same rationale as `_artifacts_present`."""
        try:
            from src.main.service.graph.neo4j_service import get_neo4j_service

            neo4j = get_neo4j_service()

            def _probe() -> int:
                with neo4j.session() as s:
                    row = s.run(
                        "MATCH (b:Book {document_id: $id})-[:MENTIONS]->(e) RETURN count(e) AS c LIMIT 1",
                        id=doc_id,
                    ).single()
                    return int(row["c"]) if row else 0

            count = neo4j.run_with_reconnect(_probe)
            return count > 0
        except Exception as exc:
            logger.warning("JobRecovery: Neo4j entities check failed for %s, treating as missing: %s", doc_id, exc)
            return False

    def _mark_job_terminal(self, job_id: str, status: str, error: str | None = None) -> None:
        """Flip a jobs row to completed/failed. Mirror of the
        `extract_entities_task._finalize_jobs_row` helper but reachable
        from the recovery service without importing the task module."""
        try:
            params: dict[str, Any] = {"jid": job_id, "status": status}
            sql = "UPDATE jobs SET status = :status, updated_at = NOW()"
            if status == "completed":
                sql += ", progress = 100, completed_at = NOW()"
            if error:
                sql += ", error_message = :err"
                params["err"] = error[:500]
            sql += " WHERE job_id = :jid"
            self.db.execute(sa_text(sql), params)
            self.db.commit()
        except Exception:
            logger.exception("JobRecovery: failed to mark job %s as %s", job_id, status)

    def _count_active(self, cutoff: datetime, collection_id: str | None) -> int:
        """Jobs still legitimately running (younger than cutoff)."""
        params: dict[str, Any] = {"cutoff": cutoff}
        coll_clause = ""
        if collection_id:
            coll_clause = "AND d.collection_id = CAST(:collection_id AS uuid)"
            params["collection_id"] = collection_id
        return int(
            self.db.execute(
                sa_text(f"""
                SELECT COUNT(DISTINCT j.document_id)
                FROM jobs j
                JOIN documents d ON d.id::text = j.document_id::text
                WHERE d.deleted_at IS NULL
                  AND d.processing_status = 'pending'
                  AND j.status = 'processing'
                  AND j.updated_at >= :cutoff
                  {coll_clause}
            """),
                params,
            ).scalar()
            or 0
        )

    def _artifacts_present(self, doc_id: str) -> bool:
        """
        Returns True iff BOTH the pgvector embeddings AND the Neo4j Book
        node exist for this document. We require both because each is
        the natural terminal output of one of the two pipeline halves
        (chunking → embeddings, graph integration → Book + hierarchy).
        Half-finished work means re-process, not recovery.
        """
        # pgvector
        emb_count = int(
            self.db.execute(
                sa_text("""
                SELECT COUNT(*) FROM langchain_pg_embedding
                WHERE (cmetadata->>'document_id')::uuid = CAST(:doc_id AS uuid)
            """),
                {"doc_id": doc_id},
            ).scalar()
            or 0
        )
        if emb_count == 0:
            return False

        # Neo4j Book node — wrap in try so a Neo4j outage does not
        # downgrade an otherwise-recoverable doc into "failed". Phase
        # 5-B follow-up: use `run_with_reconnect` so a transient blip
        # during recovery self-heals instead of misclassifying the
        # artifact as missing.
        try:
            from src.main.service.graph.neo4j_service import get_neo4j_service

            neo4j = get_neo4j_service()

            def _probe() -> int:
                with neo4j.session() as s:
                    row = s.run(
                        "MATCH (b:Book {document_id: $id}) RETURN count(b) AS c",
                        id=doc_id,
                    ).single()
                    return int(row["c"]) if row else 0

            book_count = neo4j.run_with_reconnect(_probe)
        except Exception as exc:
            logger.warning("JobRecovery: Neo4j check failed for %s, treating as missing: %s", doc_id, exc)
            return False

        return book_count > 0

    def _mark_completed(self, doc_id: str, job_id: str) -> None:
        """Promote both job and document to `completed` in one statement
        each (separate UPDATEEs are fine — they share the outer commit).
        ``process_retry_count`` is reset to 0 so the auto-retry budget
        reflects "consecutive failures since last success", not lifetime
        retries — otherwise a doc that auto-retried once and finally
        succeeded would carry `1` forever and the next stuck-job episode
        would skip the retry it deserves."""
        self.db.execute(
            sa_text("""
                UPDATE documents
                SET processing_status = 'completed',
                    processing_error = NULL,
                    process_retry_count = 0,
                    updated_at = NOW()
                WHERE id = CAST(:doc_id AS uuid)
            """),
            {"doc_id": doc_id},
        )
        self.db.execute(
            sa_text("""
                UPDATE jobs
                SET status = 'completed',
                    progress = 100.0,
                    description = COALESCE(description, '') ||
                                  ' [recovered by JobRecoveryService]',
                    completed_at = COALESCE(completed_at, NOW()),
                    updated_at = NOW()
                WHERE job_id = :job_id
            """),
            {"job_id": job_id},
        )

    def _mark_failed(self, doc_id: str, job_id: str, reason: str) -> None:
        """Promote both job and document to `failed` so the operator can
        re-process. The original failure cause may be untraceable so we
        write the recovery reason."""
        self.db.execute(
            sa_text("""
                UPDATE documents
                SET processing_status = 'failed',
                    processing_error = :reason,
                    updated_at = NOW()
                WHERE id = CAST(:doc_id AS uuid)
            """),
            {"doc_id": doc_id, "reason": reason[:500]},
        )
        self.db.execute(
            sa_text("""
                UPDATE jobs
                SET status = 'failed',
                    description = :reason,
                    error_message = :reason,
                    completed_at = COALESCE(completed_at, NOW()),
                    updated_at = NOW()
                WHERE job_id = :job_id
            """),
            {"job_id": job_id, "reason": reason},
        )

    def _summaries_present(self, doc_id: str) -> bool:
        """True iff at least one row in `document_summaries` exists for the
        doc. We don't insist on chapter+book — even a single chapter row
        means the summary phase ran far enough; partial summaries are
        idempotently overwritten on the next dispatch.
        """
        return bool(
            self.db.execute(
                sa_text("SELECT 1 FROM document_summaries WHERE document_id = CAST(:doc_id AS uuid) LIMIT 1"),
                {"doc_id": doc_id},
            ).scalar()
        )

    def _lookup_doc_user_id(self, doc_id: str) -> str | None:
        """Fallback when the jobs row predates the user_id column or stores
        NULL. Looks at the most recent non-null `user_id` we can find for
        this document across the jobs table; returns None if every prior
        attempt was system-owned (which means we have no user to attribute
        the summary to anyway).
        """
        row = self.db.execute(
            sa_text(
                "SELECT user_id::text FROM jobs WHERE document_id = CAST(:doc_id AS uuid) AND user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
            ),
            {"doc_id": doc_id},
        ).scalar()
        return row

    @staticmethod
    def _dispatch_summary_task(doc_id: str, user_id: str) -> bool:
        """Queue `scrapalot.generate_document_summaries` on the `fast` queue.

        Uses ``safe_send_task`` for triple-defense dispatch
        (queue-depth backpressure + NX guard + ``expires=``). Prevents
        duplicate summary backfill if two beat cycles overlap or if the
        previous summary task is still queued but not yet picked up.
        """
        try:
            from src.main.workers.utils.dispatch_guards import safe_send_task

            task_id = safe_send_task(
                "scrapalot.generate_document_summaries",
                queue="fast",
                doc_id=doc_id,
                action="summary_backfill",
                kwargs={"document_id": doc_id, "user_id": user_id},
            )
            if not task_id:
                logger.debug("JobRecovery: summary dispatch refused (guard/depth) for %s", doc_id)
                return False
            logger.info(
                "JobRecovery: dispatched summary backfill for %s (user=%s, task=%s)",
                doc_id,
                user_id,
                task_id[:8],
            )
            return True
        except Exception as exc:
            logger.warning(
                "JobRecovery: summary dispatch failed for %s: %s",
                doc_id,
                exc,
            )
            return False

    def _hierarchy_present(self, doc_id: str) -> bool:
        """True iff `documents.document_hierarchy` holds a real tree.

        We treat the `{"status": "created", ...}` metadata-only fallback
        (written by `documents.py:2054` when node_factory returned an
        empty `_hierarchy_structure`) as MISSING — those rows have no
        chapter_range data and the summary service can't use them.
        """
        row = self.db.execute(
            sa_text(
                "SELECT document_hierarchy IS NOT NULL "
                "  AND document_hierarchy != '{}'::jsonb "
                "  AND NOT (document_hierarchy ? 'status' AND NOT (document_hierarchy ? 'children')) "
                "FROM documents WHERE id = CAST(:doc_id AS uuid)"
            ),
            {"doc_id": doc_id},
        ).scalar()
        return bool(row)

    def _eligible_for_hierarchy(self, doc_id: str) -> bool:
        """True iff there is enough chunk data to build a meaningful
        hierarchy. Mirrors the `< 2 distinct chunk indices` guard in
        `rebuild_hierarchy_from_chunk_metadata` so we don't fire a
        Celery dispatch that the rebuild task will then refuse.

        OCR-deferred docs (`errorScannedPdfOcrDeferred`) have one
        placeholder chunk and would otherwise produce the meaningless
        `{"Introduction": {"children": {"Section 1": [0, 0]}}}` shape
        the user flagged in production today.
        """
        n = (
            self.db.execute(
                sa_text(
                    """
                    SELECT COUNT(DISTINCT (cmetadata->>'chunk_index'))
                    FROM langchain_pg_embedding
                    WHERE cmetadata->>'document_id' = :doc_id
                    """
                ),
                {"doc_id": doc_id},
            ).scalar()
            or 0
        )
        return int(n) >= 2

    @staticmethod
    def _dispatch_hierarchy_rebuild_task(doc_id: str) -> bool:
        """Queue `scrapalot.rebuild_document_hierarchy` on the `fast` queue.

        Triple-defense dispatch via ``safe_send_task``.
        """
        try:
            from src.main.workers.utils.dispatch_guards import safe_send_task

            task_id = safe_send_task(
                "scrapalot.rebuild_document_hierarchy",
                queue="fast",
                doc_id=doc_id,
                action="hierarchy_rebuild",
                kwargs={"document_id": doc_id},
            )
            if not task_id:
                logger.debug("JobRecovery: hierarchy dispatch refused (guard/depth) for %s", doc_id)
                return False
            logger.info("JobRecovery: dispatched hierarchy rebuild for %s (task=%s)", doc_id, task_id[:8])
            return True
        except Exception as exc:
            logger.warning(
                "JobRecovery: hierarchy rebuild dispatch failed for %s: %s",
                doc_id,
                exc,
            )
            return False

    def _auto_retry(
        self,
        *,
        doc_id: str,
        job_id: str,
        user_id: str,
        collection_id: str,
        current_retry_count: int,
    ) -> bool:
        """
        Bounded auto-retry path: increment ``process_retry_count``, mark the
        zombie job as failed (paper trail with reason ``errorWorkerDiedAutoRetry``
        so audit logs can distinguish "user reprocessed" from "recovery
        retried"), drop the stale Redis lock, and dispatch a fresh
        ``scrapalot.reprocess_document`` Celery task. Document remains in
        ``processing_status='pending'`` so the user sees no terminal failure.

        Returns True iff the dispatch succeeded. The DB writes are committed
        as part of the outer ``recover()`` commit.
        """
        # Mark zombie job failed with a distinct reason so it doesn't keep
        # getting picked up by ``_find_candidates`` on the next beat tick
        # (which only looks at ``status='processing'`` and ``status='completed'``).
        self.db.execute(
            sa_text("""
                UPDATE jobs
                SET status = 'failed',
                    description = 'errorWorkerDiedAutoRetry',
                    error_message = 'errorWorkerDiedAutoRetry',
                    completed_at = COALESCE(completed_at, NOW()),
                    updated_at = NOW()
                WHERE job_id = :job_id
            """),
            {"job_id": job_id},
        )
        self.db.execute(
            sa_text("""
                UPDATE documents
                SET process_retry_count = :next_count,
                    processing_progress = 0.0,
                    processing_error = NULL,
                    celery_task_id = NULL,
                    updated_at = NOW()
                WHERE id = CAST(:doc_id AS uuid)
            """),
            {"doc_id": doc_id, "next_count": current_retry_count + 1},
        )

        # Release the dead worker's lock BEFORE dispatching so the new
        # task's ``_acquire_doc_lock`` doesn't bounce off it.
        self._release_lock(doc_id)

        if not self._dispatch_reprocess_task(doc_id=doc_id, collection_id=collection_id, user_id=user_id):
            # Dispatch failed — roll back the retry-count bump so the next
            # beat tick can try again (or fall through to mark-failed if the
            # broker is permanently down).
            self.db.execute(
                sa_text("UPDATE documents SET process_retry_count = :prev WHERE id = CAST(:doc_id AS uuid)"),
                {"doc_id": doc_id, "prev": current_retry_count},
            )
            return False

        logger.info(
            "JobRecovery: auto-retry %d/%d dispatched for doc %s (user=%s, coll=%s)",
            current_retry_count + 1,
            MAX_AUTO_RETRIES,
            doc_id,
            user_id,
            collection_id,
        )
        return True

    @staticmethod
    def _dispatch_reprocess_task(*, doc_id: str, collection_id: str, user_id: str) -> bool:
        """Queue ``scrapalot.reprocess_document`` on the ``documents`` queue.

        Triple-defense dispatch via ``safe_send_task`` closes
        the Pattern A double-dispatch race tail that the heartbeat
        couldn't fully eliminate (window between heartbeat-detected stuck
        + worker actually picking up the new dispatch).

        Defensive: a broker outage must NOT roll the recovery transaction
        back catastrophically — the caller (``_auto_retry``) reverts its
        retry-count bump if dispatch fails.
        """
        try:
            from src.main.workers.utils.dispatch_guards import safe_send_task

            task_id = safe_send_task(
                "scrapalot.reprocess_document",
                queue="documents",
                doc_id=doc_id,
                action="reprocess_recovery",
                kwargs={
                    "document_id": doc_id,
                    "collection_id": collection_id,
                    "user_id": user_id,
                },
            )
            if not task_id:
                logger.info(
                    "JobRecovery: reprocess dispatch refused (guard held or queue full) for doc=%s",
                    doc_id,
                )
                return False
            return True
        except Exception as exc:
            logger.warning(
                "JobRecovery: reprocess dispatch failed for %s: %s",
                doc_id,
                exc,
            )
            return False

    @staticmethod
    def _release_lock(doc_id: str) -> bool:
        """Best-effort release of the Redis doc-lock so the next attempt
        can proceed. Returns True iff a lock actually existed and was
        deleted."""
        try:
            from src.main.utils.redis.client import get_redis_client
            from src.main.workers.tasks.document_tasks import _DOC_LOCK_PREFIX

            return bool(get_redis_client().delete(f"{_DOC_LOCK_PREFIX}{doc_id}"))
        except Exception as exc:
            logger.debug("JobRecovery: lock release failed for %s: %s", doc_id, exc)
            return False
