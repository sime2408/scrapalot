"""
Celery application configuration for scrapalot document processing workers.

Used by BOTH scrapalot-chat (to send tasks) and scrapalot-workers (to execute tasks).
The broker is Redis DB 3 — separate from the app cache (DB 0), Kotlin backend (DB 1),
and gateway (DB 2).
"""

from celery import Celery
from celery.schedules import crontab
from celery.signals import celeryd_init, worker_process_init, worker_ready


@celeryd_init.connect
def _force_spawn_start_method(**_kwargs):
    """Force `multiprocessing.set_start_method("spawn")` for the worker.

    Heavy work runs in `multiprocessing.get_context("spawn")` subprocesses owned by
    a watchdog thread (SubprocessJobClient). Without forcing spawn here,
    bare `mp.Process()` defaults to fork on Linux — and that gives us
    the same inherit-the-whole-Python-heap problem we're trying to
    escape. Mirrors Onyx's app_base.py:244-260.

    Idempotent: catches RuntimeError if start method already set."""
    import logging
    import multiprocessing

    log = logging.getLogger(__name__)
    try:
        multiprocessing.set_start_method("spawn", force=True)
        log.info("celery worker: forced multiprocessing start_method=spawn")
    except RuntimeError as e:
        log.warning("celery worker: set_start_method failed: %s", e)


def _do_unacked_recovery(app, stale_threshold_seconds: int = 7500) -> int:
    """
    Re-queue unacked tasks older than stale_threshold_seconds.

    Called on both the main worker startup (`worker_ready`) AND on each pool
    child fork (`worker_process_init`). The latter is critical because
    `os._exit(1)` from SoftTimeLimitExceeded triggers a billiard child
    replacement, NOT a full worker restart — without child-fork recovery,
    the replaced process inherits the zombie unacked quota and stays idle.
    """
    import json
    import logging
    import time

    log = logging.getLogger(__name__)
    try:
        with app.connection_or_acquire() as conn:
            client = conn.default_channel.client
            idx = client.zrange("unacked_index", 0, -1, withscores=True)
            if not idx:
                return 0

            now = time.time()
            recovered = 0

            for tid_bytes, ts in idx:
                if now - ts < stale_threshold_seconds:
                    continue
                tid = tid_bytes.decode() if isinstance(tid_bytes, bytes) else tid_bytes

                raw = client.hget("unacked", tid)
                if not raw:
                    client.zrem("unacked_index", tid)
                    continue

                try:
                    payload = json.loads(raw)
                    if not isinstance(payload, list) or len(payload) < 4:
                        raise ValueError("unexpected unacked payload shape")
                    body, msg_info, exchange, routing_key = payload[0], payload[1], payload[2], payload[3]
                    client.lpush(routing_key, json.dumps([body, msg_info, exchange, routing_key]))
                except Exception as parse_err:
                    log.warning("Could not parse unacked task %s, deleting: %s", tid[:12], parse_err)

                client.hdel("unacked", tid)
                client.zrem("unacked_index", tid)
                recovered += 1

            if recovered:
                log.warning("Reconciliation: re-queued %d stale unacked tasks", recovered)
            return recovered
    except Exception as e:
        # noinspection PyTypeChecker
        log.exception("Stale unacked recovery failed: %s", e)
        return 0


@worker_ready.connect
def _recover_on_worker_ready(sender, **_kwargs):
    """Full-worker startup: scan unacked once the main process is ready."""
    _do_unacked_recovery(sender.app)


@worker_process_init.connect
def _eager_import_models(**_kwargs):
    """
    Import all SQLModel models at worker-process startup so FK targets
    are registered in MetaData before any task runs.

    Without this, the circular import chain
    (sqlmodel_models → sqlmodel_connectors → sqlmodel_jobs)
    can define Job before Document, causing NoReferencedTableError
    on jobs.document_id → documents.id.

    Also re-runs zombie unacked recovery. This signal fires for every
    forked pool child, including ones billiard spawns after a WorkerLostError
    (e.g., SoftTimeLimitExceeded → os._exit(1)). Without this, replaced
    children inherit the stale prefetch quota and stay idle forever.
    """
    import logging

    from src.main.utils.core.logger import TIMING_LEVEL

    # Celery's ColoredFormatter renders unknown levels between INFO and
    # WARNING as "SUBWARNING". Rebind level 25 to "INFO" inside the worker
    # process so timing-decorator output ("🚀 Starting …", "🕒 Completed …")
    # appears under the familiar INFO label rather than the alarming
    # SUBWARNING. The chat / gRPC container keeps the original "TIMING"
    # label because worker_process_init never fires there.
    logging.addLevelName(TIMING_LEVEL, "INFO")

    import src.main.models.python_only_models
    import src.main.models.sqlmodel_connectors
    import src.main.models.sqlmodel_jobs
    import src.main.models.sqlmodel_models
    import src.main.models.sqlmodel_providers
    import src.main.models.sqlmodel_research  # noqa: F401

    # Only attempt recovery if the app is initialized. On cold start the app
    # import above doesn't trigger recovery — worker_ready will.
    # noinspection PyBroadException
    try:
        # noinspection PyTypeChecker
        _do_unacked_recovery(celery_app)
    except Exception:
        # Never block a worker child process on reconciliation errors.
        pass


def _build_redis_url() -> str:
    """Build Redis URL from config.yaml, falling back to env var or default."""
    # noinspection PyBroadException
    try:
        from src.main.utils.config.loader import resolved_config

        redis_cfg = resolved_config.get("redis", {})
        host = redis_cfg.get("host", "redis")
        port = redis_cfg.get("port", 6379)
        password = redis_cfg.get("password", "")
        if password:
            return f"redis://:{password}@{host}:{port}/3"
        return f"redis://{host}:{port}/3"
    except Exception:
        return "redis://redis:6379/3"


_broker_url = _build_redis_url()
_result_backend = _build_redis_url()

celery_app = Celery("scrapalot")
celery_app.conf.include = [
    "src.main.workers.tasks.entity_extraction_tasks",
    "src.main.workers.tasks.document_tasks",
    "src.main.workers.tasks.paper_generation_tasks",
    "src.main.workers.tasks.podcast_tasks",
    "src.main.workers.tasks.graph_housekeeping_tasks",
    "src.main.workers.tasks.monitoring_tasks",
    "src.main.workers.tasks.research_tasks",
]
celery_app.config_from_object(
    {
        "broker_url": _broker_url,
        "result_backend": _result_backend,
        "task_serializer": "json",
        "result_serializer": "json",
        "accept_content": ["json"],
        # Retry broker connection on startup instead of raising an error immediately
        "broker_connection_retry_on_startup": True,
        # Redis transport: re-queue tasks that have been unacked for longer than visibility_timeout.
        # Prevents zombie unacked tasks when a worker process exits via os._exit(1) or billiard
        # WorkerLostError — Celery doesn't detect sub-process exits reliably, so the task
        # stays unacked and counts toward the prefetch quota, halving throughput.
        #
        # MUST be larger than the largest per-task time_limit, otherwise a still-running
        # legitimate task gets re-delivered to a second worker and the work is duplicated.
        # `reprocess_document` is the upper bound at 11400s (3 h 10 min) — see
        # `workers/tasks/document_tasks.py`. We use 12000s (3 h 20 min) as a safety margin.
        # In production a 90 k-pair CO_OCCURS_WITH task on a single doc went to 2 h 39 min
        # and was re-delivered three times against the previous 7500s ceiling, blowing
        # ~5 h of worker time on duplicated graph writes.
        "broker_transport_options": {"visibility_timeout": 12000},
        # 60-minute hard kill; entity extraction on mega docs (3000+ entities) can take 40-50min
        "task_time_limit": 3600,
        # 55-minute soft limit — raises SoftTimeLimitExceeded so the task can update job status
        "task_soft_time_limit": 3300,
        # Process one task at a time per worker slot (fair distribution, prevents queue starvation)
        "worker_prefetch_multiplier": 1,
        # ACK only after successful completion so crashed workers re-queue the task
        "task_acks_late": True,
        # With the threads pool there are no child forks.
        # `worker_lost` would mean the whole
        # Celery process died — re-queueing into the same broken
        # container creates restart loops. Drop to False.
        "task_reject_on_worker_lost": False,
        # `worker_max_memory_per_child` is REMOVED — irrelevant for the
        # threads pool (no forks to recycle). Memory pressure is now
        # mitigated by `--pool=threads` (single Python process, no COW
        # inheritance) and the spawn subprocess for heavy work.
        "task_routes": {
            "scrapalot.process_document": {"queue": "documents"},
            "scrapalot.process_batch": {"queue": "documents"},
            "scrapalot.reprocess_document": {"queue": "documents"},
            # Stand-alone summary generation — light-weight, runs on `fast`
            # so it can backfill a missed summary without contending with a
            # 3 h reprocess for a worker slot.
            "scrapalot.generate_document_summaries": {"queue": "fast"},
            # Stand-alone hierarchy JSONB rebuild from existing chunk metadata.
            # Reads `langchain_pg_embedding`, writes `documents.document_hierarchy`.
            # Runs on `fast` because it's a single ORDER BY + one UPDATE per doc.
            "scrapalot.rebuild_document_hierarchy": {"queue": "fast"},
            # Annas Archive book restore: search by ISBN + fast_download +
            # disk write + DB metadata reset + dispatch reprocess. Network-
            # bound work (~10-30 s search + 5-20 MB download), fast queue.
            # The downstream reprocess task is dispatched onto `documents`
            # by the service itself.
            "scrapalot.restore_book_from_annas": {"queue": "fast"},
            "scrapalot.celery_beat_heartbeat": {"queue": "fast"},
            # Entity extraction + housekeeping moved
            # onto a dedicated `graph_extraction` queue so slow podcast /
            # paper-generation tasks no longer block fast graph work.
            "scrapalot.extract_entities": {"queue": "graph_extraction"},
            "scrapalot.build_graph_from_existing_chunks": {"queue": "graph_extraction"},
            "scrapalot.link_cross_book_entities": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.sweep_hierarchy": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.merge_duplicates": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.resolve_entity_type_conflicts": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.sweep_orphan_entities": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.recompute_entity_idf": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.recompute_cooccurrence_weights": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.ensure_cooccurrence_weights": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.ensure_pending_graphs_built": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.prune_cooccurrence_edges": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.recompute_pagerank": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.classify_typed_relationships": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.update_collection_fingerprint": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.enrich_collection_summary": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.reconcile_graph_sync_status": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.feedback_weight_decay": {"queue": "graph_extraction"},
            "scrapalot.housekeeping.build_communities": {"queue": "graph_extraction"},
        },
        # Nightly graph housekeeping. Picked up only when the
        # worker is started with `--beat` (single-instance prod) or a dedicated
        # beat sidecar; absent that, the schedule is inert (no harm).
        # All times in UTC. Order chosen so dedup runs first (creates fewer
        # orphans), then hierarchy sweep, then orphan-entity sweep, then IDF
        # recompute reads the cleaned graph state.
        "beat_schedule": {
            "graph-merge-duplicates-nightly": {
                "task": "scrapalot.housekeeping.merge_duplicates",
                "schedule": crontab(hour=3, minute=0),
                "kwargs": {"dry_run": False, "batch_size": 500},
            },
            # Resolve Person/Place/Organization hard-type conflicts by majority
            # vote — runs at 03:10, AFTER merge_duplicates (03:00) so the
            # vote_<Type> tallies are summed onto survivors first.
            "graph-resolve-type-conflicts-nightly": {
                "task": "scrapalot.housekeeping.resolve_entity_type_conflicts",
                "schedule": crontab(hour=3, minute=10),
                "kwargs": {"dry_run": False, "min_total_votes": 3, "dominance": 0.6},
            },
            "graph-sweep-hierarchy-nightly": {
                "task": "scrapalot.housekeeping.sweep_hierarchy",
                "schedule": crontab(hour=3, minute=20),
                "kwargs": {"dry_run": False},
            },
            "graph-sweep-orphan-entities-nightly": {
                "task": "scrapalot.housekeeping.sweep_orphan_entities",
                "schedule": crontab(hour=3, minute=40),
                "kwargs": {"dry_run": False, "created_before_days": 7, "limit": 5000},
            },
            "graph-recompute-entity-idf-nightly": {
                "task": "scrapalot.housekeeping.recompute_entity_idf",
                "schedule": crontab(hour=3, minute=50),
                "kwargs": {"dry_run": False},
            },
            # Nightly CO_OCCURS_WITH weight recompute at 04:00 UTC
            # (AFTER all the cleanup tasks) then pruning at 04:20.
            # Kept conservative (bottom 10%) until an eval re-run in
            # iteration 2 confirms no quality regression.
            "graph-cooccurrence-weight-recompute-nightly": {
                "task": "scrapalot.housekeeping.recompute_cooccurrence_weights",
                "schedule": crontab(hour=4, minute=0),
                "kwargs": {},
            },
            "graph-cooccurrence-prune-nightly": {
                "task": "scrapalot.housekeeping.prune_cooccurrence_edges",
                "schedule": crontab(hour=4, minute=20),
                "kwargs": {"dry_run": False, "percentile": 0.10},
            },
            # Self-healing CO_OCCURS_WITH weight population — every 15 min.
            # Resumes the bulk weight population (only_missing=True) after any
            # worker kill (CI deploy) and gives up after 3 no-progress strikes.
            # `expires` drops a tick that couldn't run within the interval (e.g.
            # queued behind a 30-min recompute) instead of letting watchdogs
            # pile up. Inert until 0 NULL-weight edges remain, then idles.
            "graph-cooccurrence-ensure-weights": {
                "task": "scrapalot.housekeeping.ensure_cooccurrence_weights",
                "schedule": crontab(minute="*/15"),
                "kwargs": {"max_strikes": 3},
                "options": {"expires": 840},
            },
            # Pending-graph backfill driver — every 20 min, builds the Neo4j graph
            # for the next parse-complete doc that has no graph yet (Cat-I restores
            # with skip_graph_build=True, ~600 docs). One build at a time (Redis
            # in-flight marker; graph_extraction is concurrency=1). Idles when no
            # pending-graph docs remain. `expires` drops a tick that couldn't run.
            "graph-ensure-pending-built": {
                "task": "scrapalot.housekeeping.ensure_pending_graphs_built",
                "schedule": crontab(minute="*/20"),
                "kwargs": {"max_concurrent": 2},  # track GRAPH_WORKER_CONCURRENCY
                "options": {"expires": 1080},
            },
            # Full PageRank refresh at 04:40 UTC, AFTER IDF and
            # CO_OCCURS weights land (PageRank uses both).
            "graph-pagerank-nightly": {
                "task": "scrapalot.housekeeping.recompute_pagerank",
                "schedule": crontab(hour=4, minute=40),
                "kwargs": {},  # collection_id=None → full pass
            },
            # Nightly fingerprint refresh at 04:55 UTC
            # (AFTER PageRank — bridge chunk ranking uses pagerank tie-break).
            "graph-collection-fingerprints-nightly": {
                "task": "scrapalot.housekeeping.update_collection_fingerprint",
                "schedule": crontab(hour=4, minute=55),
                "kwargs": {},  # collection_id=None → full pass
            },
            # Collection memory digests — 05:20, after fingerprints (04:55) and
            # community reports (05:10) so book summaries are settled. Full pass
            # rebuilds every collection's description from its book summaries.
            "collection-memory-digests-nightly": {
                "task": "scrapalot.housekeeping.enrich_collection_summary",
                "schedule": crontab(hour=5, minute=20),
                "kwargs": {},  # collection_id=None → full pass
            },
            # GC orphaned memory-only upload tmpfiles (05:30 UTC). Failed or
            # OCR-deferred memory-only uploads keep their bytes under
            # /app/data/tmp so a reprocess can recover them; this DB-aware
            # sweep reclaims only temps no live recoverable doc still
            # references (age floor protects in-flight uploads).
            "maintenance-gc-orphan-tmpfiles": {
                "task": "scrapalot.maintenance.gc_orphan_tmpfiles",
                "schedule": crontab(hour=5, minute=30),
                "kwargs": {"min_age_hours": 24},
            },
            # Graph-sync reconciler — every hour at :10, walk every
            # collection doc and derive the correct graph_sync_status row
            # from the actual Neo4j + pgvector state. Fixes drift between
            # the status table (which the UI counter + 'Build graph'
            # retry gate read) and reality. Heavier than job recovery
            # (one Cypher per collection) so keeps to hourly. Full detail
            # in service/graph/graph_sync_reconciler.py.
            "graph-sync-reconcile-hourly": {
                "task": "scrapalot.housekeeping.reconcile_graph_sync_status",
                "schedule": crontab(minute=10),  # every hour at :10
                "kwargs": {"collection_id": None, "dry_run": False},
            },
            # Job recovery — every 30 min, find documents that are still
            # `processing_status=pending` while their latest job is either
            # stuck in `processing` (>2 h, worker died mid-flight) or has
            # already moved to `completed` (Bug A split-transaction
            # crash). The recovery service verifies whether actual
            # processing artifacts exist (pgvector + Neo4j Book) before
            # deciding to mark completed (recovery) vs failed (re-process
            # required). Replaces the dead `cleanup_stuck_jobs` helper
            # that was defined in utils/job_utils.py but never called.
            "document-job-recovery-30min": {
                # Was every 5 min with a 10-min cutoff — that schedule
                # turned out to flood the `documents` queue: each tick
                # enqueues a `recover_stuck_document_jobs` task, and when
                # the worker is busy on long reprocess jobs (which is
                # often) the recover tasks pile up faster than they
                # drain. Production observed 373 backlogged recover
                # tasks at one point, with 36 actual reprocess jobs
                # buried under them. Back to every 30 min with a 1-h
                # cutoff: still self-heals zombie 'processing' rows
                # within the same admin shift, doesn't bury real work.
                "task": "scrapalot.recover_stuck_document_jobs",
                "schedule": crontab(minute="*/30"),
                "kwargs": {"max_age_hours": 1.0, "dry_run": False},
            },
            # Beat liveness signal — written BY worker, dispatched BY beat,
            # polled by `scripts/supervisord_watchdog_beat.py`. Catches both
            # beat-frozen and worker-starved failure modes in one signal.
            # 60 s cadence: tight enough that 5 misses (5 min) is well under
            # the absolute 10 min trigger threshold the watchdog enforces.
            "celery-beat-heartbeat": {
                "task": "scrapalot.celery_beat_heartbeat",
                "schedule": 60.0,
                "options": {"queue": "fast", "expires": 60},
            },
            # Memify — monthly pull-toward-neutral decay
            # protects against drift when a user accidentally thumbs-down
            # a great answer. Runs at 05:00 UTC on the 1st (after nightly
            # housekeeping has settled, before working hours). Single
            # collection-wide Cypher; cheap.
            "graph-feedback-weight-decay-monthly": {
                "task": "scrapalot.housekeeping.feedback_weight_decay",
                "schedule": crontab(hour=5, minute=0, day_of_month="1"),
                "kwargs": {"pull": 0.05, "neutral": 0.5},
            },
            # Leiden Communities — nightly build for any
            # collection whose graph_sync_status='dirty'. Runs at 05:10 UTC,
            # AFTER PageRank (04:40) and feedback decay so the importance
            # signal those write is already on disk. Hierarchical Leiden +
            # LLM community reports; bounded concurrency keeps OpenAI calls
            # in check. Skips when no collection is dirty.
            "graph-build-communities-nightly": {
                "task": "scrapalot.housekeeping.build_communities",
                "schedule": crontab(hour=5, minute=10),
                "kwargs": {
                    "collection_id": None,
                    "max_cluster_size": 12,
                    "generate_reports": True,
                    "parallelism": 4,
                },
            },
        },
    }
)

# ── TEMP (2026-06-09): graph housekeeping beat paused ──────────────────────────
# After the UFO entity re-extraction recovery + an external agent's
# postprocess-graph run, the graph is half-built (119k NULL-weight CO_OCCURS
# edges, partial communities). The heavy nightly + interval graph build/recompute
# beat jobs are paused so they don't burn CPU + OpenAI on an inconsistent graph.
# The light status reconciler, stuck-job recovery, and beat heartbeat stay on.
# RE-ENABLE: delete this whole block (or set GRAPH_HOUSEKEEPING_PAUSED=false)
# once the graph is reconciled.
import os as _os

if _os.getenv("GRAPH_HOUSEKEEPING_PAUSED", "true").lower() in ("1", "true", "yes"):
    for _paused_beat in (
        "graph-merge-duplicates-nightly",
        "graph-resolve-type-conflicts-nightly",
        "graph-sweep-hierarchy-nightly",
        "graph-sweep-orphan-entities-nightly",
        "graph-recompute-entity-idf-nightly",
        "graph-cooccurrence-weight-recompute-nightly",
        "graph-cooccurrence-prune-nightly",
        "graph-cooccurrence-ensure-weights",
        "graph-ensure-pending-built",
        "graph-pagerank-nightly",
        "graph-collection-fingerprints-nightly",
        "collection-memory-digests-nightly",
        "graph-feedback-weight-decay-monthly",
        "graph-build-communities-nightly",
    ):
        celery_app.conf.beat_schedule.pop(_paused_beat, None)
