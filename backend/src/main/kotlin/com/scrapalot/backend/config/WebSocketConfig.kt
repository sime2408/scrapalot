package com.scrapalot.backend.config

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.security.JwtWebSocketHandshakeInterceptor
import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Lazy
import org.springframework.messaging.Message
import org.springframework.messaging.MessageChannel
import org.springframework.messaging.converter.DefaultContentTypeResolver
import org.springframework.messaging.converter.MappingJackson2MessageConverter
import org.springframework.messaging.converter.MessageConverter
import org.springframework.messaging.simp.config.ChannelRegistration
import org.springframework.messaging.simp.config.MessageBrokerRegistry
import org.springframework.messaging.simp.stomp.StompCommand
import org.springframework.messaging.simp.stomp.StompHeaderAccessor
import org.springframework.messaging.support.ChannelInterceptor
import org.springframework.messaging.support.MessageHeaderAccessor
import org.springframework.scheduling.TaskScheduler
import org.springframework.util.MimeTypeUtils
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker
import org.springframework.web.socket.config.annotation.StompEndpointRegistry
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer
import java.security.Principal

private val logger = KotlinLogging.logger {}

/**
 * WebSocket configuration for real-time communication.
 *
 * Features:
 * - STOMP protocol for message brokering
 * - JWT authentication for WebSocket connections
 * - Real-time note collaboration
 * - Document processing updates
 * - Job status notifications
 */
@Configuration
@EnableWebSocketMessageBroker
class WebSocketConfig(
    private val jwtWebSocketHandshakeInterceptor: JwtWebSocketHandshakeInterceptor,
    private val objectMapper: ObjectMapper,
    // Spring auto-creates messageBrokerTaskScheduler when @EnableWebSocketMessageBroker
    // is used. Reuse it for STOMP heartbeats instead of declaring our own bean —
    // a second TaskScheduler bean would leave @EnableScheduling without a clear
    // default and log a warning at startup ("none is named 'taskScheduler'"). @Lazy
    // breaks the circular dependency that would otherwise form between this config
    // and the broker-support config that declares the bean.
    @Lazy
    @Qualifier("messageBrokerTaskScheduler")
    private val messageBrokerTaskScheduler: TaskScheduler
) : WebSocketMessageBrokerConfigurer {
    override fun configureMessageConverters(messageConverters: MutableList<MessageConverter>): Boolean {
        val resolver = DefaultContentTypeResolver()
        resolver.defaultMimeType = MimeTypeUtils.APPLICATION_JSON
        val converter = MappingJackson2MessageConverter()
        converter.objectMapper = objectMapper
        converter.contentTypeResolver = resolver
        messageConverters.add(converter)
        return false
    }

    override fun configureClientInboundChannel(registration: ChannelRegistration) {
        registration.interceptors(
            object : ChannelInterceptor {
                override fun preSend(
                    message: Message<*>,
                    channel: MessageChannel
                ): Message<*> {
                    val accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor::class.java)
                    if (accessor != null && StompCommand.CONNECT == accessor.command) {
                        val userId = accessor.sessionAttributes?.get("userId") as? String
                        if (userId != null) {
                            accessor.user = Principal { userId }
                        }
                    }
                    return message
                }
            }
        )
    }

    override fun configureMessageBroker(registry: MessageBrokerRegistry) {
        // Enable a simple in-memory broker for sending messages to clients.
        // Destination prefixes: /topic (broadcast), /queue (per-user).
        // Heartbeat 10 s / 10 s in both directions — must be > 0 on each side
        // for STOMP negotiation to succeed (the spec uses "0 means none" so a
        // single 0 silences keep-alives entirely). The frontend already
        // negotiates 10 s in stomp-backend-service.ts:116-117. Without this
        // the broker emitted no keep-alives and any reverse-proxy idle-timeout
        // (gateway, npm, NAT) eventually reset the WebSocket with 1006.
        registry
            .enableSimpleBroker("/topic", "/queue")
            .setHeartbeatValue(longArrayOf(10_000L, 10_000L))
            .setTaskScheduler(messageBrokerTaskScheduler)

        // Prefix for messages from clients to server (e.g., @MessageMapping)
        registry.setApplicationDestinationPrefixes("/app")

        // Prefix for user-specific destinations
        registry.setUserDestinationPrefix("/user")

        logger.info { "📡 Message broker configured: /topic, /queue, /app, heartbeat 10s/10s" }
    }

    override fun registerStompEndpoints(registry: StompEndpointRegistry) {
        // STOMP endpoint at /stomp-direct/ws (matches Python backend path)
        registry
            .addEndpoint("/stomp-direct/ws")
            .setAllowedOriginPatterns(
                "https://scrapalot.app",
                "https://www.scrapalot.app",
                "http://localhost:*"
            ).addInterceptors(jwtWebSocketHandshakeInterceptor)
            .withSockJS()

        // Also, register without SockJS for native WebSocket clients
        registry
            .addEndpoint("/stomp-direct/ws")
            .setAllowedOriginPatterns(
                "https://scrapalot.app",
                "https://www.scrapalot.app",
                "http://localhost:*"
            ).addInterceptors(jwtWebSocketHandshakeInterceptor)

        // Backend-specific STOMP endpoint for workspace chat (routed via gateway /stomp-backend/ws)
        registry
            .addEndpoint("/stomp-backend/ws")
            .setAllowedOriginPatterns(
                "https://scrapalot.app",
                "https://www.scrapalot.app",
                "http://localhost:*"
            ).addInterceptors(jwtWebSocketHandshakeInterceptor)
            .withSockJS()

        registry
            .addEndpoint("/stomp-backend/ws")
            .setAllowedOriginPatterns(
                "https://scrapalot.app",
                "https://www.scrapalot.app",
                "http://localhost:*"
            ).addInterceptors(jwtWebSocketHandshakeInterceptor)

        // Alias endpoint at /stomp/ws to handle the gateway chat-websocket route fallback
        registry
            .addEndpoint("/stomp/ws")
            .setAllowedOriginPatterns(
                "https://scrapalot.app",
                "https://www.scrapalot.app",
                "http://localhost:*"
            ).addInterceptors(jwtWebSocketHandshakeInterceptor)

        logger.info { "🔌 STOMP endpoints registered: /stomp-direct/ws, /stomp-backend/ws, /stomp/ws (with JWT authentication)" }
    }
}
