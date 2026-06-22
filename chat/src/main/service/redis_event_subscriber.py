"""
Redis Streams event subscriber for cross-service synchronization.

Consumes events from Redis Streams (replacing Pub/Sub) with consumer groups
and XACK for guaranteed delivery. Handles SAGA ACK responses for cross-DB
consistency with the Kotlin backend.

Streams consumed:
- scrapalot:stream:collections → collection_workspace_map
- scrapalot:stream:workspaces → collection_workspace_map
- scrapalot:stream:connectors → connector cache
- scrapalot:stream:user_settings → user_settings (SAGA-coordinated)
- scrapalot:stream:annotations → annotation change notifications (K→P, no local storage)
- scrapalot:stream:message_feedback → memify EMA reweighting on Entity nodes / edges
"""

from datetime import UTC, datetime
import json
import threading
from typing import Any
from uuid import UUID

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Subscriber state
_subscriber_thread: threading.Thread | None = None
_stop_event = threading.Event()
_health_stats: dict[str, Any] = {
    "running": False,
    "last_event_at": None,
    "processed": 0,
    "failed": 0,
}

# Redis Streams to consume (replacing pub/sub channels)
_STREAMS = {
    "scrapalot:stream:collections": ">",
    "scrapalot:stream:workspaces": ">",
    "scrapalot:stream:connectors": ">",
    "scrapalot:stream:mcp_servers": ">",
    "scrapalot:stream:user_settings": ">",
    "scrapalot:stream:annotations": ">",
    "scrapalot:stream:message_feedback": ">",
}

_CONSUMER_GROUP = "cg-scrapalot-chat"
_CONSUMER_NAME = "scrapalot-chat-0"

# Dead letter queue key
_DLQ_KEY = "scrapalot:dlq:cwm_sync"
_DLQ_MAX_SIZE = 1000

# SAGA ACK stream
_SAGA_ACK_STREAM = "scrapalot:stream:saga_ack"


def _get_db_session():
    """Create a new database session for thread-safe usage."""
    from src.main.config.database import SessionLocal

    return SessionLocal()


def _send_saga_ack(redis_client, saga_id: str, status: str, error: str = "") -> None:
    """Send a SAGA ACK/NACK response to the saga_ack stream."""
    try:
        fields = {
            "saga_id": saga_id,
            "status": status,
            "source": "scrapalot-chat",
        }
        if error:
            fields["error"] = error
        redis_client.xadd(_SAGA_ACK_STREAM, fields, maxlen=10000)
        logger.debug("Sent SAGA %s for saga_id=%s", status, saga_id)
    except Exception as e:
        logger.error("Failed to send SAGA ACK for saga_id=%s: %s", saga_id, e)


# ==================== Event Handlers ====================


def _parse_graph_tier(payload: dict[str, Any]) -> tuple[int | None, bool]:
    """Parse the knowledge-graph build tier from a collection payload/snapshot entry.

    Wire format (Kotlin sends a string): "" = inherit-from-parent (NULL), "0"/"1"/"2"
    = explicit tier, key absent = field not carried. Returns (value, provided) where
    `provided` tells the upsert to set the column (possibly to NULL) vs leave it alone.
    """
    if "graph_tier" not in payload:
        return None, False
    raw = payload.get("graph_tier")
    if raw in (None, ""):
        return None, True  # explicit inherit-from-parent
    try:
        return int(raw), True
    except (TypeError, ValueError):
        return None, True


def _handle_collection_created(fields: dict[str, Any]) -> None:
    """Handle COLLECTION_CREATED event by upserting the mapping."""
    from src.main.service.collection_workspace_cache import upsert_collection_workspace

    db = _get_db_session()
    try:
        payload = _extract_payload(fields)
        description = payload.get("description") or None
        parent_id_str = payload.get("parent_collection_id")
        parent_collection_id = UUID(parent_id_str) if parent_id_str and parent_id_str != "" else None
        depth = int(payload.get("depth", 0))
        # Collection-create rarely carries a
        # custom_instructions value (the UI editor is edit-only), but
        # forward whatever Kotlin sends to keep the cache in lockstep.
        if "custom_instructions" in payload:
            custom_instructions: str | None = payload.get("custom_instructions") or ""
        else:
            custom_instructions = None
        graph_tier, graph_tier_provided = _parse_graph_tier(payload)
        upsert_collection_workspace(
            db=db,
            collection_id=UUID(fields["collection_id"]),
            workspace_id=UUID(fields["workspace_id"]),
            owner_user_id=UUID(payload.get("owner_user_id", fields.get("user_id", ""))),
            collection_name=payload.get("collection_name"),
            workspace_name=payload.get("workspace_name"),
            description=description,
            parent_collection_id=parent_collection_id,
            depth=depth,
            custom_instructions=custom_instructions,
            graph_tier=graph_tier,
            graph_tier_provided=graph_tier_provided,
        )
        logger.debug(
            "Synced COLLECTION_CREATED: %s (parent: %s, depth: %d, graph_tier: %s)",
            fields.get("collection_id"),
            parent_collection_id,
            depth,
            graph_tier if graph_tier_provided else "—",
        )

        # Auto-generate description if empty
        if not description:
            _schedule_description_generation(UUID(fields["collection_id"]))
    finally:
        db.close()


def _handle_collection_updated(fields: dict[str, Any]) -> None:
    """Handle COLLECTION_UPDATED event by upserting the mapping (without auto-generating description)."""
    from src.main.service.collection_workspace_cache import upsert_collection_workspace

    db = _get_db_session()
    try:
        payload = _extract_payload(fields)
        description = payload.get("description") or None
        parent_id_str = payload.get("parent_collection_id")
        parent_collection_id = UUID(parent_id_str) if parent_id_str and parent_id_str != "" else None
        depth = int(payload.get("depth", 0))
        # Kotlin sends "" when the user cleared the
        # textarea and the actual prose otherwise; missing key (None)
        # means a legacy producer that doesn't carry the field, so we
        # leave the cached value alone. upsert_collection_workspace
        # distinguishes these three cases.
        if "custom_instructions" in payload:
            custom_instructions: str | None = payload.get("custom_instructions") or ""
        else:
            custom_instructions = None
        graph_tier, graph_tier_provided = _parse_graph_tier(payload)
        upsert_collection_workspace(
            db=db,
            collection_id=UUID(fields["collection_id"]),
            workspace_id=UUID(fields["workspace_id"]),
            owner_user_id=UUID(payload.get("owner_user_id", fields.get("user_id", ""))),
            collection_name=payload.get("collection_name"),
            workspace_name=payload.get("workspace_name"),
            description=description,
            parent_collection_id=parent_collection_id,
            depth=depth,
            custom_instructions=custom_instructions,
            graph_tier=graph_tier,
            graph_tier_provided=graph_tier_provided,
        )
        logger.debug(
            "Synced COLLECTION_UPDATED: %s (parent: %s, ci_len=%d, graph_tier: %s)",
            fields.get("collection_id"),
            parent_collection_id,
            len(custom_instructions) if custom_instructions else 0,
            graph_tier if graph_tier_provided else "—",
        )
    finally:
        db.close()


def _handle_collection_deleted(fields: dict[str, Any]) -> None:
    """Handle COLLECTION_DELETED event by removing the mapping and cleaning up Neo4j."""
    from src.main.service.collection_workspace_cache import delete_collection_workspace

    collection_id = fields["collection_id"]

    db = _get_db_session()
    try:
        delete_collection_workspace(db=db, collection_id=UUID(collection_id))
        logger.debug("Synced COLLECTION_DELETED: %s", collection_id)
    finally:
        db.close()

    # Clean up Neo4j graph nodes for all documents in this collection
    _schedule_collection_graph_cleanup(collection_id)


def _schedule_collection_graph_cleanup(collection_id: str) -> None:
    """Schedule async Neo4j cleanup for a deleted collection via the event loop."""
    import asyncio

    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(_cleanup_collection_graph_async(collection_id), loop)
        else:
            logger.debug("Event loop not running, skipping graph cleanup for collection %s", collection_id)
    except RuntimeError:
        logger.debug("No event loop available, skipping graph cleanup for collection %s", collection_id)


async def _cleanup_collection_graph_async(collection_id: str) -> None:
    """Delete all Neo4j nodes for a collection."""
    try:
        from src.main.service.graph.graph_structure_service import GraphStructureService

        service = GraphStructureService()
        deleted = await service.delete_collection_structure(collection_id)
        if deleted > 0:
            logger.info("Cleaned up %d Neo4j nodes for deleted collection %s", deleted, collection_id)
    except Exception as e:
        logger.warning("Failed to clean up Neo4j for collection %s: %s", collection_id, str(e))


def _handle_workspace_updated(fields: dict[str, Any]) -> None:
    """Handle WORKSPACE_UPDATED event by updating workspace_name."""
    from src.main.service.collection_workspace_cache import update_workspace_name

    db = _get_db_session()
    try:
        payload = _extract_payload(fields)
        workspace_name = payload.get("workspace_name")
        if workspace_name:
            update_workspace_name(
                db=db,
                workspace_id=UUID(fields["workspace_id"]),
                workspace_name=str(workspace_name),
            )
            logger.debug("Synced WORKSPACE_UPDATED: %s", fields.get("workspace_id"))
    finally:
        db.close()


def _handle_workspace_deleted(fields: dict[str, Any]) -> None:
    """Handle WORKSPACE_DELETED event by removing all collection mappings."""
    from src.main.service.collection_workspace_cache import delete_workspace_collections

    db = _get_db_session()
    try:
        delete_workspace_collections(db=db, workspace_id=UUID(fields["workspace_id"]))
        logger.debug("Synced WORKSPACE_DELETED: %s", fields.get("workspace_id"))
    finally:
        db.close()


def _handle_connector_created(fields: dict[str, Any]) -> None:
    """Handle CONNECTOR_CREATED event by upserting the connector."""
    from src.main.service.connector_cache import upsert_connector

    db = _get_db_session()
    try:
        payload = _extract_payload(fields)
        connector_id = payload.get("connector_id", fields.get("connector_id", ""))
        if not connector_id:
            return
        upsert_connector(
            db=db,
            connector_id=UUID(connector_id),
            workspace_id=UUID(fields.get("workspace_id", payload.get("workspace_id", ""))),
            name=payload.get("name", ""),
            connector_type=payload.get("connector_type", ""),
            sync_enabled=payload.get("sync_enabled", True),
            source_path=payload.get("source_path"),
        )
        logger.debug("Synced CONNECTOR_CREATED: %s", connector_id)
    finally:
        db.close()


def _handle_connector_updated(fields: dict[str, Any]) -> None:
    """Handle CONNECTOR_UPDATED event by upserting the connector."""
    _handle_connector_created(fields)


def _handle_connector_deleted(fields: dict[str, Any]) -> None:
    """Handle CONNECTOR_DELETED event by removing the connector and children."""
    from src.main.service.connector_cache import delete_connector

    db = _get_db_session()
    try:
        payload = _extract_payload(fields)
        connector_id = payload.get("connector_id", fields.get("connector_id", ""))
        if not connector_id:
            return
        delete_connector(db=db, connector_id=UUID(connector_id))
        logger.debug("Synced CONNECTOR_DELETED: %s", connector_id)
    finally:
        db.close()


def _handle_mcp_server_created(fields: dict[str, Any]) -> None:
    """Handle MCP_SERVER_CREATED event by upserting the per-user MCP server."""
    from src.main.service.mcp_server_cache import upsert_mcp_server

    db = _get_db_session()
    try:
        payload = _extract_payload(fields)
        server_id = payload.get("server_id", fields.get("server_id", ""))
        user_id = fields.get("user_id", payload.get("user_id", ""))
        if not server_id or not user_id:
            return
        upsert_mcp_server(
            db=db,
            server_id=UUID(server_id),
            user_id=UUID(user_id),
            name=payload.get("name", ""),
            transport=payload.get("transport", "http"),
            url=payload.get("url", ""),
            auth_token=payload.get("auth_token") or None,
            headers=payload.get("headers") or None,
            enabled=payload.get("enabled", True),
            tool_prefix=payload.get("tool_prefix") or None,
            description=payload.get("description") or None,
        )
        logger.debug("Synced MCP_SERVER_CREATED: %s", server_id)
    finally:
        db.close()


def _handle_mcp_server_updated(fields: dict[str, Any]) -> None:
    """Handle MCP_SERVER_UPDATED event by upserting the MCP server."""
    _handle_mcp_server_created(fields)


def _handle_mcp_server_deleted(fields: dict[str, Any]) -> None:
    """Handle MCP_SERVER_DELETED event by removing the MCP server."""
    from src.main.service.mcp_server_cache import delete_mcp_server

    db = _get_db_session()
    try:
        payload = _extract_payload(fields)
        server_id = payload.get("server_id", fields.get("server_id", ""))
        if not server_id:
            return
        delete_mcp_server(db=db, server_id=UUID(server_id))
        logger.debug("Synced MCP_SERVER_DELETED: %s", server_id)
    finally:
        db.close()


def _handle_sync_destination_created(fields: dict[str, Any]) -> None:
    """Handle SYNC_DESTINATION_CREATED event by upserting the destination."""
    from src.main.service.connector_cache import upsert_sync_destination

    db = _get_db_session()
    try:
        payload = _extract_payload(fields)
        dest_id = payload.get("destination_id", "")
        connector_id = payload.get("connector_id", fields.get("connector_id", ""))
        if not dest_id or not connector_id:
            return
        upsert_sync_destination(
            db=db,
            destination_id=UUID(dest_id),
            connector_id=UUID(connector_id),
            destination_type=payload.get("destination_type", "collection"),
            collection_id=UUID(payload["collection_id"]) if payload.get("collection_id") else None,
        )
        logger.debug("Synced SYNC_DESTINATION_CREATED: %s", dest_id)
    finally:
        db.close()


def _handle_sync_destination_deleted(fields: dict[str, Any]) -> None:
    """Handle SYNC_DESTINATION_DELETED event by removing the destination."""
    from src.main.service.connector_cache import delete_sync_destination

    db = _get_db_session()
    try:
        payload = _extract_payload(fields)
        dest_id = payload.get("destination_id", "")
        if not dest_id:
            return
        delete_sync_destination(db=db, destination_id=UUID(dest_id))
        logger.debug("Synced SYNC_DESTINATION_DELETED: %s", dest_id)
    finally:
        db.close()


def _handle_annotation_changed(fields: dict[str, Any]) -> None:
    """Handle ANNOTATION_CREATED/UPDATED/DELETED events from Kotlin.

    These are notification-only events. Python does not store annotations
    (Kotlin is the owner). The handler logs the change for observability
    and can be extended to invalidate RAG annotation caches if needed.
    """
    event_type = fields.get("type", "UNKNOWN")
    document_id = fields.get("document_id", "")
    user_id = fields.get("user_id", "")
    annotation_id = fields.get("annotation_id", "")

    logger.debug(
        "Annotation event %s: annotation=%s, document=%s, user=%s",
        event_type,
        annotation_id[:8] if annotation_id else "N/A",
        document_id[:8] if document_id else "N/A",
        user_id[:8] if user_id else "N/A",
    )


def _handle_user_setting_sync(fields: dict[str, Any], redis_client) -> None:
    """Handle user setting sync event (SAGA-coordinated)."""
    saga_id = fields.get("saga_id", "")
    if not saga_id:
        logger.warning("User setting sync event missing saga_id, skipping")
        return

    db = _get_db_session()
    try:
        from src.main.service.user_settings_service import UserSettingsService

        service = UserSettingsService(db)
        user_id = fields["user_id"]
        setting_key = fields["setting_key"]
        operation = fields.get("operation", "UPSERT")

        if operation == "DELETE":
            service.delete_setting(user_id, setting_key)
        else:
            setting_value_json = fields.get("setting_value_json", "{}")
            value = json.loads(setting_value_json)
            service.set_setting(user_id, setting_key, value)

        # ACK — Kotlin can commit
        _send_saga_ack(redis_client, saga_id, "ACK")
        logger.debug("SAGA ACK for user setting: key=%s, user=%s", setting_key, user_id)
    except Exception as e:
        logger.error("SAGA NACK for user setting sync: %s", e)
        _send_saga_ack(redis_client, saga_id, "NACK", str(e))
    finally:
        db.close()


def _schedule_description_generation(collection_id: UUID) -> None:
    """Schedule async description generation for a collection via the event loop."""
    import asyncio

    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(_generate_description_async(collection_id), loop)
        else:
            logger.debug("Event loop not running, skipping description generation for %s", collection_id)
    except RuntimeError:
        logger.debug("No event loop available, skipping description generation for %s", collection_id)


async def _generate_description_async(collection_id: UUID) -> None:
    """Generate and store a description for a collection."""
    try:
        from src.main.service.collection_description_service import generate_and_store_description

        await generate_and_store_description(collection_id)
    except Exception as e:
        logger.warning("Failed to auto-generate description for collection %s: %s", collection_id, e)


def _handle_message_feedback(fields: dict[str, Any]) -> None:
    """Apply Memify EMA reweighting to graph elements touched by an AI answer.

    Stream payload comes from Kotlin RedisEventPublisher.publishMessageFeedback().
    Bad records (missing UUIDs, removal feedback) are dropped silently — feedback
    removal does not call back; the previous EMA state stays.
    """
    from src.main.service.graph.memify_service import apply_feedback_weights, parse_feedback_event

    event = parse_feedback_event(fields)
    if event is None:
        return
    try:
        apply_feedback_weights(event)
    except Exception as exc:  # never let memify failures stop the consumer
        logger.warning("Memify failed for message_id=%s: %s", fields.get("message_id"), exc)


# Event type → handler mapping (for stream events with a "type" field)
_EVENT_HANDLERS = {
    "COLLECTION_CREATED": _handle_collection_created,
    "COLLECTION_UPDATED": _handle_collection_updated,
    "COLLECTION_DELETED": _handle_collection_deleted,
    "WORKSPACE_UPDATED": _handle_workspace_updated,
    "WORKSPACE_DELETED": _handle_workspace_deleted,
    "CONNECTOR_CREATED": _handle_connector_created,
    "CONNECTOR_UPDATED": _handle_connector_updated,
    "CONNECTOR_DELETED": _handle_connector_deleted,
    "MCP_SERVER_CREATED": _handle_mcp_server_created,
    "MCP_SERVER_UPDATED": _handle_mcp_server_updated,
    "MCP_SERVER_DELETED": _handle_mcp_server_deleted,
    "SYNC_DESTINATION_CREATED": _handle_sync_destination_created,
    "SYNC_DESTINATION_DELETED": _handle_sync_destination_deleted,
    "ANNOTATION_CREATED": _handle_annotation_changed,
    "ANNOTATION_UPDATED": _handle_annotation_changed,
    "ANNOTATION_DELETED": _handle_annotation_changed,
}


# ==================== Helpers ====================


def _extract_payload(fields: dict[str, Any]) -> dict[str, Any]:
    """Extract payload from stream fields (may be inline or JSON-encoded)."""
    payload_json = fields.get("payload_json")
    if payload_json:
        try:
            return json.loads(str(payload_json))
        except (json.JSONDecodeError, TypeError) as e:
            logger.debug("payload_json not decodable, treating fields as inline payload: %s", e)
    # Fields without payload_json — payload was inlined in the event (e.g., user_settings)
    return fields


def _push_to_dlq(redis_client, stream_key: str, fields: dict[str, Any], error: str) -> None:
    """Push a failed event to the dead letter queue."""
    try:
        dlq_entry = json.dumps(
            {
                "stream": stream_key,
                "fields": {k: str(v) for k, v in fields.items()},
                "error": str(error),
                "timestamp": datetime.now(UTC).isoformat(),
            }
        )
        redis_client.lpush(_DLQ_KEY, dlq_entry)
        redis_client.ltrim(_DLQ_KEY, 0, _DLQ_MAX_SIZE - 1)
    except Exception as dlq_err:
        logger.error("Failed to push to DLQ: %s", dlq_err)


# ==================== Stream Processing ====================


def _process_stream_event(stream_key: str, fields: dict[str, Any], redis_client) -> None:
    """Route a stream event to the appropriate handler."""

    # Decode bytes to strings if needed
    decoded = {}
    for k, v in fields.items():
        key = k.decode("utf-8") if isinstance(k, bytes) else k
        val = v.decode("utf-8") if isinstance(v, bytes) else v
        decoded[key] = val

    # Skip init messages
    if "init" in decoded:
        return

    # User settings stream has its own handler (SAGA-coordinated)
    if stream_key == "scrapalot:stream:user_settings":
        _handle_user_setting_sync(decoded, redis_client)
        _health_stats["processed"] += 1
        _health_stats["last_event_at"] = datetime.now(UTC).isoformat()
        return

    # Message feedback stream — Cognee-style EMA reweighting
    if stream_key == "scrapalot:stream:message_feedback":
        _handle_message_feedback(decoded)
        _health_stats["processed"] += 1
        _health_stats["last_event_at"] = datetime.now(UTC).isoformat()
        return

    event_type = decoded.get("type", "")
    handler = _EVENT_HANDLERS.get(event_type)

    if handler is None:
        logger.debug("Ignoring event type: %s on stream %s", event_type, stream_key)
        return

    handler(decoded)
    _health_stats["processed"] += 1
    _health_stats["last_event_at"] = datetime.now(UTC).isoformat()


def _ensure_consumer_groups(redis_client) -> None:
    """Idempotent creation of consumer groups for all streams."""
    import redis as redis_lib

    for stream_key in _STREAMS:
        try:
            redis_client.xgroup_create(stream_key, _CONSUMER_GROUP, id="0", mkstream=True)
            logger.info("Created consumer group %s on %s", _CONSUMER_GROUP, stream_key)
        except redis_lib.ResponseError as e:
            if "BUSYGROUP" not in str(e):
                raise

    # Also ensure the saga_ack stream exists for Python→Kotlin SAGAs
    try:
        redis_client.xgroup_create(_SAGA_ACK_STREAM, "cg-scrapalot-chat-saga", id="0", mkstream=True)
    except redis_lib.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


def _recover_pending_messages(redis_client) -> None:
    """Recover messages that were in-flight when the service last stopped."""
    for stream_key in _STREAMS:
        try:
            pending = redis_client.xpending_range(stream_key, _CONSUMER_GROUP, "-", "+", count=100)
            if not pending:
                continue

            for entry in pending:
                idle_ms = entry.get("time_since_delivered", 0)
                if idle_ms < 30000:  # Skip messages idle < 30s
                    continue

                msg_id = entry["message_id"]
                claimed = redis_client.xclaim(stream_key, _CONSUMER_GROUP, _CONSUMER_NAME, min_idle_time=30000, message_ids=[msg_id])
                for claimed_id, claimed_fields in claimed:
                    try:
                        _process_stream_event(stream_key, claimed_fields, redis_client)
                        redis_client.xack(stream_key, _CONSUMER_GROUP, claimed_id)
                    except Exception as e:
                        logger.warning("Failed to process recovered message %s on %s: %s", claimed_id, stream_key, e)

            logger.info("Recovered pending messages on %s", stream_key)
        except Exception as e:
            logger.warning("Failed to recover pending messages on %s: %s", stream_key, e)


def _stream_consumer_loop() -> None:
    """Main consumer loop using XREADGROUP. Auto-reconnects on errors."""

    from src.main.utils.redis.client import get_redis_client

    while not _stop_event.is_set():
        try:
            redis_client = get_redis_client()
            _ensure_consumer_groups(redis_client)
            _recover_pending_messages(redis_client)

            logger.info("Redis Stream consumer connected to streams: %s", list(_STREAMS.keys()))
            _health_stats["running"] = True

            while not _stop_event.is_set():
                try:
                    results = redis_client.xreadgroup(
                        groupname=_CONSUMER_GROUP,
                        consumername=_CONSUMER_NAME,
                        streams=_STREAMS,
                        count=10,
                        block=5000,
                    )
                except Exception as read_err:
                    if _stop_event.is_set():
                        break
                    raise read_err from read_err

                if not results:
                    continue

                # noinspection PyTypeChecker
                for stream_key_raw, messages in results:
                    stream_key = stream_key_raw.decode("utf-8") if isinstance(stream_key_raw, bytes) else stream_key_raw
                    for message_id, fields in messages:
                        try:
                            _process_stream_event(stream_key, fields, redis_client)
                            redis_client.xack(stream_key, _CONSUMER_GROUP, message_id)
                        except Exception as e:
                            logger.error("Failed to process stream event on %s (msgId=%s): %s", stream_key, message_id, e)
                            _health_stats["failed"] += 1
                            _push_to_dlq(redis_client, stream_key, fields, str(e))
                            # ACK anyway to avoid infinite retry — DLQ captures the failure
                            redis_client.xack(stream_key, _CONSUMER_GROUP, message_id)

        except Exception as e:
            logger.error("Redis stream consumer error: %s. Reconnecting in 5s...", e)
            _health_stats["running"] = False

        if not _stop_event.is_set():
            _stop_event.wait(timeout=5.0)

    _health_stats["running"] = False
    logger.info("Redis Stream consumer stopped")


# ==================== Snapshot Reconciliation ====================


def reconcile_from_snapshot() -> None:
    """
    Read the Redis snapshot written by Kotlin and bulk-upsert all mappings.
    Removes stale entries whose collection_id is not in the snapshot.
    """
    from src.main.service.collection_workspace_cache import upsert_collection_workspace

    try:
        # Snapshot is written by Kotlin backend which uses Redis DB 1.
        import os

        import redis as redis_lib

        redis_host = os.getenv("REDIS_HOST", "redis")
        redis_port = int(os.getenv("REDIS_PORT", "6379"))
        redis_password = os.getenv("REDIS_PASSWORD", "")
        kotlin_redis = redis_lib.Redis(
            host=redis_host,
            port=redis_port,
            password=redis_password,
            db=1,
            decode_responses=False,
            socket_timeout=5,
        )
        raw = kotlin_redis.get("scrapalot:sync:collection_workspace_snapshot")
        kotlin_redis.close()
        if not raw:
            logger.info("No collection_workspace snapshot found in Redis, skipping reconciliation")
            return

        raw_value: bytes | str = raw if isinstance(raw, (bytes, str)) else str(raw)
        if isinstance(raw_value, bytes):
            raw_value = raw_value.decode("utf-8")

        snapshot = json.loads(raw_value)
        if not isinstance(snapshot, list):
            logger.warning("Invalid snapshot format, expected list")
            return

        db = _get_db_session()
        try:
            snapshot_collection_ids = set()
            collections_needing_description = []
            for entry in snapshot:
                cid = entry.get("collection_id", "")
                wid = entry.get("workspace_id", "")
                uid = entry.get("owner_user_id", "")
                if not cid or not wid:
                    continue

                description = entry.get("description") or None
                snapshot_collection_ids.add(cid)
                # Legacy snapshots predate parent_collection_id / graph_tier — when a
                # field is absent, signal "not provided" so the upsert preserves the
                # existing (correct) value instead of clobbering the parent chain that
                # graph_tier inheritance walks.
                parent_provided = "parent_collection_id" in entry
                parent_id_str = entry.get("parent_collection_id")
                parent_collection_id = UUID(parent_id_str) if parent_id_str else None
                graph_tier, graph_tier_provided = _parse_graph_tier(entry)
                upsert_collection_workspace(
                    db=db,
                    collection_id=UUID(cid),
                    workspace_id=UUID(wid),
                    owner_user_id=UUID(uid) if uid else UUID("00000000-0000-0000-0000-000000000000"),
                    collection_name=entry.get("collection_name"),
                    workspace_name=entry.get("workspace_name"),
                    description=description,
                    parent_collection_id=parent_collection_id,
                    parent_provided=parent_provided,
                    graph_tier=graph_tier,
                    graph_tier_provided=graph_tier_provided,
                )
                if not description:
                    collections_needing_description.append(UUID(cid))

            # Remove stale entries not in the snapshot
            if snapshot_collection_ids:
                from sqlalchemy import text

                placeholders = ", ".join(f"'{cid}'" for cid in snapshot_collection_ids)
                db.execute(text(f"DELETE FROM collection_workspace_map WHERE collection_id NOT IN ({placeholders})"))
                db.commit()

            logger.info("Reconciled %d entries from collection_workspace snapshot", len(snapshot_collection_ids))

            # Backfill descriptions for collections without one
            if collections_needing_description:
                logger.info("Scheduling description generation for %d collections", len(collections_needing_description))
                for cid in collections_needing_description:
                    _schedule_description_generation(cid)
        finally:
            db.close()

    except Exception as e:
        logger.error("Failed to reconcile from collection_workspace snapshot: %s", e)

    # Reconcile connectors snapshot (also in Redis DB 1)
    _reconcile_connectors_snapshot()

    # Reconcile per-user MCP servers snapshot (also in Redis DB 1)
    _reconcile_mcp_servers_snapshot()


def _reconcile_connectors_snapshot() -> None:
    """Read the connectors snapshot from Redis DB 1 and bulk-upsert."""
    from src.main.service.connector_cache import upsert_connector, upsert_sync_destination

    try:
        import os

        import redis as redis_lib

        redis_host = os.getenv("REDIS_HOST", "redis")
        redis_port = int(os.getenv("REDIS_PORT", "6379"))
        redis_password = os.getenv("REDIS_PASSWORD", "")
        kotlin_redis = redis_lib.Redis(
            host=redis_host,
            port=redis_port,
            password=redis_password,
            db=1,
            decode_responses=False,
            socket_timeout=5,
        )
        raw = kotlin_redis.get("scrapalot:sync:connectors_snapshot")
        kotlin_redis.close()
        if not raw:
            logger.info("No connectors snapshot found in Redis, skipping reconciliation")
            return

        raw_value: bytes | str = raw if isinstance(raw, (bytes, str)) else str(raw)
        if isinstance(raw_value, bytes):
            raw_value = raw_value.decode("utf-8")

        snapshot = json.loads(raw_value)
        if not isinstance(snapshot, list):
            logger.warning("Invalid connectors snapshot format, expected list")
            return

        db = _get_db_session()
        try:
            count = 0
            for entry in snapshot:
                conn = entry.get("connector", {})
                conn_id = conn.get("id", "")
                ws_id = conn.get("workspace_id", "")
                if not conn_id or not ws_id:
                    continue

                upsert_connector(
                    db=db,
                    connector_id=UUID(conn_id),
                    workspace_id=UUID(ws_id),
                    name=conn.get("name", ""),
                    connector_type=conn.get("connector_type", ""),
                    credential_id=UUID(conn["credential_id"]) if conn.get("credential_id") else None,
                    sync_enabled=conn.get("sync_enabled", True),
                    sync_frequency=conn.get("sync_frequency", "daily"),
                    auto_sync=conn.get("auto_sync", False),
                    source_path=conn.get("source_path"),
                    file_filters=conn.get("file_filters"),
                    exclude_patterns=conn.get("exclude_patterns"),
                    sync_status=conn.get("sync_status", "idle"),
                )
                count += 1

                for dest in entry.get("sync_destinations", []):
                    dest_id = dest.get("id", "")
                    if not dest_id:
                        continue
                    upsert_sync_destination(
                        db=db,
                        destination_id=UUID(dest_id),
                        connector_id=UUID(conn_id),
                        destination_type=dest.get("destination_type", "collection"),
                        collection_id=UUID(dest["collection_id"]) if dest.get("collection_id") else None,
                        destination_path=dest.get("destination_path"),
                        auto_process=dest.get("auto_process", True),
                        chunking_strategy=dest.get("chunking_strategy"),
                        overwrite_existing=dest.get("overwrite_existing", True),
                        preserve_structure=dest.get("preserve_structure", False),
                        file_filters=dest.get("file_filters"),
                    )

            logger.info("Reconciled %d connectors from snapshot", count)
        finally:
            db.close()

    except Exception as e:
        logger.error("Failed to reconcile from connectors snapshot: %s", e)


def _reconcile_mcp_servers_snapshot() -> None:
    """Read the per-user MCP servers snapshot from Redis DB 1 and bulk-upsert."""
    from src.main.service.mcp_server_cache import upsert_mcp_server

    try:
        import os

        import redis as redis_lib

        redis_host = os.getenv("REDIS_HOST", "redis")
        redis_port = int(os.getenv("REDIS_PORT", "6379"))
        redis_password = os.getenv("REDIS_PASSWORD", "")
        kotlin_redis = redis_lib.Redis(
            host=redis_host,
            port=redis_port,
            password=redis_password,
            db=1,
            decode_responses=False,
            socket_timeout=5,
        )
        raw = kotlin_redis.get("scrapalot:sync:mcp_servers_snapshot")
        kotlin_redis.close()
        if not raw:
            logger.info("No mcp_servers snapshot found in Redis, skipping reconciliation")
            return

        raw_value: bytes | str = raw if isinstance(raw, (bytes, str)) else str(raw)
        if isinstance(raw_value, bytes):
            raw_value = raw_value.decode("utf-8")

        snapshot = json.loads(raw_value)
        if not isinstance(snapshot, list):
            logger.warning("Invalid mcp_servers snapshot format, expected list")
            return

        db = _get_db_session()
        try:
            count = 0
            for entry in snapshot:
                server_id = entry.get("id", "")
                user_id = entry.get("user_id", "")
                if not server_id or not user_id:
                    continue
                upsert_mcp_server(
                    db=db,
                    server_id=UUID(server_id),
                    user_id=UUID(user_id),
                    name=entry.get("name", ""),
                    transport=entry.get("transport", "http"),
                    url=entry.get("url", ""),
                    auth_token=entry.get("auth_token") or None,
                    headers=entry.get("headers") or None,
                    enabled=entry.get("enabled", True),
                    tool_prefix=entry.get("tool_prefix") or None,
                    description=entry.get("description") or None,
                )
                count += 1
            logger.info("Reconciled %d MCP servers from snapshot", count)
        finally:
            db.close()

    except Exception as e:
        logger.error("Failed to reconcile from mcp_servers snapshot: %s", e)


# ==================== Lifecycle ====================


def start_redis_event_subscriber() -> None:
    """Start the Redis Stream consumer: reconcile from snapshot, then start consumer thread."""
    global _subscriber_thread, _health_stats

    if _subscriber_thread is not None and _subscriber_thread.is_alive():
        logger.warning("Redis Stream consumer already running")
        return

    _stop_event.clear()
    _health_stats = {"running": False, "last_event_at": None, "processed": 0, "failed": 0}

    # Reconcile from snapshot before starting the live consumer
    try:
        reconcile_from_snapshot()
    except Exception as e:
        logger.error("Snapshot reconciliation failed, continuing with stream consumer: %s", e)

    _subscriber_thread = threading.Thread(
        target=_stream_consumer_loop,
        name="redis-stream-consumer",
        daemon=True,
    )
    # noinspection PyUnresolvedReferences
    _subscriber_thread.start()
    logger.info("Redis Stream consumer thread started")


def stop_redis_event_subscriber() -> None:
    """Stop the Redis Stream consumer gracefully."""
    global _subscriber_thread

    if _subscriber_thread is None or not _subscriber_thread.is_alive():
        logger.info("Redis Stream consumer not running, nothing to stop")
        return

    logger.info("Stopping Redis Stream consumer...")
    _stop_event.set()
    _subscriber_thread.join(timeout=10.0)

    if _subscriber_thread.is_alive():
        logger.warning("Redis Stream consumer did not stop within 10s")
    else:
        logger.info("Redis Stream consumer stopped successfully")

    _subscriber_thread = None


def get_subscriber_health() -> dict[str, Any]:
    """Return subscriber health status."""
    return dict(_health_stats)
