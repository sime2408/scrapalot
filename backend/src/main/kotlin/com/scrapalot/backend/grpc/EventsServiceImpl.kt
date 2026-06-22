package com.scrapalot.backend.grpc

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.grpc.common.StatusResponse
import com.scrapalot.backend.grpc.common.Timestamp
import com.scrapalot.backend.grpc.events.*
import com.scrapalot.backend.service.RedisEventPublisher
import com.scrapalot.backend.utils.grpcCall
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import mu.KotlinLogging
import net.devh.boot.grpc.server.service.GrpcService
import org.springframework.data.redis.connection.Message
import org.springframework.data.redis.listener.ChannelTopic
import org.springframework.data.redis.listener.RedisMessageListenerContainer
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import com.scrapalot.backend.grpc.common.UUID as ProtoUUID
import com.scrapalot.backend.service.Event as InternalEvent
import com.scrapalot.backend.service.EventType as InternalEventType

private val logger = KotlinLogging.logger {}

// Bidirectional enum mapping via name — works because gRPC and internal enums share identical names
private val grpcToInternal =
    EventType.entries.associateWith { grpc ->
        InternalEventType.entries.firstOrNull { it.name == grpc.name } ?: InternalEventType.SETTINGS_UPDATED
    }
private val internalToGrpc =
    InternalEventType.entries.associateWith { internal ->
        EventType.entries.firstOrNull { it.name == internal.name } ?: EventType.SETTINGS_UPDATED
    }

// Event type → Redis channel mapping
private val eventChannelMap =
    mapOf(
        "DOCUMENT" to RedisEventPublisher.CHANNEL_DOCUMENT_EVENTS,
        "COLLECTION" to RedisEventPublisher.CHANNEL_COLLECTION_EVENTS,
        "WORKSPACE" to RedisEventPublisher.CHANNEL_WORKSPACE_EVENTS,
        "NOTE" to RedisEventPublisher.CHANNEL_NOTE_EVENTS,
        "USER" to RedisEventPublisher.CHANNEL_USER_EVENTS,
        "SETTINGS" to RedisEventPublisher.CHANNEL_SETTINGS_EVENTS,
    )

@Suppress("HasPlatformType") // gRPC grpcCall { } infers return type from proto builder — explicit types would be verbose
@GrpcService
class EventsServiceImpl(
    private val redisEventPublisher: RedisEventPublisher,
    private val redisMessageListenerContainer: RedisMessageListenerContainer,
    private val objectMapper: ObjectMapper,
) : EventsServiceGrpcKt.EventsServiceCoroutineImplBase() {
    private val activeSubscriptions = ConcurrentHashMap<String, org.springframework.data.redis.connection.MessageListener>()

    override suspend fun publishEvent(request: EventMessage) =
        grpcCall {
            val channel =
                eventChannelMap.entries
                    .firstOrNull { request.type.name.startsWith(it.key) }
                    ?.value
                    ?: RedisEventPublisher.CHANNEL_ALL_EVENTS

            @Suppress("UNCHECKED_CAST")
            val payload =
                request.payload.takeIf { it.isNotBlank() }?.let {
                    runCatching { objectMapper.readValue(it, Map::class.java) as Map<String, Any> }.getOrDefault(mapOf("raw" to it))
                } ?: emptyMap()

            redisEventPublisher.publishEvent(
                channel,
                InternalEvent(
                    id = if (request.hasEventId()) UUID.fromString(request.eventId.value) else UUID.randomUUID(),
                    type = grpcToInternal[request.type] ?: InternalEventType.SETTINGS_UPDATED,
                    source = request.source.ifBlank { "grpc" },
                    timestamp = if (request.hasTimestamp()) Instant.ofEpochSecond(request.timestamp.seconds, request.timestamp.nanos.toLong()) else Instant.now(),
                    userId = request.optionalUuid { userId },
                    workspaceId = request.optionalUuid { workspaceId },
                    collectionId = request.optionalUuid { collectionId },
                    documentId = request.optionalUuid { documentId },
                    noteId = request.optionalUuid { noteId },
                    payload = payload,
                    metadata = request.metadataMap,
                )
            )

            logger.info { "Published event: ${request.type} to channel: $channel" }
            StatusResponse
                .newBuilder()
                .setSuccess(true)
                .setMessage("Event published successfully")
                .build()
        }

    override fun subscribeToEvents(request: EventSubscription): Flow<EventMessage> =
        callbackFlow {
            val subscriptionId = UUID.randomUUID().toString()
            val subscribedTypes = request.eventTypesList.toSet()
            logger.info { "New event subscription: $subscriptionId for types: $subscribedTypes" }

            val listener =
                org.springframework.data.redis.connection.MessageListener { message: Message, _: ByteArray? ->
                    runCatching {
                        val event = objectMapper.readValue(String(message.body), InternalEvent::class.java)
                        val grpcType = internalToGrpc[event.type] ?: return@MessageListener
                        if (subscribedTypes.isNotEmpty() && grpcType !in subscribedTypes) return@MessageListener
                        if (request.hasUserId() && event.userId?.toString() != request.userId.value) return@MessageListener
                        if (request.hasWorkspaceId() && event.workspaceId?.toString() != request.workspaceId.value) return@MessageListener
                        trySend(event.toEventMessage(grpcType))
                    }.onFailure { logger.error(it) { "Error processing Redis message" } }
                }

            redisMessageListenerContainer.addMessageListener(listener, ChannelTopic(RedisEventPublisher.CHANNEL_ALL_EVENTS))
            activeSubscriptions[subscriptionId] = listener
            logger.info { "Subscription $subscriptionId active" }

            awaitClose {
                logger.info { "Closing subscription: $subscriptionId" }
                redisMessageListenerContainer.removeMessageListener(listener)
                activeSubscriptions.remove(subscriptionId)
            }
        }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private fun Any?.toProto() = ProtoUUID.newBuilder().setValue(toString()).build()

    private fun Instant.toTs() =
        Timestamp
            .newBuilder()
            .setSeconds(epochSecond)
            .setNanos(nano)
            .build()

    private inline fun <T> T.optionalUuid(getter: T.() -> ProtoUUID): UUID? = runCatching { getter().value.takeIf { it.isNotBlank() }?.let { UUID.fromString(it) } }.getOrNull()

    private fun InternalEvent.toEventMessage(grpcType: EventType) =
        EventMessage
            .newBuilder()
            .setEventId(id.toProto())
            .setType(grpcType)
            .setSource(source)
            .setTimestamp(timestamp.toTs())
            .setPayload(objectMapper.writeValueAsString(payload))
            .putAllMetadata(metadata)
            .apply {
                userId?.let { setUserId(it.toProto()) }
                workspaceId?.let { setWorkspaceId(it.toProto()) }
                collectionId?.let { setCollectionId(it.toProto()) }
                documentId?.let { setDocumentId(it.toProto()) }
                noteId?.let { setNoteId(it.toProto()) }
            }.build()
}
