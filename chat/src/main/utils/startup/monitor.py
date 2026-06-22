"""
Lightweight runtime monitors.

Two small singletons that share the same minimal "record + summarise"
shape and so live together:

* :class:`StartupMonitor` — records named checkpoints during startup and
  logs the slowest steps once the boot sequence finishes.
* :class:`PerformanceMonitor` — rolling stats for agentic-RAG agent
  calls (avg duration, success rate, timeout count).
"""

from __future__ import annotations

from collections import deque
import time
from typing import Any

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# StartupMonitor
# ---------------------------------------------------------------------------


class StartupMonitor:
    """Monitor startup performance and identify bottlenecks."""

    def __init__(self) -> None:
        self.start_time = time.time()
        self.checkpoints: list[dict[str, Any]] = []
        self.last_checkpoint = self.start_time

    def checkpoint(self, name: str) -> None:
        """Record a checkpoint with timing relative to start and previous step."""
        now = time.time()
        self.checkpoints.append(
            {
                "name": name,
                "timestamp": now,
                "elapsed_total": now - self.start_time,
                "elapsed_since_last": now - self.last_checkpoint,
            }
        )
        self.last_checkpoint = now

    def summary(self) -> None:
        """Log a summary highlighting only the slowest checkpoints."""
        total_time = time.time() - self.start_time
        logger.info("📊 STARTUP SUMMARY - Total time: %.2f seconds", total_time)

        if not self.checkpoints:
            logger.info("No checkpoints recorded")
            return

        slowest = sorted(self.checkpoints, key=lambda c: c["elapsed_since_last"], reverse=True)[:3]
        logger.warning("🐌 SLOWEST OPERATIONS:")
        for i, checkpoint in enumerate(slowest, start=1):
            logger.warning("  %d. %s: %.2fs", i, checkpoint["name"], checkpoint["elapsed_since_last"])


# Module-level singleton, importable as ``startup_monitor``.
startup_monitor = StartupMonitor()


# ---------------------------------------------------------------------------
# PerformanceMonitor (agentic RAG)
# ---------------------------------------------------------------------------


class PerformanceMonitor:
    """Simple rolling-window monitor for agentic RAG agent calls."""

    def __init__(self, window: int = 100) -> None:
        self._agent_calls: deque[dict[str, Any]] = deque(maxlen=window)
        self._total_calls = 0
        self._total_timeouts = 0

    def record_agent_call(self, duration: float, success: bool, timeout: bool = False) -> None:
        """Record a single agent call."""
        self._agent_calls.append(
            {
                "timestamp": time.time(),
                "duration": duration,
                "success": success,
                "timeout": timeout,
            }
        )
        self._total_calls += 1
        if timeout:
            self._total_timeouts += 1

    def get_stats(self) -> dict[str, Any]:
        """Return rolling-window statistics."""
        if not self._agent_calls:
            return {"calls": 0, "avg_duration": 0, "success_rate": 0}

        durations = [c["duration"] for c in self._agent_calls]
        successes = [c["success"] for c in self._agent_calls]
        return {
            "calls": len(self._agent_calls),
            "avg_duration": sum(durations) / len(durations),
            "success_rate": sum(successes) / len(successes),
            "total_calls": self._total_calls,
            "total_timeouts": self._total_timeouts,
        }


_monitor: PerformanceMonitor | None = None


def get_performance_monitor() -> PerformanceMonitor:
    """Return the process-wide ``PerformanceMonitor`` singleton."""
    global _monitor
    if _monitor is None:
        _monitor = PerformanceMonitor()
    return _monitor
