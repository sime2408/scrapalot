package com.scrapalot.backend.config

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.data.redis.connection.RedisConnectionFactory
import org.springframework.data.redis.connection.RedisStandaloneConfiguration
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.core.RedisTemplate
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.data.redis.listener.RedisMessageListenerContainer
import org.springframework.data.redis.serializer.GenericJackson2JsonRedisSerializer
import org.springframework.data.redis.serializer.StringRedisSerializer

/**
 * Redis Configuration
 *
 * Configures Redis connection and Streams for event-driven communication
 * between Spring Boot backend and Python AI service.
 *
 * Note: Redis is used for caching (RedisTemplate), Streams (consumer groups),
 * and residual pub/sub. @EnableRedisRepositories are NOT needed.
 */
@Configuration
class RedisConfig {
    @field:Value("\${redis.host:localhost}")
    private lateinit var redisHost: String

    @field:Value("\${redis.port:6379}")
    private var redisPort: Int = 6379

    @field:Value("\${redis.password:}")
    private var redisPassword: String? = null

    @field:Value("\${redis.database:0}")
    private var redisDatabase: Int = 0

    @Bean
    fun redisConnectionFactory(): RedisConnectionFactory {
        val config = RedisStandaloneConfiguration(redisHost, redisPort)
        if (!redisPassword.isNullOrBlank()) {
            config.setPassword(redisPassword)
        }
        config.database = redisDatabase
        return LettuceConnectionFactory(config)
    }

    @Bean
    fun redisTemplate(
        redisConnectionFactory: RedisConnectionFactory,
        objectMapper: ObjectMapper
    ): RedisTemplate<String, Any> {
        val template = RedisTemplate<String, Any>()
        template.connectionFactory = redisConnectionFactory

        // Use String serializer for keys
        template.keySerializer = StringRedisSerializer()
        template.hashKeySerializer = StringRedisSerializer()

        // Use JSON serializer for values
        val jsonSerializer = GenericJackson2JsonRedisSerializer(objectMapper)
        template.valueSerializer = jsonSerializer
        template.hashValueSerializer = jsonSerializer

        template.afterPropertiesSet()
        return template
    }

    @Bean
    fun stringRedisTemplate(redisConnectionFactory: RedisConnectionFactory): StringRedisTemplate {
        val template = StringRedisTemplate()
        template.connectionFactory = redisConnectionFactory
        template.afterPropertiesSet()
        return template
    }

    /**
     * Redis message listener container for gRPC streaming subscriptions.
     * Used by EventsServiceImpl for real-time event fan-out via pub/sub.
     * Cross-DB sync uses Redis Streams (RedisStreamConsumer) instead.
     */
    @Bean
    fun redisMessageListenerContainer(redisConnectionFactory: RedisConnectionFactory): RedisMessageListenerContainer {
        val container = RedisMessageListenerContainer()
        container.setConnectionFactory(redisConnectionFactory)
        return container
    }

    /**
     * Connection factory for shared Redis DB 0.
     * Used for Redis Streams (cross-service SAGA sync) and Python snapshot reads.
     *
     * Both Python and Kotlin Streams MUST operate on the same DB (0) for
     * XREADGROUP consumer groups to see each other's XADD messages.
     */
    @Bean
    fun streamRedisConnectionFactory(): RedisConnectionFactory {
        val config = RedisStandaloneConfiguration(redisHost, redisPort)
        if (!redisPassword.isNullOrBlank()) {
            config.setPassword(redisPassword)
        }
        config.database = 0
        return LettuceConnectionFactory(config).apply { afterPropertiesSet() }
    }

    @Bean("streamStringRedisTemplate")
    fun streamStringRedisTemplate(streamRedisConnectionFactory: RedisConnectionFactory): StringRedisTemplate {
        val template = StringRedisTemplate()
        template.connectionFactory = streamRedisConnectionFactory
        template.afterPropertiesSet()
        return template
    }
}
