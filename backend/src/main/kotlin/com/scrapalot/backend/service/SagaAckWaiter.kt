package com.scrapalot.backend.service

import com.scrapalot.backend.utils.ensureConsumerGroup
import jakarta.annotation.PostConstruct
import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.data.redis.connection.stream.Consumer
import org.springframework.data.redis.connection.stream.ReadOffset
import org.springframework.data.redis.connection.stream.StreamOffset
import org.springframework.data.redis.connection.stream.StreamReadOptions
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Component
import java.time.Duration
import java.time.Instant

private val logger = KotlinLogging.logger {}

data class SagaAck(
    val status: String,
    val error: String? = null
)

/**
 * Waits for SAGA acknowledgements from the saga_ack stream.
 *
 * Used by Kotlin services to block until Python confirms
 * it has processed and committed a cross-DB operation.
 */
@Component
class SagaAckWaiter(
    @param:Qualifier("streamStringRedisTemplate")
    private val stringRedisTemplate: StringRedisTemplate
) {
    companion object {
        const val SAGA_ACK_STREAM = RedisEventPublisher.STREAM_SAGA_ACK
        const val CONSUMER_GROUP = "cg-scrapalot-backend-saga"
        const val CONSUMER_NAME = "scrapalot-backend-saga-0"
    }

    @PostConstruct
    fun init() {
        ensureConsumerGroup(stringRedisTemplate, SAGA_ACK_STREAM, CONSUMER_GROUP)
    }

    /**
     * Block until an ACK with matching saga_id appears in the stream,
     * or until timeout expires.
     *
     * Returns null on timeout.
     */
    fun waitForAck(
        sagaId: String,
        timeout: Duration = Duration.ofSeconds(10)
    ): SagaAck? {
        val deadline = Instant.now().plus(timeout)
        val ops = stringRedisTemplate.opsForStream<String, String>()

        while (Instant.now().isBefore(deadline)) {
            val remaining = Duration.between(Instant.now(), deadline)
            val blockMs = remaining.toMillis().coerceAtMost(500).coerceAtLeast(50)

            try {
                val results =
                    ops.read(
                        Consumer.from(CONSUMER_GROUP, CONSUMER_NAME),
                        StreamReadOptions.empty().count(10).block(Duration.ofMillis(blockMs)),
                        StreamOffset.create(SAGA_ACK_STREAM, ReadOffset.lastConsumed())
                    )

                for (record in results ?: emptyList()) {
                    // Always acknowledge — even if it's for a different saga, we've consumed it
                    ops.acknowledge(CONSUMER_GROUP, record)

                    val recordSagaId = record.value["saga_id"]
                    if (recordSagaId == sagaId) {
                        val status = record.value["status"] ?: "NACK"
                        val error = record.value["error"]
                        logger.debug { "Received SAGA ACK for $sagaId: status=$status" }
                        return SagaAck(status, error)
                    }
                }
            } catch (e: Exception) {
                logger.warn { "Error reading saga_ack stream: ${e.message}" }
                Thread.sleep(100)
            }
        }

        logger.warn { "SAGA ACK timeout for saga_id=$sagaId after ${timeout.seconds}s" }
        return null
    }
}
