package com.scrapalot.backend.utils

import mu.KotlinLogging
import org.springframework.data.redis.connection.stream.ReadOffset
import org.springframework.data.redis.connection.stream.StreamRecords
import org.springframework.data.redis.core.StringRedisTemplate

private val logger = KotlinLogging.logger {}

/** Check whether the exception (or its cause) indicates the consumer group already exists. */
private fun isBusyGroupException(e: Exception): Boolean = e.message?.contains("BUSYGROUP") == true || e.cause?.message?.contains("BUSYGROUP") == true

/**
 * Idempotent consumer group creation for Redis Streams.
 * Creates the stream with a dummy entry if it does not exist yet.
 */
fun ensureConsumerGroup(
    redisTemplate: StringRedisTemplate,
    streamKey: String,
    groupName: String
) {
    val ops = redisTemplate.opsForStream<String, String>()
    try {
        ops.createGroup(streamKey, ReadOffset.from("0"), groupName)
        logger.info("Created consumer group $groupName on $streamKey")
    } catch (e: Exception) {
        if (isBusyGroupException(e)) {
            logger.debug { "Consumer group $groupName already exists on $streamKey" }
        } else {
            // Stream may not exist yet — create it with a dummy entry
            try {
                ops.add(
                    StreamRecords.string(mapOf("init" to "true")).withStreamKey(streamKey)
                )
                ops.createGroup(streamKey, ReadOffset.from("0"), groupName)
                logger.info("Created stream and consumer group $groupName on $streamKey")
            } catch (e2: Exception) {
                if (!isBusyGroupException(e2)) {
                    logger.error(e2) { "Failed to create consumer group $groupName on $streamKey" }
                }
            }
        }
    }
}
