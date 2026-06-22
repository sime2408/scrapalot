package com.scrapalot.gateway.config

import io.grpc.ManagedChannel
import io.grpc.ManagedChannelBuilder
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.util.concurrent.TimeUnit

/**
 * gRPC client configuration for calling scrapalot-backend services
 */
@Configuration
class GrpcClientConfig {

    @Value("\${grpc.client.backend.host:scrapalot-backend}")
    private lateinit var backendHost: String

    @Value("\${grpc.client.backend.port:9090}")
    private var backendPort: Int = 9090

    @Value("\${grpc.client.backend.timeout-ms:5000}")
    private var timeoutMs: Long = 5000

    @Bean
    fun backendGrpcChannel(): ManagedChannel {
        return ManagedChannelBuilder
            .forAddress(backendHost, backendPort)
            .usePlaintext() // No TLS for internal communication
            .keepAliveTime(30, TimeUnit.SECONDS)
            .keepAliveTimeout(5, TimeUnit.SECONDS)
            .build()
    }

    @Bean
    fun grpcClientTimeout(): Long = timeoutMs
}
