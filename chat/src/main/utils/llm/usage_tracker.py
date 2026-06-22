"""
Unified LLM usage tracking.

Two layers live here:

* **System-level** — every internal Pydantic AI / LangChain agent call
  writes an ``llm_traces`` row with input/output tokens, model name and
  estimated cost. Used for cost analytics across background agents.
* **User-level** — usage attributable to a user is also published on a
  Redis Stream that the Kotlin backend consumes to update the
  ``user_token_usage`` table (the FK lives in the Kotlin DB).

The two streams are kept separate at the DB level but share pricing
data, so they live in one module.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy.orm import Session

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Pricing
# ---------------------------------------------------------------------------

# USD per 1M tokens (input, output) as of March 2026.
MODEL_PRICING: dict[str, tuple[float, float]] = {
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.00),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1": (2.00, 8.00),
    "gpt-4.1-nano": (0.10, 0.40),
    "claude-sonnet-4-5-20250514": (3.00, 15.00),
    "claude-haiku-4-5-20251001": (0.80, 4.00),
    "deepseek-chat": (0.14, 0.28),
    "deepseek-reasoner": (0.55, 2.19),
}


def _clean_model_name(model: Any) -> str:
    """Normalise a model identifier (drops the provider prefix if present)."""
    model_str = model if isinstance(model, str) else str(model)
    return model_str.split(":", 1)[-1] if ":" in model_str else model_str


def estimate_cost(input_tokens: int, output_tokens: int, model: Any) -> float:
    """Estimate USD cost for the given token counts; ``0.0`` for unknown models."""
    clean_model = _clean_model_name(model)
    for key, (inp_price, out_price) in MODEL_PRICING.items():
        if key in clean_model:
            return (input_tokens * inp_price + output_tokens * out_price) / 1_000_000
    return 0.0


# ---------------------------------------------------------------------------
# System-level tracking (writes to llm_traces table)
# ---------------------------------------------------------------------------


def _track_pydantic_ai_result(
    result: Any,
    agent_type: str,
    model: str,
    user_id: str,
    collection_ids: str,
) -> None:
    """Shared implementation for ``track_agent_usage`` / ``track_stream_usage``."""
    try:
        usage = result.usage()
    except Exception as e:
        logger.debug("Could not access usage on agent result: %s", e)
        return

    input_tokens = usage.input_tokens or 0
    output_tokens = usage.output_tokens or 0
    if input_tokens == 0 and output_tokens == 0:
        return

    track_llm_usage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        model=model,
        agent_type=agent_type,
        user_id=user_id,
        collection_ids=collection_ids,
    )


def track_agent_usage(
    result: Any,
    agent_type: str,
    model: str = "",
    user_id: str = "",
    collection_ids: str = "",
) -> None:
    """Track token usage from a Pydantic AI ``AgentRunResult``."""
    try:
        _track_pydantic_ai_result(result, agent_type, model, user_id, collection_ids)
    except Exception as e:
        logger.debug("Could not track agent usage: %s", e)


def track_stream_usage(
    result: Any,
    agent_type: str,
    model: str = "",
    user_id: str = "",
    collection_ids: str = "",
) -> None:
    """Track token usage from a Pydantic AI ``StreamedRunResult`` (call AFTER consuming)."""
    try:
        _track_pydantic_ai_result(result, agent_type, model, user_id, collection_ids)
    except Exception as e:
        logger.debug("Could not track stream usage: %s", e)


def track_llm_usage(
    input_tokens: int,
    output_tokens: int,
    model: str,
    agent_type: str,
    user_id: str = "",
    collection_ids: str = "",
    provider: str = "system",
    latency_ms: int = 0,
) -> None:
    """Insert a row into the ``llm_traces`` table for system-level analytics."""
    try:
        from sqlalchemy import text

        from src.main.config.database import SessionLocal

        clean_model = _clean_model_name(model)
        cost = estimate_cost(input_tokens, output_tokens, clean_model)

        db = SessionLocal()
        try:
            db.execute(
                text(
                    """
                    INSERT INTO llm_traces (
                        id, chat_mode, provider, model,
                        input_tokens, output_tokens, total_tokens, cost_usd,
                        latency_ms, user_id, collection_ids, created_at, updated_at
                    ) VALUES (
                        gen_random_uuid(), :chat_mode, :provider, :model,
                        :input_tokens, :output_tokens, :total_tokens, :cost_usd,
                        :latency_ms, :user_id, :collection_ids, :created_at, :created_at
                    )
                    """
                ),
                {
                    "chat_mode": agent_type,
                    "provider": provider,
                    "model": clean_model,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "total_tokens": input_tokens + output_tokens,
                    "cost_usd": cost,
                    "latency_ms": latency_ms,
                    "user_id": user_id or None,
                    "collection_ids": collection_ids or "[]",
                    "created_at": datetime.now(UTC),
                },
            )
            db.commit()
            logger.debug(
                "Tracked %s usage: %s %d+%d tokens, $%.6f",
                agent_type,
                clean_model,
                input_tokens,
                output_tokens,
                cost,
            )
        finally:
            db.close()
    except Exception as e:
        logger.warning("Failed to track LLM usage for %s: %s", agent_type, e)


# ---------------------------------------------------------------------------
# User-level tracking (publishes on Redis Stream → Kotlin backend)
# ---------------------------------------------------------------------------

_TOKEN_USAGE_STREAM = "scrapalot:stream:token_usage"


def increment_token_usage(
    _db: Session,
    user_id: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float = 0.0,
    is_system_provider: bool = True,
) -> bool:
    """Publish a per-user token usage event to Redis Streams.

    Uses Streams (not Pub/Sub) for guaranteed delivery. Token usage
    increments are idempotent, so no SAGA wrapper is needed.

    Returns:
        ``True`` if the event published successfully.
    """
    try:
        from src.main.utils.redis.client import get_redis_client

        redis_client = get_redis_client()
        fields = {
            "event_id": str(uuid4()),
            "type": "TOKEN_USAGE_RECORDED",
            "source": "scrapalot-chat",
            "timestamp": datetime.now(UTC).isoformat(),
            "user_id": user_id,
            "input_tokens": str(input_tokens),
            "output_tokens": str(output_tokens),
            "cost_usd": str(cost_usd),
            "is_system_provider": str(is_system_provider).lower(),
        }
        redis_client.xadd(_TOKEN_USAGE_STREAM, fields, maxlen=10000)
        logger.debug(
            "Published token usage event: user=%s, in=%d, out=%d",
            user_id,
            input_tokens,
            output_tokens,
        )
        return True
    except Exception as e:
        logger.warning("Failed to publish token usage event: %s", e)
        return False
