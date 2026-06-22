"""Drop-in subprocess job runner for heavy Celery tasks.

Adapted from onyx-dot-app/onyx job_client.py (MIT licensed). Provides
clean process isolation for memory-heavy work (PDF parse, chunk, embed).
The Celery thread becomes a lightweight watchdog; the spawned subprocess
runs the actual work and exits cleanly when done — releasing all RAM.

Why we need this:
- Switching the worker pool from prefork to threads eliminated
  random SIGSEGV/SIGKILL on fork but means lazy `import` statements inside
  task bodies now load into the single Celery process and stay resident
  for the life of the worker. After one reprocess the worker holds
  PyTorch + Docling + LangChain + sentence-transformers (~1.8 GB) forever.
- This file moves that heavy work into a `multiprocessing.get_
  context("spawn")` subprocess. spawn (NOT fork) means a fresh Python
  interpreter — the parent's heap is not inherited. The subprocess
  imports only what it needs, runs the task, exits. RAM is released.

How the watchdog cooperates with Celery + JobRecovery:
- Celery thread submits the heavy func to SubprocessJobClient → gets a
  SubprocessJob handle.
- Celery thread polls `job.done()` every 5 s. While waiting, it emits
  memory diagnostics every 60 s and bumps the heartbeat
  counter every 30 s via a daemon thread.
- On `job.done()` it inspects `job.status`: finished/cancelled/error/...
  and returns the appropriate result. If error, raises with the
  subprocess's traceback (sent back via mp.Queue).
- If the Celery task itself is cancelled (e.g. visibility timeout, beat
  invalidation), the watchdog calls `job.terminate_and_wait()` which
  sends SIGTERM, waits the grace period, then SIGKILLs.

Importing this module is light-weight — no PyTorch / Docling / etc.
imports here. Heavy modules live behind `func` (the user's callable
that runs inside the spawned subprocess).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import multiprocessing as mp
from multiprocessing.context import SpawnProcess
import sys
import traceback
from typing import Any, Literal

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


JobStatus = Literal["pending", "running", "finished", "cancelled", "error"]


class SubprocessJobException(Exception):
    """Lets the user function raise with a specific subprocess exit code.

    Example: ``raise SubprocessJobException("file not found", code=42)``
    → subprocess exits with code 42 (parent reads via `job.process.exitcode`).
    Generic Exception in the user function exits with code 255.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        code: int | None = kwargs.pop("code", None)
        self.code = code
        super().__init__(*args, **kwargs)


def _initializer(
    func: Callable,
    queue: mp.Queue,
    args: tuple,
    kwargs: dict[str, Any] | None = None,
) -> Any:
    """First-thing-in-subprocess setup: fresh SQLAlchemy engine, run func.

    Runs inside the spawned subprocess (= fresh Python interpreter). The
    SQLAlchemy engine reset is critical — the parent's connection pool
    must NOT be inherited (even though `spawn` should not technically
    inherit fds the way fork does, db engines hold connection state in
    Python objects that the pickled module-level globals can recreate
    with stale refs). Following SQLAlchemy's recommendation:
    https://docs.sqlalchemy.org/en/20/core/pooling.html#using-connection-pools-with-multiprocessing-or-os-fork
    """
    if kwargs is None:
        kwargs = {}

    logger.info("subprocess_job: initializing spawned worker child")

    # Reset SQLAlchemy engine — subprocess gets a fresh connection pool.
    # Wrapped in try/except so an import-time error here doesn't take down
    # the subprocess silently (we want a visible exit code + queue message).
    try:
        from src.main.config.database import init_engine_for_subprocess

        init_engine_for_subprocess(
            pool_size=2,
            max_overflow=8,
            pool_recycle=60,
            pool_pre_ping=True,
        )
    except Exception:
        logger.exception("subprocess_job: SQLAlchemy reset failed (continuing)")

    try:
        return func(*args, **kwargs)
    except SubprocessJobException as e:
        logger.exception("subprocess_job: SubprocessJobException raised")
        queue.put(traceback.format_exc())
        sys.exit(e.code if e.code is not None else 255)
    except Exception:
        logger.exception("subprocess_job: generic exception in user func")
        queue.put(traceback.format_exc())
        sys.exit(255)


@dataclass
class SubprocessJob:
    """Drop-in replacement for `dask.distributed.Future`, mirrors Onyx's SimpleJob.

    The lifecycle: parent calls `client.submit(func, *args)` → SpawnProcess
    started → child runs `_initializer(func, queue, args)` → child exits with
    code 0 (success), specific code (SubprocessJobException), or 255 (generic).
    Parent polls `done()` then inspects `status` / `exception()`.
    """

    id: int
    process: SpawnProcess | None = None
    queue: mp.Queue | None = None
    _exception: str | None = None

    def cancel(self) -> bool:
        return self.release()

    def release(self) -> bool:
        """Soft kill: SIGTERM. Does NOT wait. For graceful shutdown use
        `terminate_and_wait` instead."""
        if self.process is not None and self.process.is_alive():
            self.process.terminate()
            return True
        return False

    def terminate_and_wait(self, sigterm_grace_seconds: float = 30) -> bool:
        """Hard kill with graceful escalation.

        SIGTERM → wait `sigterm_grace_seconds` → SIGKILL if still alive.
        Joins after each signal so the OS can reap the zombie child.
        Returns True if the process was alive when called (we did something).
        """
        if self.process is None:
            return False
        if not self.process.is_alive():
            return False

        pid = self.process.pid
        logger.warning(
            "subprocess_job: SIGTERM job=%s pid=%s grace=%ss",
            self.id,
            pid,
            sigterm_grace_seconds,
        )
        self.process.terminate()
        self.process.join(timeout=sigterm_grace_seconds)

        if self.process.is_alive():
            logger.warning(
                "subprocess_job: SIGTERM grace exceeded → SIGKILL job=%s pid=%s",
                self.id,
                pid,
            )
            self.process.kill()
            self.process.join()

        return True

    @property
    def status(self) -> JobStatus:
        if not self.process:
            return "pending"
        if self.process.is_alive():
            return "running"
        # Process exited — inspect exit code
        if self.process.exitcode is None:
            return "cancelled"
        if self.process.exitcode != 0:
            return "error"
        return "finished"

    def done(self) -> bool:
        return self.status in ("finished", "cancelled", "error")

    def exception(self) -> str:
        """Retrieve traceback string from the subprocess via mp.Queue.

        Called only after `done()` returns True. Cached so subsequent
        calls return the same string."""
        if self._exception is None and self.queue and not self.queue.empty():
            try:
                self._exception = self.queue.get_nowait()
            except Exception as e:
                logger.debug("Could not get exception from subprocess queue: %s", e)
        return self._exception or f"Job {self.id} did not report an exception."


class SubprocessJobClient:
    """Drop-in spawn-subprocess client. Mirrors Onyx SimpleJobClient API.

    `n_workers` caps concurrent subprocesses. `submit()` returns None when
    the cap is reached → caller is responsible for backpressure (sleep + retry
    or refuse the work). For our use (Celery watchdog with concurrency=1
    thread), n_workers=1 is correct — only one subprocess per Celery slot.
    """

    def __init__(self, n_workers: int = 1) -> None:
        self.n_workers = n_workers
        self.job_id_counter = 0
        self.jobs: dict[int, SubprocessJob] = {}

    def _cleanup_completed(self) -> None:
        for jid in list(self.jobs.keys()):
            if self.jobs[jid].done():
                logger.debug("subprocess_job: cleaning up done job %s", jid)
                del self.jobs[jid]

    def submit(self, func: Callable, *args: Any) -> SubprocessJob | None:
        """Spawn a subprocess running `func(*args)`.

        Returns None when n_workers cap is reached. `func` must be
        importable at module level (not a closure / lambda / nested def)
        because spawn pickles the function reference.
        """
        self._cleanup_completed()
        if len(self.jobs) >= self.n_workers:
            logger.debug(
                "subprocess_job: at cap (%d/%d), refusing submit",
                len(self.jobs),
                self.n_workers,
            )
            return None

        job_id = self.job_id_counter
        self.job_id_counter += 1

        # FORCE spawn — even if the process-wide default is fork. spawn
        # gives us a fresh Python interpreter in the child (no inherited
        # parent heap, no inherited file descriptors except stdin/out/err).
        ctx = mp.get_context("spawn")
        queue = ctx.Queue()
        process = ctx.Process(
            target=_initializer,
            args=(func, queue, args),
            daemon=True,  # child dies with parent
        )
        job = SubprocessJob(id=job_id, process=process, queue=queue)
        process.start()

        self.jobs[job_id] = job
        logger.info(
            "subprocess_job: spawned job=%s pid=%s func=%s",
            job_id,
            process.pid,
            getattr(func, "__qualname__", repr(func)),
        )
        return job
