package com.scrapalot.backend.service

import com.fasterxml.jackson.databind.ObjectMapper
import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.data.redis.connection.stream.StreamRecords
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Service
import java.time.Instant
import java.util.UUID

private val logger = KotlinLogging.logger {}

/**
 * Redis Event Publisher
 *
 * Publishes events to Redis Streams for guaranteed delivery between
 * Spring Boot backend and Python AI service. Consumer groups ensure
 * messages persist until acknowledged.
 *
 * Uses streamRedisTemplate (DB 0) for Streams — both Python and Kotlin
 * must use the same Redis DB for XADD/XREADGROUP to work.
 * Uses stringRedisTemplate (DB 1) for legacy pub/sub (DB-independent but
 * listeners are registered on DB 1).
 */
@Service
class RedisEventPublisher(
    private val stringRedisTemplate: StringRedisTemplate,
    @param:Qualifier("streamStringRedisTemplate")
    private val streamRedisTemplate: StringRedisTemplate,
    private val objectMapper: ObjectMapper
) {
    companion object {
        // Redis Streams for different event types (replacing pub/sub channels)
        const val STREAM_COLLECTION_EVENTS = "scrapalot:stream:collections"
        const val STREAM_WORKSPACE_EVENTS = "scrapalot:stream:workspaces"
        const val STREAM_ANNOTATION_EVENTS = "scrapalot:stream:annotations"
        const val STREAM_CONNECTOR_EVENTS = "scrapalot:stream:connectors"

        // K→P: per-user MCP client integrations (server url/transport/auth + enabled toggle)
        const val STREAM_MCP_SERVERS = "scrapalot:stream:mcp_servers"
        const val STREAM_USER_SETTINGS = "scrapalot:stream:user_settings"
        const val STREAM_MODEL_PROVIDERS = "scrapalot:stream:model_providers"
        const val STREAM_TOKEN_USAGE = "scrapalot:stream:token_usage"
        const val STREAM_SAGA_ACK = "scrapalot:stream:saga_ack"
        const val STREAM_MESSAGE_FEEDBACK = "scrapalot:stream:message_feedback"

        // P→K: Python publishes a regenerated collection-memory digest; we write it
        // to collections.description unless the user has manually edited it.
        const val STREAM_COLLECTION_SUMMARY = "scrapalot:stream:collection_summary"

        // Legacy pub/sub channels (kept for gRPC streaming fan-out via EventsServiceImpl)
        const val CHANNEL_DOCUMENT_EVENTS = "scrapalot:events:documents"
        const val CHANNEL_COLLECTION_EVENTS = "scrapalot:events:collections"
        const val CHANNEL_WORKSPACE_EVENTS = "scrapalot:events:workspaces"
        const val CHANNEL_NOTE_EVENTS = "scrapalot:events:notes"
        const val CHANNEL_USER_EVENTS = "scrapalot:events:users"
        const val CHANNEL_SETTINGS_EVENTS = "scrapalot:events:settings"
        const val CHANNEL_ALL_EVENTS = "scrapalot:events:all"

        // Max stream length (approximate trim)
        const val STREAM_MAX_LEN = 10000L
    }

    /**
     * Publish event to a Redis Stream with guaranteed delivery.
     * Returns the stream message ID.
     */
    fun publishToStream(
        streamKey: String,
        event: Event
    ): String {
        try {
            val fields =
                mutableMapOf(
                    "event_id" to event.id.toString(),
                    "type" to event.type.name,
                    "source" to event.source,
                    "timestamp" to event.timestamp.toString(),
                )
            event.userId?.let { fields["user_id"] = it.toString() }
            event.workspaceId?.let { fields["workspace_id"] = it.toString() }
            event.collectionId?.let { fields["collection_id"] = it.toString() }
            event.documentId?.let { fields["document_id"] = it.toString() }
            event.noteId?.let { fields["note_id"] = it.toString() }
            if (event.payload.isNotEmpty()) {
                fields["payload_json"] = objectMapper.writeValueAsString(event.payload)
            }

            val record = StreamRecords.string(fields).withStreamKey(streamKey)
            val messageId = streamRedisTemplate.opsForStream<String, String>().add(record)

            // Approximate trim to keep stream bounded
            streamRedisTemplate
                .opsForStream<String, String>()
                .trim(streamKey, STREAM_MAX_LEN, true)

            logger.debug { "Published event to stream $streamKey: ${event.type} (msgId=$messageId)" }
            return messageId?.value ?: ""
        } catch (e: Exception) {
            logger.error(e) { "Failed to publish event to stream $streamKey: ${event.type}" }
            return ""
        }
    }

    /**
     * Publish raw fields to a Redis Stream (for SAGA ACK and simple events).
     */
    fun publishToStream(
        streamKey: String,
        fields: Map<String, String>
    ): String {
        try {
            val record = StreamRecords.string(fields).withStreamKey(streamKey)
            val messageId = streamRedisTemplate.opsForStream<String, String>().add(record)
            streamRedisTemplate
                .opsForStream<String, String>()
                .trim(streamKey, STREAM_MAX_LEN, true)
            logger.debug { "Published raw event to stream $streamKey (msgId=$messageId)" }
            return messageId?.value ?: ""
        } catch (e: Exception) {
            logger.error(e) { "Failed to publish raw event to stream $streamKey" }
            return ""
        }
    }

    /**
     * Publish event to Redis pub/sub channel (legacy, for non-synced events).
     */
    fun publishEvent(
        channel: String,
        event: Event
    ) {
        try {
            val eventJson = objectMapper.writeValueAsString(event)
            stringRedisTemplate.convertAndSend(channel, eventJson)
            stringRedisTemplate.convertAndSend(CHANNEL_ALL_EVENTS, eventJson)
            logger.debug { "Published event to channel $channel: ${event.type}" }
        } catch (e: Exception) {
            logger.error(e) { "Failed to publish event to channel $channel: ${event.type}" }
        }
    }

    /**
     * Publish collection event to Redis Stream.
     */
    fun publishCollectionEvent(
        type: EventType,
        collectionId: UUID,
        workspaceId: UUID,
        userId: UUID,
        payload: Map<String, Any> = emptyMap()
    ) {
        val event =
            Event(
                id = UUID.randomUUID(),
                type = type,
                source = "scrapalot-backend",
                timestamp = Instant.now(),
                userId = userId,
                workspaceId = workspaceId,
                collectionId = collectionId,
                payload = payload
            )
        publishToStream(STREAM_COLLECTION_EVENTS, event)
    }

    /**
     * Publish workspace event to Redis Stream.
     */
    fun publishWorkspaceEvent(
        type: EventType,
        workspaceId: UUID,
        userId: UUID,
        payload: Map<String, Any> = emptyMap()
    ) {
        val event =
            Event(
                id = UUID.randomUUID(),
                type = type,
                source = "scrapalot-backend",
                timestamp = Instant.now(),
                userId = userId,
                workspaceId = workspaceId,
                payload = payload
            )
        publishToStream(STREAM_WORKSPACE_EVENTS, event)
    }

    /**
     * Publish note event
     */
    fun publishNoteEvent(
        type: EventType,
        noteId: UUID,
        collectionId: UUID,
        userId: UUID,
        payload: Map<String, Any> = emptyMap()
    ) {
        val event =
            Event(
                id = UUID.randomUUID(),
                type = type,
                source = "scrapalot-backend",
                timestamp = Instant.now(),
                userId = userId,
                collectionId = collectionId,
                noteId = noteId,
                payload = payload
            )
        publishEvent(CHANNEL_NOTE_EVENTS, event)
    }

    /**
     * Publish connector event to Redis Stream.
     */
    fun publishConnectorEvent(
        type: EventType,
        connectorId: UUID,
        workspaceId: UUID,
        payload: Map<String, Any> = emptyMap()
    ) {
        val event =
            Event(
                id = UUID.randomUUID(),
                type = type,
                source = "scrapalot-backend",
                timestamp = Instant.now(),
                workspaceId = workspaceId,
                payload = payload + mapOf("connector_id" to connectorId.toString())
            )
        publishToStream(STREAM_CONNECTOR_EVENTS, event)
    }

    /**
     * Publish per-user MCP server event to Redis Stream.
     *
     * Fire-and-forget (no SAGA ACK). Payload carries the full row (name,
     * transport, url, encrypted auth_token, headers, enabled, tool_prefix,
     * description) so Python can upsert its cache without a follow-up read.
     */
    fun publishMcpServerEvent(
        type: EventType,
        serverId: UUID,
        userId: UUID,
        payload: Map<String, Any> = emptyMap()
    ) {
        val event =
            Event(
                id = UUID.randomUUID(),
                type = type,
                source = "scrapalot-backend",
                timestamp = Instant.now(),
                userId = userId,
                payload = payload + mapOf("server_id" to serverId.toString())
            )
        publishToStream(STREAM_MCP_SERVERS, event)
    }

    /**
     * Publish annotation event to Redis Stream.
     */
    fun publishAnnotationEvent(
        type: EventType,
        annotationId: UUID,
        documentId: UUID,
        collectionId: UUID,
        userId: UUID,
        payload: Map<String, Any> = emptyMap()
    ) {
        val event =
            Event(
                id = UUID.randomUUID(),
                type = type,
                source = "scrapalot-backend",
                timestamp = Instant.now(),
                userId = userId,
                collectionId = collectionId,
                documentId = documentId,
                payload = payload + mapOf("annotation_id" to annotationId.toString())
            )
        publishToStream(STREAM_ANNOTATION_EVENTS, event)
    }

    /**
     * Publish message feedback event to Redis Stream (Memify).
     *
     * Python AI consumer applies EMA reweighting to touched Neo4j Entity nodes
     * and relationships. Event is fire-and-forget (no SAGA ACK required) — if
     * Python misses it the weights stay at their previous value.
     */
    fun publishMessageFeedback(
        messageId: UUID,
        sessionId: UUID,
        userId: UUID,
        feedback: Short,
        feedbackDetail: Short?,
        usedGraphElementIds: Map<String, Any>?,
        occurredAt: Instant = Instant.now()
    ): String {
        val fields =
            mutableMapOf(
                "message_id" to messageId.toString(),
                "session_id" to sessionId.toString(),
                "user_id" to userId.toString(),
                "feedback" to feedback.toString(),
                "occurred_at" to occurredAt.toString(),
            )
        feedbackDetail?.let { fields["feedback_detail"] = it.toString() }
        if (!usedGraphElementIds.isNullOrEmpty()) {
            fields["used_graph_element_ids_json"] = objectMapper.writeValueAsString(usedGraphElementIds)
        }
        return publishToStream(STREAM_MESSAGE_FEEDBACK, fields)
    }

    /**
     * Publish user setting sync event to Redis Stream (SAGA-coordinated).
     */
    fun publishUserSettingToStream(
        sagaId: String,
        userId: UUID,
        settingKey: String,
        settingValueJson: String,
        operation: String
    ): String {
        val fields =
            mapOf(
                "saga_id" to sagaId,
                "user_id" to userId.toString(),
                "setting_key" to settingKey,
                "setting_value_json" to settingValueJson,
                "operation" to operation,
                "timestamp" to Instant.now().toString(),
            )
        return publishToStream(STREAM_USER_SETTINGS, fields)
    }
}

/**
 * Event data class
 */
data class Event(
    val id: UUID,
    val type: EventType,
    val source: String, // "scrapalot-backend" or "scrapalot-chat"
    val timestamp: Instant,
    val userId: UUID? = null,
    val workspaceId: UUID? = null,
    val collectionId: UUID? = null,
    val documentId: UUID? = null,
    val noteId: UUID? = null,
    val payload: Map<String, Any> = emptyMap(),
    val metadata: Map<String, String> = emptyMap()
)

/**
 * Event types enum
 *
 * Some entries are only referenced by the Python AI service via Redis stream `type` field
 * (string comparison), so IntelliJ reports them as unused in Kotlin.
 */
@Suppress("unused")
enum class EventType {
    // Document events
    DOCUMENT_UPLOADED,
    DOCUMENT_PROCESSING_STARTED,
    DOCUMENT_PROCESSING_PROGRESS,
    DOCUMENT_PROCESSING_COMPLETED,
    DOCUMENT_PROCESSING_FAILED,
    DOCUMENT_DELETED,

    // Collection events
    COLLECTION_CREATED,
    COLLECTION_UPDATED,
    COLLECTION_DELETED,

    // Workspace events
    WORKSPACE_CREATED,
    WORKSPACE_UPDATED,
    WORKSPACE_DELETED,
    WORKSPACE_SHARED,

    // Note events
    NOTE_CREATED,
    NOTE_UPDATED,
    NOTE_DELETED,
    NOTE_SHARED,
    NOTE_SHARE_REMOVED,
    NOTE_COMMENT_ADDED,
    NOTE_COMMENT_UPDATED,
    NOTE_COMMENT_DELETED,
    NOTE_COMMENT_RESOLVED,
    NOTE_VERSION_RESTORED,
    NOTE_VERSION_SAVED,
    NOTE_COLLABORATION_CLEARED,

    // User events
    USER_REGISTERED,
    USER_UPDATED,
    USER_DELETED,

    // Settings events
    SETTINGS_UPDATED,

    // Chat/RAG events (from Python)
    CHAT_MESSAGE_RECEIVED,
    RAG_QUERY_STARTED,
    RAG_QUERY_COMPLETED,

    // Annotation events
    ANNOTATION_CREATED,
    ANNOTATION_UPDATED,
    ANNOTATION_DELETED,
    ANNOTATION_SHARED,
    ANNOTATION_SHARE_REVOKED,

    // Connector events
    CONNECTOR_CREATED,
    CONNECTOR_UPDATED,
    CONNECTOR_DELETED,
    SYNC_DESTINATION_CREATED,
    SYNC_DESTINATION_DELETED,

    // MCP integration events (per-user)
    MCP_SERVER_CREATED,
    MCP_SERVER_UPDATED,
    MCP_SERVER_DELETED,

    // Token usage events (from Python)
    TOKEN_USAGE_RECORDED
}
