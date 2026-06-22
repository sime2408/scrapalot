#!/usr/bin/env python3
"""Beat watchdog — restart `celery_beat` when the dual-writer heartbeat
key stops refreshing.

Polls `scrapalot:celery:beat:heartbeat` every 60 s. The key is written
by `src/main/workers/tasks/monitoring_tasks.py:celery_beat_heartbeat_task`
which is dispatched every 60 s by beat and executed by any worker on
the `fast` queue. Both halves of that pipeline must be alive for the
key to refresh — so a single stale-key signal catches:

  - beat process up but scheduler frozen (deadlock, asyncio wedge)
  - beat dispatching but no worker consuming (fast queue starved,
    broker disconnect)
  - worker pool size 0 (legitimate but means no scheduled work runs)

The standard supervisord `autorestart=true` covers process crashes
already — this script covers the cases where the process LOOKS alive
to supervisord but is functionally dead.

**Two-gate restart trigger**: requires BOTH conditions to hold before
issuing `supervisorctl restart celery_beat`:

  1. ≥ `CONSECUTIVE_MISSES_TRIGGER` consecutive polls with stale/missing
     key. Counter resets on any successful fresh read.
  2. Absolute key age ≥ `MIN_ABSOLUTE_AGE_TRIGGER` (when key exists), OR
     key missing entirely.

Two gates prevent false-positive restarts from transient Redis blips
or a single slow tick. Restart is the response of last resort — a
beat restart cancels in-flight scheduling state, so we want to be sure.

Operator inspection: `tail -F /app/data/logs/beat_watchdog.log` inside
the `scrapalot-workers` container.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

# Make `src.main.*` importable when run as a script under supervisord.
sys.path.insert(0, os.environ.get("SCRAPALOT_APP_ROOT", "/app"))

# Local imports follow after the sys.path tweak.
from src.main.utils.core.logger import get_logger  # noqa: E402

logger = get_logger(__name__)


def _emit(level: str, msg: str, *args: object) -> None:
    """Write to BOTH the structured logger (-> scrapalot.log) and
    stdout (-> supervisord's stdout_logfile = beat_watchdog.log).
    The scrapalot logger uses a FileHandler that doesn't propagate to
    stdout, so without this hybrid the supervisord-managed log file
    captured by `supervisorctl tail` would stay empty."""
    formatted = (msg % args) if args else msg
    getattr(logger, level)(msg, *args)
    print(f"[{level.upper()}] {formatted}", flush=True)


# Tunables. Env-overridable so prod can adjust without a redeploy.
POLL_INTERVAL_SECONDS = int(os.environ.get("BEAT_WATCHDOG_POLL_INTERVAL", "60"))
CONSECUTIVE_MISSES_TRIGGER = int(os.environ.get("BEAT_WATCHDOG_MISS_TRIGGER", "5"))
MIN_ABSOLUTE_AGE_TRIGGER = int(os.environ.get("BEAT_WATCHDOG_MIN_AGE_TRIGGER", "600"))

BEAT_HEARTBEAT_KEY = "scrapalot:celery:beat:heartbeat"
BEAT_PROGRAM_NAME = os.environ.get("BEAT_WATCHDOG_PROGRAM", "celery_beat")
SUPERVISORD_CONF = os.environ.get("SUPERVISORD_CONF", "/app/supervisord.conf")

# Cool-off period after a restart. A freshly restarted beat takes a few
# ticks to dispatch its first heartbeat task; without a cool-off the
# watchdog would immediately re-fire and ping-pong.
POST_RESTART_GRACE_SECONDS = max(POLL_INTERVAL_SECONDS * 2, 180)


def get_heartbeat_age() -> float | None:
    """Return age of the heartbeat key in seconds, or None if the key is
    missing or Redis is unreachable. Both cases count as 'miss' from the
    watchdog's perspective — the trigger logic differentiates only on
    whether a non-None age has crossed the absolute threshold."""
    try:
        # Import lazily so the watchdog can start even if the client
        # module has trouble importing (e.g. config-load issues during
        # initial container boot — we'd still want the watchdog to keep
        # trying and not crash supervisord into a restart loop).
        from src.main.utils.redis.client import get_redis_client

        redis = get_redis_client()
        raw = redis.get(BEAT_HEARTBEAT_KEY)
        if raw is None:
            return None
        ts = float(raw.decode() if isinstance(raw, bytes) else raw)
        return time.time() - ts
    except Exception as exc:  # noqa: BLE001
        _emit("warning", "watchdog: redis read failed (%s) — treating as miss", exc)
        return None


def restart_beat() -> bool:
    """Issue `supervisorctl restart` for the beat program. Returns True
    on success. Failures are logged and reported to the caller so the
    miss counter can stay armed."""
    try:
        result = subprocess.run(
            ["supervisorctl", "-c", SUPERVISORD_CONF, "restart", BEAT_PROGRAM_NAME],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if result.returncode == 0:
            _emit(
                "warning",
                "watchdog: restarted %s successfully: %s",
                BEAT_PROGRAM_NAME,
                (result.stdout or "").strip(),
            )
            return True
        _emit(
            "error",
            "watchdog: restart failed (rc=%d): stdout=%r stderr=%r",
            result.returncode,
            (result.stdout or "").strip(),
            (result.stderr or "").strip(),
        )
        return False
    except subprocess.TimeoutExpired:
        _emit("error", "watchdog: supervisorctl restart timed out after 30 s")
        return False
    except Exception as exc:  # noqa: BLE001
        _emit("error", "watchdog: supervisorctl restart raised: %s", exc)
        return False


def main() -> None:
    _emit(
        "info",
        "beat watchdog starting: key=%s poll=%ds trigger=%d_misses AND age>=%ds program=%s",
        BEAT_HEARTBEAT_KEY,
        POLL_INTERVAL_SECONDS,
        CONSECUTIVE_MISSES_TRIGGER,
        MIN_ABSOLUTE_AGE_TRIGGER,
        BEAT_PROGRAM_NAME,
    )

    consecutive_misses = 0
    last_restart_at = 0.0

    while True:
        time.sleep(POLL_INTERVAL_SECONDS)

        # Cool-off after a recent restart — give beat time to ship its
        # first heartbeat before we evaluate the key again.
        if time.time() - last_restart_at < POST_RESTART_GRACE_SECONDS:
            continue

        age = get_heartbeat_age()
        fresh_threshold = POLL_INTERVAL_SECONDS * 2

        if age is None:
            consecutive_misses += 1
            _emit(
                "warning",
                "watchdog: heartbeat key missing (consecutive_misses=%d)",
                consecutive_misses,
            )
        elif age <= fresh_threshold:
            # Key fresh enough — reset the miss counter.
            if consecutive_misses > 0:
                _emit(
                    "info",
                    "watchdog: heartbeat fresh (age=%.1fs), resetting miss counter from %d",
                    age,
                    consecutive_misses,
                )
            consecutive_misses = 0
            continue
        else:
            consecutive_misses += 1
            _emit(
                "warning",
                "watchdog: heartbeat stale (age=%.1fs, consecutive_misses=%d)",
                age,
                consecutive_misses,
            )

        # Two-gate trigger evaluation.
        absolute_age_ok = (age is None) or (age >= MIN_ABSOLUTE_AGE_TRIGGER)
        misses_ok = consecutive_misses >= CONSECUTIVE_MISSES_TRIGGER

        if misses_ok and absolute_age_ok:
            age_display = "missing" if age is None else f"{age:.1f}s"
            _emit(
                "error",
                "watchdog: triggering restart of %s (misses=%d, age=%s)",
                BEAT_PROGRAM_NAME,
                consecutive_misses,
                age_display,
            )
            if restart_beat():
                consecutive_misses = 0
                last_restart_at = time.time()
            # If restart failed, leave the miss counter armed — next
            # iteration will retry.


if __name__ == "__main__":
    main()
