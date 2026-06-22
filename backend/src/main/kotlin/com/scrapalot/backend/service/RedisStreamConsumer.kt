package com.scrapalot.backend.service

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.utils.ensureConsumerGroup
import jakarta.annotation.PostConstruct
import jakarta.annotation.PreDestroy
import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.context.event.ContextClosedEvent
import org.springframework.context.event.EventListener
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.connection.stream.Consumer
import org.springframework.data.redis.connection.stream.MapRecord
import org.springframework.data.redis.connection.stream.ReadOffset
import org.springframework.data.redis.connection.stream.StreamOffset
import org.springframework.data.redis.connection.stream.StreamReadOptions
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Component
import java.math.BigDecimal
import java.time.Duration
import java.util.UUID

private val logger = KotlinLogging.logger {}

@Component
class RedisStreamConsumer(
    @param:Qualifier("streamStringRedisTemplate")
    private val stringRedisTemplate: StringRedisTemplate,
    private val modelProviderSyncService: ModelProviderSyncService,
    private val tokenUsageService: TokenUsageService,
    private val redisEventPublisher: RedisEventPublisher,
    private val objectMapper: ObjectMapper,
    private val aiGenerationService: AiGenerationService,
    private val collectionService: CollectionService,
) {
    companion object {
        const val CONSUMER_GROUP = "cg-scrapalot-backend"
        const val CONSUMER_NAME = "scrapalot-backend-0"
        val STREAMS =
            listOf(
                RedisEventPublisher.STREAM_MODEL_PROVIDERS,
                RedisEventPublisher.STREAM_TOKEN_USAGE,
                RedisEventPublisher.STREAM_COLLECTION_SUMMARY,
            )
    }

    @Volatile private var running = false
    private var consumerThread: Thread? = null

    @PostConstruct
    fun start() {
        STREAMS.forEach { ensureConsumerGroup(stringRedisTemplate, it, CONSUMER_GROUP) }
        recoverPendingMessages()
        running = true
        consumerThread =
            Thread(::consumerLoop, "redis-stream-consumer-scrapalot-backend").apply {
                isDaemon = true
                start()
            }
        logger.info("Redis Stream consumer started for streams: $STREAMS")
    }

    /**
     * Spring's LettuceConnectionFactory is a SmartLifecycle with phase Int.MAX_VALUE,
     * so it stops BEFORE @PreDestroy hooks fire on default-phase beans. If we wait until
     * @PreDestroy to flip `running`, the consumer thread is mid-XREADGROUP when the
     * factory is closed and spams "LettuceConnectionFactory has been STOPPED" errors
     * for ~5s before exit. Listening for ContextClosedEvent flips the flag earlier.
     */
    @EventListener
    fun onContextClosed(event: ContextClosedEvent) {
        running = false
        consumerThread?.interrupt()
    }

    @PreDestroy
    fun stop() {
        running = false
        consumerThread?.apply {
            interrupt()
            join(5000)
        }
        logger.info("Redis Stream consumer stopped")
    }

    // ── Pending recovery ─────────────────────────────────────────────────────

    private fun recoverPendingMessages() {
        val ops = stringRedisTemplate.opsForStream<String, String>()
        STREAMS.forEach { streamKey ->
            runCatching {
                ops
                    .pending(
                        streamKey,
                        CONSUMER_GROUP,
                        org.springframework.data.domain.Range
                            .unbounded<String>(),
                        100L
                    ).filterNot { it.elapsedTimeSinceLastDelivery.toMillis() < 30_000 }
                    .forEach { entry ->
                        runCatching {
                            ops
                                .claim(streamKey, CONSUMER_GROUP, CONSUMER_NAME, Duration.ofMillis(30_000), entry.id)
                                .forEach { record ->
                                    processRecord(record.stream ?: streamKey, record)
                                    ops.acknowledge(CONSUMER_GROUP, record)
                                }
                        }.onFailure { logger.warn { "Failed to claim ${entry.idAsString} on $streamKey: ${it.message}" } }
                    }
                logger.info("Recovered pending messages on $streamKey")
            }.onFailure { logger.warn { "Pending recovery failed on $streamKey: ${it.message}" } }
        }
    }

    // ── Consumer loop ────────────────────────────────────────────────────────

    private fun consumerLoop() {
        val ops = stringRedisTemplate.opsForStream<String, String>()
        val offsets = STREAMS.map { StreamOffset.create(it, ReadOffset.lastConsumed()) }.toTypedArray()
        val readOpts = StreamReadOptions.empty().count(10).block(Duration.ofSeconds(5))

        while (running) {
            try {
                ops
                    .read(Consumer.from(CONSUMER_GROUP, CONSUMER_NAME), readOpts, *offsets)
                    ?.forEach { record ->
                        val stream = record.stream ?: return@forEach
                        runCatching {
                            processRecord(stream, record)
                            ops.acknowledge(CONSUMER_GROUP, record)
                        }.onFailure { logger.error(it) { "Failed to process event on $stream, will retry" } }
                    }
            } catch (_: InterruptedException) {
                break
            } catch (e: Exception) {
                if (!running) break
                if (isFactoryStopped(e)) {
                    logger.info("Redis connection factory stopped; exiting consumer loop")
                    break
                }
                logger.error(e) { "Redis stream consumer error: ${e.message}. Reconnecting in 5s..." }
                runCatching { Thread.sleep(5000) }
            }
        }
    }

    private fun isFactoryStopped(e: Throwable): Boolean {
        val factory = stringRedisTemplate.connectionFactory as? LettuceConnectionFactory
        if (factory != null && !factory.isRunning) return true
        var cause: Throwable? = e
        while (cause != null) {
            if (cause.message?.contains("STOPPED", ignoreCase = true) == true) return true
            cause = cause.cause
        }
        return false
    }

    // ── Record dispatch ──────────────────────────────────────────────────────

    private fun processRecord(
        streamKey: String,
        record: MapRecord<String, String, String>
    ) {
        val fields = record.value
        if (fields.containsKey("init")) return
        when (streamKey) {
            RedisEventPublisher.STREAM_MODEL_PROVIDERS -> handleModelProviderEvent(fields)
            RedisEventPublisher.STREAM_TOKEN_USAGE -> handleTokenUsageEvent(fields)
            RedisEventPublisher.STREAM_COLLECTION_SUMMARY -> handleCollectionSummaryEvent(fields)
            else -> logger.debug { "Unknown stream: $streamKey" }
        }
    }

    // ── Collection memory digest events ──────────────────────────────────────

    private fun handleCollectionSummaryEvent(fields: Map<String, String>) {
        if (fields["type"] != "COLLECTION_SUMMARY_UPDATED") return
        val collectionId = fields["collection_id"]?.let { runCatching { UUID.fromString(it) }.getOrNull() } ?: return
        val description = fields["description"]?.takeIf { it.isNotBlank() } ?: return
        runCatching {
            collectionService.applyGeneratedDescription(collectionId, description)
        }.onFailure { e ->
            logger.error(e) { "Failed to apply collection digest for $collectionId" }
        }
    }

    // ── Model provider events ────────────────────────────────────────────────

    private fun handleModelProviderEvent(fields: Map<String, String>) {
        val eventType = fields["type"] ?: return
        val providerId =
            fields["provider_id"]
                ?: fields["payload_json"]?.let { objectMapper.readTree(it).get("provider_id")?.asText() }
                ?: return
        val sagaId = fields["saga_id"]
        val payload = fields["payload_json"]?.let { objectMapper.readTree(it) }

        logger.debug("Processing model provider event: {} for provider: {}", eventType, providerId)

        runCatching {
            when (eventType) {
                "MODEL_PROVIDER_CREATED", "MODEL_PROVIDER_UPDATED" -> {
                    payload?.let { modelProviderSyncService.handleProviderCreatedOrUpdated(it) }
                    aiGenerationService.evictChatModelCache()
                }
                "MODEL_PROVIDER_DELETED" -> {
                    modelProviderSyncService.handleProviderDeleted(providerId)
                    aiGenerationService.evictChatModelCache()
                }
                "MODEL_PROVIDER_MODELS_SYNCED" -> modelProviderSyncService.handleModelsSynced(providerId)
            }
            sagaId?.let { publishSagaAck(it, "ACK") }
        }.onFailure { e ->
            logger.error(e) { "Failed to handle model provider event: $eventType" }
            sagaId?.let { publishSagaAck(it, "NACK", e.message) }
            throw e
        }
    }

    // ── Token usage events ───────────────────────────────────────────────────

    private fun handleTokenUsageEvent(fields: Map<String, String>) {
        if (fields["type"] != "TOKEN_USAGE_RECORDED") return
        val userId = fields["user_id"] ?: return

        // Token usage may come as top-level fields or nested in payload_json
        val payload = fields["payload_json"]?.let { objectMapper.readTree(it) }
        tokenUsageService.incrementUsage(
            userId = UUID.fromString(userId),
            inputTokens = payload?.get("input_tokens")?.asLong() ?: fields["input_tokens"]?.toLongOrNull() ?: 0L,
            outputTokens = payload?.get("output_tokens")?.asLong() ?: fields["output_tokens"]?.toLongOrNull() ?: 0L,
            costUsd = BigDecimal(payload?.get("cost_usd")?.asText() ?: fields["cost_usd"] ?: "0"),
        )
    }

    // ── SAGA helpers ─────────────────────────────────────────────────────────

    private fun publishSagaAck(
        sagaId: String,
        status: String,
        error: String? = null
    ) = redisEventPublisher.publishToStream(
        RedisEventPublisher.STREAM_SAGA_ACK,
        buildMap {
            put("saga_id", sagaId)
            put("status", status)
            put("source", "scrapalot-backend")
            error?.let { put("error", it) }
        }
    )
}
