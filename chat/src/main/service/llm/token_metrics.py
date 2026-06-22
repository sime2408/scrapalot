"""
Token metrics tracking system for LLM providers.
Stores token usage and performance metrics in message_metadata JSON field.
"""

from dataclasses import dataclass
import json
import logging
from typing import Any

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


@dataclass
class TokenMetrics:
    """Data class for token usage metrics stored in message_metadata."""

    tokens_per_second: float
    total_tokens: int
    input_tokens: int
    output_tokens: int
    cost_usd: float | None
    latency_ms: float
    provider: str
    model: str
    time_to_first_token: float | None = None


class TokenMetricsTracker:
    """
    Token metrics tracking system that stores data in message_metadata JSON field.
    """

    def __init__(self):
        self.pricing = TokenMetricsTracker._load_pricing_config()

    @staticmethod
    def _load_pricing_config() -> dict[str, dict[str, float]]:
        """
        Pricing configuration removed - costs are now extracted directly from
        LangChain's callback handlers (get_openai_callback) or AIMessage.usage_metadata.
        This method is kept for backward compatibility but returns empty config.
        """
        return {}

    @staticmethod
    def create_metrics(
        provider: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        latency: float,
        time_to_first_token: float | None = None,
    ) -> TokenMetrics:
        """
        Create a token metrics object.

        Args:
            provider: LLM provider name
            model: Model name
            input_tokens: Number of input tokens
            output_tokens: Number of output tokens
            latency: Total request latency in seconds
            time_to_first_token: Time to first token in seconds (optional)

        Returns:
            TokenMetrics object
        """
        total_tokens = input_tokens + output_tokens
        tokens_per_second = output_tokens / latency if latency > 0 else 0
        cost_usd = 0.0  # Cost will be provided by LangChain callbacks

        return TokenMetrics(
            tokens_per_second=round(tokens_per_second, 2),
            total_tokens=total_tokens,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost_usd,
            latency_ms=round(latency * 1000, 2),
            provider=provider,
            model=model,
            time_to_first_token=round(time_to_first_token * 1000, 2) if time_to_first_token else None,
        )

    @staticmethod
    async def update_message_metadata(_db: Session, message_id: str, metrics: TokenMetrics) -> bool:
        """
        Update message metadata with token metrics.

        Args:
            _db: Database session
            message_id: Message ID to update
            metrics: TokenMetrics object

        Returns:
            True if successful, False otherwise
        """
        # Messages table is owned by Kotlin; token metrics delivered via gRPC stream
        logger.info("Token metrics for message %s: %s tokens/s (Kotlin owns messages)", message_id, metrics.tokens_per_second)
        return True

    @staticmethod
    async def get_message_metrics(message) -> TokenMetrics | None:
        """
        Retrieve token metrics from message metadata.

        Args:
            message: Message object with message_metadata

        Returns:
            TokenMetrics object or None if not found
        """
        try:
            if message and message.message_metadata:
                metadata = message.message_metadata
                if isinstance(metadata, str):
                    metadata = json.loads(metadata)

                token_metrics = metadata.get("token_metrics")
                if token_metrics:
                    return TokenMetrics(
                        tokens_per_second=token_metrics.get("tokens_per_second", 0),
                        total_tokens=token_metrics.get("total_tokens", 0),
                        input_tokens=token_metrics.get("input_tokens", 0),
                        output_tokens=token_metrics.get("output_tokens", 0),
                        cost_usd=token_metrics.get("cost_usd"),
                        latency_ms=token_metrics.get("latency_ms", 0),
                        provider=token_metrics.get("provider", ""),
                        model=token_metrics.get("model", ""),
                        time_to_first_token=token_metrics.get("time_to_first_token"),
                    )

            return None

        except Exception as e:
            logger.error("Error retrieving message metrics: %s", e)
            return None

    @staticmethod
    async def get_session_metrics(_session) -> dict[str, Any]:
        """
        Get aggregated metrics for all messages in a session.

        Args:
            _session: Session object with id

        Returns:
            Dictionary with aggregated metrics
        """
        # Messages table is owned by Kotlin; metrics not available from Python
        return {
            "total_tokens": 0,
            "total_cost": 0,
            "total_requests": 0,
            "avg_tokens_per_second": 0,
            "providers": [],
        }

    @staticmethod
    async def get_session_metrics_summary(_db: Session, _session_id: str) -> dict[str, Any]:
        """
        Get aggregated metrics for all messages in a session.

        Args:
            _db: Database session
            _session_id: Session ID

        Returns:
            Dictionary with aggregated metrics
        """
        # Messages table is owned by Kotlin; metrics not available from Python
        return {
            "total_tokens": 0,
            "total_cost": 0,
            "total_requests": 0,
            "avg_tokens_per_second": 0,
            "providers": [],
        }
