package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.common.Empty
import com.scrapalot.backend.grpc.desktop.*
import mu.KotlinLogging
import org.springframework.stereotype.Service

private val logger = KotlinLogging.logger {}

/**
 * gRPC client for Python DesktopService.
 *
 * Desktop mode authentication, verification, and health check.
 */
@Service
class DesktopGrpcClient(
    private val stub: DesktopServiceGrpcKt.DesktopServiceCoroutineStub
) {
    suspend fun initializeAuth(request: DesktopInitRequest): DesktopInitResponse {
        logger.info { "gRPC InitializeAuth" }
        return stub.initializeAuth(request)
    }

    suspend fun verifyAuth(request: VerifyAuthRequest): DesktopAuthResponse {
        logger.info { "gRPC VerifyAuth" }
        return stub.verifyAuth(request)
    }

    suspend fun health(): DesktopHealthResponse {
        logger.info { "gRPC Desktop Health" }
        return stub.health(Empty.getDefaultInstance())
    }

    suspend fun cloudInitialize(request: CloudDesktopInitRequest): DesktopInitResponse {
        logger.info { "gRPC CloudInitialize" }
        return stub.cloudInitialize(request)
    }
}
