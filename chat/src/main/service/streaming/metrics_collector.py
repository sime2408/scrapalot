"""
Metrics Collector for streaming packet system.
Collects and aggregates streaming performance metrics.
"""

from dataclasses import dataclass, field
from datetime import datetime
import time

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


@dataclass
class StreamMetrics:
    """Metrics for a single streaming session."""

    session_id: str
    start_time: float = field(default_factory=time.time)
    end_time: float | None = None

    # Packet metrics
    total_packets: int = 0
    packets_by_type: dict[str, int] = field(default_factory=dict)

    # Token metrics
    total_tokens: int = 0
    tokens_per_second: float = 0.0

    # Citation metrics
    total_citations: int = 0
    citation_latency_ms: list[float] = field(default_factory=list)

    # Timing metrics
    time_to_first_token_ms: float | None = None
    time_to_first_citation_ms: float | None = None
    total_duration_ms: float | None = None

    # Error metrics
    error_count: int = 0
    error_types: dict[str, int] = field(default_factory=dict)

    def get_duration_ms(self) -> float:
        """Get current or total duration in milliseconds."""
        end = self.end_time if self.end_time else time.time()
        return (end - self.start_time) * 1000

    def calculate_tokens_per_second(self) -> float:
        """Calculate tokens per second."""
        duration_s = self.get_duration_ms() / 1000
        if duration_s > 0:
            return self.total_tokens / duration_s
        return 0.0

    def to_dict(self) -> dict:
        """Convert metrics to dictionary."""
        return {
            "session_id": self.session_id,
            "start_time": datetime.fromtimestamp(self.start_time).isoformat(),
            "end_time": datetime.fromtimestamp(self.end_time).isoformat() if self.end_time else None,
            "total_packets": self.total_packets,
            "packets_by_type": self.packets_by_type,
            "total_tokens": self.total_tokens,
            "tokens_per_second": self.tokens_per_second,
            "total_citations": self.total_citations,
            "avg_citation_latency_ms": (sum(self.citation_latency_ms) / len(self.citation_latency_ms) if self.citation_latency_ms else 0.0),
            "time_to_first_token_ms": self.time_to_first_token_ms,
            "time_to_first_citation_ms": self.time_to_first_citation_ms,
            "total_duration_ms": self.total_duration_ms,
            "error_count": self.error_count,
            "error_types": self.error_types,
        }


class MetricsCollector:
    """
    Collects and aggregates streaming metrics.

    Features:
    - Per-session metrics tracking
    - Real-time performance monitoring
    - Aggregated statistics
    - Export to various formats
    """

    def __init__(self, max_sessions: int = 1000):
        """
        Initialize the metrics collector.

        Args:
            max_sessions: Maximum number of sessions to keep in memory
        """
        self.max_sessions = max_sessions
        self._sessions: dict[str, StreamMetrics] = {}
        self._session_order: list[str] = []

        logger.debug("MetricsCollector initialized with max_sessions=%d", max_sessions)

    def start_session(self, session_id: str) -> StreamMetrics:
        """
        Start tracking metrics for a new session.

        Args:
            session_id: Unique session identifier

        Returns:
            StreamMetrics object for this session
        """
        metrics = StreamMetrics(session_id=session_id)
        self._sessions[session_id] = metrics
        self._session_order.append(session_id)

        # Evict oldest session if we exceed max
        if len(self._sessions) > self.max_sessions:
            oldest_id = self._session_order.pop(0)
            del self._sessions[oldest_id]
            logger.debug("Evicted oldest session: %s", oldest_id)

        logger.debug("Started metrics tracking for session: %s", session_id)
        return metrics

    def get_session(self, session_id: str) -> StreamMetrics | None:
        """
        Get metrics for a session.

        Args:
            session_id: Session identifier

        Returns:
            StreamMetrics object or None if not found
        """
        return self._sessions.get(session_id)

    def record_packet(self, session_id: str, packet_type: str, token_count: int = 0):
        """
        Record a packet emission.

        Args:
            session_id: Session identifier
            packet_type: Type of packet emitted
            token_count: Number of tokens in this packet (for message_delta)
        """
        metrics = self.get_session(session_id)
        if not metrics:
            logger.warning("Session not found: %s", session_id)
            return

        metrics.total_packets += 1
        metrics.packets_by_type[packet_type] = metrics.packets_by_type.get(packet_type, 0) + 1

        # Track tokens
        if token_count > 0:
            metrics.total_tokens += token_count

            # Record time to first token
            if metrics.time_to_first_token_ms is None:
                metrics.time_to_first_token_ms = metrics.get_duration_ms()

    def record_citation(self, session_id: str):
        """
        Record a citation emission.

        Args:
            session_id: Session identifier
        """
        metrics = self.get_session(session_id)
        if not metrics:
            return

        metrics.total_citations += 1

        # Record time to first citation
        if metrics.time_to_first_citation_ms is None:
            metrics.time_to_first_citation_ms = metrics.get_duration_ms()

        # Record citation latency
        citation_latency = metrics.get_duration_ms()
        metrics.citation_latency_ms.append(citation_latency)

    def record_error(self, session_id: str, error_type: str):
        """
        Record an error.

        Args:
            session_id: Session identifier
            error_type: Type/category of error
        """
        metrics = self.get_session(session_id)
        if not metrics:
            return

        metrics.error_count += 1
        metrics.error_types[error_type] = metrics.error_types.get(error_type, 0) + 1

    def end_session(self, session_id: str):
        """
        End a session and finalize metrics.

        Args:
            session_id: Session identifier
        """
        metrics = self.get_session(session_id)
        if not metrics:
            return

        metrics.end_time = time.time()
        metrics.total_duration_ms = metrics.get_duration_ms()
        metrics.tokens_per_second = metrics.calculate_tokens_per_second()

        logger.info(
            "Session %s ended: duration=%.2fms, tokens=%d, tps=%.2f, citations=%d",
            session_id,
            metrics.total_duration_ms,
            metrics.total_tokens,
            metrics.tokens_per_second,
            metrics.total_citations,
        )

    def get_aggregate_stats(self) -> dict:
        """
        Get aggregated statistics across all sessions.

        Returns:
            Dictionary of aggregate metrics
        """
        if not self._sessions:
            return {}

        total_sessions = len(self._sessions)
        total_packets = sum(m.total_packets for m in self._sessions.values())
        total_tokens = sum(m.total_tokens for m in self._sessions.values())
        total_citations = sum(m.total_citations for m in self._sessions.values())
        total_errors = sum(m.error_count for m in self._sessions.values())

        # Calculate averages
        completed_sessions = [m for m in self._sessions.values() if m.end_time is not None]
        # noinspection PyTypeChecker
        avg_duration = sum(m.total_duration_ms or 0.0 for m in completed_sessions) / len(completed_sessions) if completed_sessions else 0.0
        avg_tps = sum(m.tokens_per_second for m in completed_sessions) / len(completed_sessions) if completed_sessions else 0.0

        # Time to first token stats
        ttft_values = [m.time_to_first_token_ms for m in self._sessions.values() if m.time_to_first_token_ms is not None]
        avg_ttft = sum(ttft_values) / len(ttft_values) if ttft_values else 0.0

        return {
            "total_sessions": total_sessions,
            "completed_sessions": len(completed_sessions),
            "total_packets": total_packets,
            "total_tokens": total_tokens,
            "total_citations": total_citations,
            "total_errors": total_errors,
            "avg_duration_ms": avg_duration,
            "avg_tokens_per_second": avg_tps,
            "avg_time_to_first_token_ms": avg_ttft,
            "error_rate": total_errors / total_sessions if total_sessions > 0 else 0.0,
        }

    def export_session_metrics(self, session_id: str) -> dict | None:
        """
        Export metrics for a specific session.

        Args:
            session_id: Session identifier

        Returns:
            Dictionary of session metrics or None if not found
        """
        metrics = self.get_session(session_id)
        if not metrics:
            return None

        return metrics.to_dict()

    def export_all_metrics(self) -> dict:
        """
        Export all metrics.

        Returns:
            Dictionary containing all session metrics and aggregate stats
        """
        return {
            "aggregate": self.get_aggregate_stats(),
            "sessions": {session_id: metrics.to_dict() for session_id, metrics in self._sessions.items()},
        }

    def clear_old_sessions(self, max_age_seconds: int = 3600):
        """
        Clear sessions older than specified age.

        Args:
            max_age_seconds: Maximum age in seconds
        """
        current_time = time.time()
        to_remove = []

        for session_id, metrics in self._sessions.items():
            if metrics.end_time and (current_time - metrics.end_time) > max_age_seconds:
                to_remove.append(session_id)

        for session_id in to_remove:
            del self._sessions[session_id]
            if session_id in self._session_order:
                self._session_order.remove(session_id)

        if to_remove:
            logger.info("Cleared %d old sessions", len(to_remove))


# Global metrics collector instance
_global_collector: MetricsCollector | None = None


def get_metrics_collector() -> MetricsCollector:
    """Get the global metrics collector instance."""
    global _global_collector
    if _global_collector is None:
        _global_collector = MetricsCollector()
    # noinspection PyTypeChecker
    collector: MetricsCollector = _global_collector
    return collector
