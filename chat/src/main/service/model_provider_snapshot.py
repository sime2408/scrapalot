"""
Model Provider snapshot writer for Redis sync.

Writes a snapshot of all model providers + models to Redis so that
Kotlin backend can reconcile on startup. Also publishes events via
Redis Streams with SAGA coordination for cross-DB consistency.

Stream: scrapalot:stream:model_providers
Snapshot key: scrapalot:sync:model_providers_snapshot (Redis DB 0)
"""

import json
from typing import Any
from uuid import uuid4

from sqlalchemy.orm import Session

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Redis Stream for model provider events (replacing pub/sub channel)
STREAM_MODEL_PROVIDERS = "scrapalot:stream:model_providers"

# Snapshot key (in Redis DB 0)
SNAPSHOT_KEY = "scrapalot:sync:model_providers_snapshot"


def publish_model_provider_event(
    event_type: str,
    provider_id: str,
    payload: dict[str, Any],
    db: Session | None = None,
) -> None:
    """
    Publish a model provider event to Redis Stream with SAGA coordination.

    Kotlin must ACK the event before Python commits. If Kotlin does not
    respond within 10s, the operation raises an exception.

    Args:
        event_type: One of MODEL_PROVIDER_CREATED, MODEL_PROVIDER_UPDATED,
                    MODEL_PROVIDER_DELETED, MODEL_PROVIDER_MODELS_SYNCED
        provider_id: UUID string of the provider
        payload: Event payload (NEVER include api_key)
        db: Optional DB session to use for snapshot refresh
    """
    from src.main.service.saga_ack_waiter import wait_for_saga_ack
    from src.main.utils.redis.client import get_redis_client

    saga_id = str(uuid4())

    try:
        redis_client = get_redis_client()

        fields = {
            "saga_id": saga_id,
            "type": event_type,
            "provider_id": provider_id,
            "payload_json": json.dumps(payload),
        }
        redis_client.xadd(STREAM_MODEL_PROVIDERS, fields, maxlen=10000)
        logger.info("Published %s event for provider %s (saga_id=%s)", event_type, provider_id, saga_id)
    except Exception as e:
        logger.error("Failed to publish model provider event %s: %s", event_type, e)
        raise

    # Wait for Kotlin ACK (blocking, max 10s)
    ack = wait_for_saga_ack(saga_id, timeout=10.0)
    if ack is None or ack.get("status") != "ACK":
        error_detail = ack.get("error", "timeout") if ack else "timeout"
        raise RuntimeError("Kotlin backend did not confirm model provider sync: %s" % error_detail)

    # Kotlin confirmed — refresh snapshot
    if db is not None:
        write_model_providers_snapshot(db)
    else:
        try:
            from src.main.config.database import SessionLocal

            session = SessionLocal()
            try:
                write_model_providers_snapshot(session)
            finally:
                session.close()
        except Exception as e:
            logger.error("Failed to refresh snapshot after event: %s", e)


def _provider_to_dict(provider) -> dict[str, Any]:
    """Convert a ModelProvider to a dict safe for Redis (no api_key)."""
    return {
        "id": str(provider.id),
        "user_id": str(provider.user_id) if provider.user_id else None,
        "name": provider.name,
        "provider_type": provider.provider_type,
        "status": provider.status,
        "api_base": provider.api_base,
        "show_models": provider.show_models,
        "description": provider.description,
    }


def _model_to_dict(model) -> dict[str, Any]:
    """Convert a ModelProviderModel to a dict for Redis."""
    return {
        "id": str(model.id),
        "provider_id": str(model.provider_id),
        "model_name": model.model_name,
        "display_name": model.display_name,
        "model_type": model.model_type,
        "model_namespace": model.model_namespace,
        "context_window": model.context_window,
        "max_tokens": model.max_tokens,
        "dimensions": model.dimensions,
        "temperature_default": model.temperature_default,
        "input_cost": model.input_cost,
        "output_cost": model.output_cost,
        "supports_tools": model.supports_tools,
        "supports_image_generation": model.supports_image_generation,
        "supports_audio_input": model.supports_audio_input,
        "supports_audio_output": model.supports_audio_output,
        "supports_realtime": model.supports_realtime,
    }


def write_model_providers_snapshot(db: Session) -> None:
    """
    Read all providers + models from Python DB and write JSON snapshot
    to Redis key for Kotlin startup reconciliation.
    """
    try:
        from src.main.models.sqlmodel_providers import ModelProvider, ModelProviderModel
        from src.main.utils.redis.client import get_redis_client

        providers = db.query(ModelProvider).all()
        snapshot: list[dict[str, Any]] = []

        for p in providers:
            # noinspection PyTypeChecker
            models = db.query(ModelProviderModel).filter(ModelProviderModel.provider_id == p.id).all()

            snapshot.append(
                {
                    "provider": _provider_to_dict(p),
                    "models": [_model_to_dict(m) for m in models],
                }
            )

        redis_client = get_redis_client()
        redis_client.set(SNAPSHOT_KEY, json.dumps(snapshot))
        logger.info("Wrote model providers snapshot with %d providers", len(snapshot))

    except Exception as e:
        logger.error("Failed to write model providers snapshot: %s", e)
