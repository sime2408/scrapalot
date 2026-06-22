package com.scrapalot.backend.grpc

import com.scrapalot.backend.domain.auth.User
import com.scrapalot.backend.grpc.auth.*
import com.scrapalot.backend.grpc.common.Timestamp
import com.scrapalot.backend.grpc.common.UUID
import com.scrapalot.backend.repository.UserRepository
import com.scrapalot.backend.security.JwtTokenProvider
import com.scrapalot.backend.service.APIKeyService
import com.scrapalot.backend.service.SubscriptionService
import com.scrapalot.backend.utils.grpcCall
import io.grpc.Status
import io.grpc.StatusException
import mu.KotlinLogging
import net.devh.boot.grpc.server.service.GrpcService

private val logger = KotlinLogging.logger {}

@Suppress("HasPlatformType") // gRPC grpcCall { } infers return type from proto builder — explicit types would be verbose
@GrpcService
class AuthServiceImpl(
    private val apiKeyService: APIKeyService,
    private val jwtTokenProvider: JwtTokenProvider,
    private val userRepository: UserRepository,
    private val subscriptionService: SubscriptionService,
) : AuthServiceGrpcKt.AuthServiceCoroutineImplBase() {
    // ── API Key validation ───────────────────────────────────────────────────

    override suspend fun validateAPIKey(request: ValidateAPIKeyRequest): ValidateAPIKeyResponse {
        if (request.apiKey.isBlank()) return invalidKeyResponse()
        return runCatching {
            apiKeyService.validateAPIKey(request.apiKey)?.let { key ->
                logger.debug { "API key validated: prefix=${key.keyPrefix}, userId=${key.userId}" }
                ValidateAPIKeyResponse
                    .newBuilder()
                    .setValid(true)
                    .setUserId(key.userId.toProto())
                    .setKeyId(key.id.toProto())
                    .build()
            } ?: run {
                logger.warn { "Invalid API key: prefix=${request.apiKey.take(8)}" }
                invalidKeyResponse()
            }
        }.onFailure { logger.error(it) { "Error validating API key" } }
            .getOrDefault(invalidKeyResponse())
    }

    private fun invalidKeyResponse() = ValidateAPIKeyResponse.newBuilder().setValid(false).build()

    // ── JWT validation ───────────────────────────────────────────────────────

    override suspend fun validateToken(request: ValidateTokenRequest): ValidateTokenResponse {
        if (request.token.isBlank()) return invalidTokenResponse()
        return runCatching {
            val token = request.token
            if (!jwtTokenProvider.validateToken(token)) return invalidTokenResponse()
            val username = jwtTokenProvider.getUsernameFromToken(token) ?: return invalidTokenResponse()
            val user = userRepository.findByEmailOrUsername(username)?.takeIf { it.isActive } ?: return invalidTokenResponse()

            logger.debug { "JWT validated: userId=${user.id}, username=${user.username}" }
            ValidateTokenResponse
                .newBuilder()
                .setValid(true)
                .setUserId(requireNotNull(user.id) { "User ID is null" }.toProto())
                .setUsername(user.username ?: "")
                .setEmail(user.email)
                .setRole(user.role)
                .build()
        }.onFailure { logger.error(it) { "Error validating JWT" } }
            .getOrDefault(invalidTokenResponse())
    }

    private fun invalidTokenResponse() = ValidateTokenResponse.newBuilder().setValid(false).build()

    // ── User lookup ──────────────────────────────────────────────────────────

    override suspend fun getCurrentUser(request: UUID) =
        grpcCall {
            val userId = java.util.UUID.fromString(request.value.requireNotBlank("User ID"))
            val user =
                userRepository.findById(userId).orElse(null)
                    ?: throw StatusException(Status.NOT_FOUND.withDescription("User not found: $userId"))
            check(user.isActive) { "User is not active" }
            logger.debug { "User found by ID: userId=${user.id}" }
            user.toUserInfo()
        }

    override suspend fun getUserByUsername(request: GetUserByUsernameRequest) =
        grpcCall {
            val username = request.username.requireNotBlank("Username")
            val user =
                userRepository.findByEmailOrUsername(username)
                    ?: throw StatusException(Status.NOT_FOUND.withDescription("User not found: $username"))
            check(user.isActive) { "User is not active" }
            logger.debug { "User found by username: userId=${user.id}" }
            user.toUserInfo()
        }

    // ── Subscription tier ────────────────────────────────────────────────────

    override suspend fun getUserSubscriptionTier(request: GetUserSubscriptionTierRequest) =
        grpcCall {
            val userId =
                when {
                    request.hasUserId() -> java.util.UUID.fromString(request.userId.value)
                    request.hasUsername() -> {
                        val user =
                            userRepository.findByEmailOrUsername(request.username)
                                ?: throw StatusException(Status.NOT_FOUND.withDescription("User not found: ${request.username}"))
                        requireNotNull(user.id) { "User ID is null" }
                    }
                    else -> throw StatusException(Status.INVALID_ARGUMENT.withDescription("Either user_id or username required"))
                }

            subscriptionService.getUserSubscriptionWithPlan(userId)?.let { (sub, plan) ->
                SubscriptionTierResponse
                    .newBuilder()
                    .setTier(plan.name.lowercase())
                    .setIsActive(sub.status == "active")
                    .setSubscribedAt(Timestamp.newBuilder().setSeconds(sub.subscribedAt?.epochSecond ?: 0).build())
                    .apply { sub.currentPeriodEnd?.let { setExpiresAt(Timestamp.newBuilder().setSeconds(it.epochSecond).build()) } }
                    .build()
            } ?: SubscriptionTierResponse
                .newBuilder()
                .setTier("researcher")
                .setIsActive(false)
                .build()
        }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private fun Any?.toProto() = UUID.newBuilder().setValue(toString()).build()

    private fun String.requireNotBlank(field: String): String = takeIf { it.isNotBlank() } ?: throw StatusException(Status.INVALID_ARGUMENT.withDescription("$field cannot be empty"))

    private fun User.toUserInfo() =
        UserInfo
            .newBuilder()
            .setId(requireNotNull(id) { "User ID is null" }.toProto())
            .setUsername(username ?: "")
            .setEmail(email)
            .setRole(role)
            .setIsActive(isActive)
            .setLicenseAgreementConsent(licenseAgreementConsent)
            .build()
}
