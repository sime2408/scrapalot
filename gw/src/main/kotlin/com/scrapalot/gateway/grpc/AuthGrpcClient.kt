package com.scrapalot.gateway.grpc

import com.scrapalot.backend.grpc.auth.AuthServiceGrpcKt
import com.scrapalot.backend.grpc.auth.ValidateAPIKeyRequest
import com.scrapalot.backend.grpc.auth.ValidateAPIKeyResponse
import com.scrapalot.backend.grpc.auth.validateAPIKeyRequest
import io.grpc.ManagedChannel
import io.grpc.StatusException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component

/**
 * gRPC client for AuthService (scrapalot-backend)
 *
 * Provides API key validation via gRPC
 */
@Component
class AuthGrpcClient(
    private val backendGrpcChannel: ManagedChannel,
    private val grpcClientTimeout: Long
) {

    private val logger = LoggerFactory.getLogger(AuthGrpcClient::class.java)
    private val authStub = AuthServiceGrpcKt.AuthServiceCoroutineStub(backendGrpcChannel)

    /**
     * Validate API key via gRPC call to scrapalot-backend
     *
     * @param apiKey The API key to validate (format: scp-xxxx)
     * @return ValidateAPIKeyResponse with validation result
     */
    fun validateAPIKey(apiKey: String): ValidateAPIKeyResponse? {
        return try {
            runBlocking {
                withTimeout(grpcClientTimeout) {
                    val request = validateAPIKeyRequest {
                        this.apiKey = apiKey
                    }

                    logger.debug("Validating API key via gRPC: ${apiKey.take(10)}...")
                    val response = authStub.validateAPIKey(request)

                    if (response.valid) {
                        logger.info("API key validated successfully: userId=${response.userId}")
                    } else {
                        logger.warn("API key validation failed")
                    }

                    response
                }
            }
        } catch (e: StatusException) {
            logger.error("gRPC error validating API key: ${e.status}", e)
            null
        } catch (e: Exception) {
            logger.error("Error validating API key: ${e.message}", e)
            null
        }
    }
}
