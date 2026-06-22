"""
SAGA ACK waiter for Python → Kotlin cross-DB operations.

When Python initiates a cross-DB operation (e.g., model provider CRUD),
it publishes to a Redis Stream and waits for Kotlin to ACK via the
saga_ack stream before committing locally.
"""

import time

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_SAGA_ACK_STREAM = "scrapalot:stream:saga_ack"
_CONSUMER_GROUP = "cg-scrapalot-chat-saga"
_CONSUMER_NAME = "scrapalot-chat-saga-0"


def _ensure_consumer_group(redis_client) -> None:
    """Idempotent creation of the saga_ack consumer group for Python."""
    import redis as redis_lib

    try:
        redis_client.xgroup_create(_SAGA_ACK_STREAM, _CONSUMER_GROUP, id="0", mkstream=True)
    except redis_lib.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


def wait_for_saga_ack(saga_id: str, timeout: float = 10.0) -> dict | None:
    """
    Block until a SAGA ACK with matching saga_id appears in the stream.

    Args:
        saga_id: The SAGA ID to wait for.
        timeout: Max seconds to wait.

    Returns:
        Dict with 'status' ('ACK' or 'NACK') and optional 'error', or None on timeout.
    """
    from src.main.utils.redis.client import get_redis_client

    redis_client = get_redis_client()
    _ensure_consumer_group(redis_client)

    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        block_ms = int(min(remaining * 1000, 500))
        if block_ms <= 0:
            break

        try:
            results = redis_client.xreadgroup(
                groupname=_CONSUMER_GROUP,
                consumername=_CONSUMER_NAME,
                streams={_SAGA_ACK_STREAM: ">"},
                count=10,
                block=block_ms,
            )

            if not results:
                continue

            # noinspection PyTypeChecker
            for _stream_key_raw, messages in results:
                for message_id, fields in messages:
                    # Decode bytes
                    decoded = {}
                    for k, v in fields.items():
                        key = k.decode("utf-8") if isinstance(k, bytes) else k
                        val = v.decode("utf-8") if isinstance(v, bytes) else v
                        decoded[key] = val

                    # Always ACK — even if not our saga_id
                    redis_client.xack(_SAGA_ACK_STREAM, _CONSUMER_GROUP, message_id)

                    if decoded.get("saga_id") == saga_id:
                        status = decoded.get("status", "NACK")
                        error = decoded.get("error")
                        logger.debug("Received SAGA %s for saga_id=%s", status, saga_id)
                        return {"status": status, "error": error}

        except Exception as e:
            logger.warning("Error reading saga_ack stream: %s", e)
            time.sleep(0.1)

    logger.warning("SAGA ACK timeout for saga_id=%s after %.1fs", saga_id, timeout)
    return None
