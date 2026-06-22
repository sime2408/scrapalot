package com.scrapalot.backend.controller.auth

import com.scrapalot.backend.domain.auth.APIKey
import com.scrapalot.backend.domain.auth.User
import com.scrapalot.backend.dto.APIKeyResponse
import com.scrapalot.backend.dto.CreateAPIKeyRequest
import com.scrapalot.backend.dto.GoogleMobileLoginRequest
import com.scrapalot.backend.dto.GoogleOAuthConfigResponse
import com.scrapalot.backend.dto.LoginRequest
import com.scrapalot.backend.dto.OAuthRequest
import com.scrapalot.backend.dto.TokenResponse
import com.scrapalot.backend.dto.UserResponse
import com.scrapalot.backend.service.APIKeyService
import com.scrapalot.backend.service.AuthService
import com.scrapalot.backend.service.GoogleOAuthService
import com.scrapalot.backend.service.SubscriptionService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.*
import jakarta.servlet.http.Cookie
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import jakarta.validation.Valid
import mu.KotlinLogging
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import java.net.URI
import java.time.Instant
import java.util.UUID

private val logger = KotlinLogging.logger {}

/**
 * OAuth and API Key management endpoints
 * Handle third-party authentication and API key operations
 */
@RestController
@RequestMapping("/api/v1/auth")
class AuthApiController(
    private val authService: AuthService,
    private val userService: UserService,
    private val apiKeyService: APIKeyService,
    private val googleOAuthService: GoogleOAuthService,
    private val subscriptionService: SubscriptionService
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    /**
     * Standard login with username/password (JSON)
     * POST /api/v1/auth/login
     */
    @PostMapping("/login")
    fun login(
        @Valid @RequestBody request: LoginRequest,
        httpRequest: HttpServletRequest,
        httpResponse: HttpServletResponse
    ): ResponseEntity<TokenResponse> =
        resultOf {
            logger.debug("Login attempt for user: {}", request.usernameOrEmail)
            val userAgent = httpRequest.getHeader("User-Agent")
            val tokens = authService.login(request.usernameOrEmail, request.password, userAgent)

            // Set HttpOnly cookies for cookie-based refresh fallback
            setAuthCookies(httpResponse, tokens)

            logger.info("Login successful for user: {}", request.usernameOrEmail)
            tokens
        }.fold(
            onSuccess = { ResponseEntity.ok(it) },
            onFailure = { exception ->
                logger.error(exception) { "Login failed for user ${request.usernameOrEmail}: ${exception.message}" }
                ResponseEntity.status(HttpStatus.UNAUTHORIZED).build()
            }
        )

    private fun setAuthCookies(
        response: HttpServletResponse,
        tokens: TokenResponse
    ) {
        if (tokens.refreshToken != null) {
            response.addCookie(buildSecureCookie("refresh_token", tokens.refreshToken, 30 * 24 * 60 * 60))
        }
        response.addCookie(buildSecureCookie("session_token", tokens.accessToken, 8 * 60 * 60))
    }

    private fun buildSecureCookie(
        name: String,
        value: String,
        maxAgeSeconds: Int
    ) = Cookie(name, value).apply {
        isHttpOnly = true
        secure = true
        path = "/"
        maxAge = maxAgeSeconds
        setAttribute("SameSite", "None")
    }

    /**
     * OAuth authentication (generic)
     * POST /api/v1/auth/oauth
     */
    @PostMapping("/oauth")
    fun oauth(
        @Valid @RequestBody request: OAuthRequest
    ): ResponseEntity<Map<String, Any>> =
        resultOf {
            val (user, tokens) =
                authService.registerOrLoginWithOAuth(
                    email = request.email,
                    firstName = request.firstName,
                    lastName = request.lastName,
                    profilePicture = request.profilePicture
                )

            mapOf(
                "user" to user.toResponse(),
                "tokens" to tokens
            )
        }.toResponseEntity()

    /**
     * Google OAuth callback
     * GET /api/v1/auth/google/callback?code=...
     *
     * Handles Google OAuth callback:
     * 1. Exchanges authorization code for access token
     * 2. Retrieves user info from Google
     * 3. Creates/updates user in a database
     * 4. Generates JWT tokens
     * 5. Redirects to the frontend with an access token
     */
    @GetMapping("/google/callback")
    fun googleCallback(
        @RequestParam code: String
    ): ResponseEntity<Void> =
        resultOf {
            logger.info { "Google OAuth callback received with code: ${code.take(10)}..." }

            // Exchange authorization code for an access token
            val tokenResponse =
                googleOAuthService
                    .exchangeCodeForToken(code)
                    .toResult("Failed to exchange authorization code for access token")
                    .getOrThrow()

            // Get user info from Google
            val userInfo =
                googleOAuthService
                    .getUserInfo(tokenResponse.accessToken)
                    .toResult("Failed to retrieve user information from Google")
                    .getOrThrow()

            logger.info { "Google user info retrieved: ${userInfo.email}" }

            // Find or create a user with OAuth
            val (user, tokens) =
                authService.registerOrLoginWithOAuth(
                    email = userInfo.email,
                    firstName = userInfo.givenName,
                    lastName = userInfo.familyName,
                    profilePicture = userInfo.picture
                )

            logger.info { "Google OAuth login successful for user ${user.id}" }

            // Redirect to frontend with access token
            val frontendUrl = googleOAuthService.getFrontendRedirectUrl(tokens.accessToken)

            ResponseEntity
                .status(HttpStatus.FOUND)
                .location(URI.create(frontendUrl))
                .build<Void>()
        }.fold(
            onSuccess = { it },
            onFailure = { exception ->
                logger.error(exception) { "Google OAuth callback failed: ${exception.message}" }
                ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build()
            }
        )

    /**
     * Native mobile Google Sign-In (Android Credential Manager).
     * POST /api/v1/auth/google/mobile
     *
     * The device obtains a Google ID token on its own; we verify the signature
     * and audience server-side, then reuse the OAuth register-or-login path.
     * When the account does not exist and create_if_missing=false, returns
     * account_exists=false (no tokens) so the app can ask for confirmation.
     */
    @PostMapping("/google/mobile")
    fun googleMobileLogin(
        @Valid @RequestBody request: GoogleMobileLoginRequest
    ): ResponseEntity<Map<String, Any>> =
        resultOf {
            val userInfo =
                googleOAuthService
                    .verifyIdToken(request.idToken)
                    .toResult("Invalid Google ID token")
                    .getOrThrow()

            val accountExists = authService.emailExists(userInfo.email)
            if (!accountExists && !request.createIfMissing) {
                mapOf(
                    "account_exists" to false,
                    "email" to userInfo.email
                )
            } else {
                val (user, tokens) =
                    authService.registerOrLoginWithOAuth(
                        email = userInfo.email,
                        firstName = userInfo.givenName,
                        lastName = userInfo.familyName,
                        profilePicture = userInfo.picture
                    )
                logger.info { "Google mobile login successful for user ${user.id} (created=${!accountExists})" }
                mapOf(
                    "account_exists" to true,
                    "user" to user.toResponse(),
                    "tokens" to tokens
                )
            }
        }.toResponseEntity()

    /**
     * Get Google OAuth configuration for frontend
     * GET /api/v1/auth/google/config
     */
    @GetMapping("/google/config")
    fun googleConfig(): ResponseEntity<GoogleOAuthConfigResponse> =
        resultOf {
            val config = googleOAuthService.getConfig()

            GoogleOAuthConfigResponse(
                clientId = config["client_id"] as String,
                redirectUri = config["redirect_uri"] as String,
                enabled = config["enabled"] as Boolean
            )
        }.toResponseEntity()

    // API Key Management

    @GetMapping("/api-keys")
    fun getAPIKeys(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<APIKeyResponse>> =
        resultOf {
            val userId = userDetails.userId()
            apiKeyService.getUserAPIKeys(userId).map { it.toResponse() }
        }.toResponseEntity()

    @PostMapping("/api-keys")
    fun createAPIKey(
        @AuthenticationPrincipal userDetails: UserDetails,
        @Valid @RequestBody request: CreateAPIKeyRequest
    ): ResponseEntity<APIKeyResponse> =
        resultOf {
            val userId = userDetails.userId()
            // Programmatic access has carried the api_access plan key since
            // migration 081 but was never enforced — Pro and above. Existing
            // keys stay listable/revocable after a downgrade.
            subscriptionService.requireFeature(userId, "api_access")
            val expiresAt = request.expiresAt?.let { Instant.parse(it) }

            val generatedKey =
                apiKeyService.createAPIKey(
                    userId = userId,
                    name = request.name,
                    expiresAt = expiresAt,
                    scopes = request.scopes
                )

            generatedKey.apiKey.toResponse().copy(
                plainTextKey = generatedKey.plainTextKey
            )
        }.toResponseEntity(HttpStatus.CREATED)

    @PatchMapping("/api-keys/{keyId}/toggle")
    fun toggleAPIKey(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable keyId: UUID
    ): ResponseEntity<APIKeyResponse> =
        resultOf {
            val userId = userDetails.userId()
            apiKeyService.toggleAPIKey(keyId, userId).toResponse()
        }.toResponseEntity()

    @DeleteMapping("/api-keys/{keyId}")
    fun deleteAPIKey(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable keyId: UUID
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            apiKeyService.deleteAPIKey(keyId, userId)
        }.toNoContentResponse()
}

// Extension functions for mapping entities to DTOs
private fun User.toResponse() =
    UserResponse(
        id = id.orThrow("User"),
        username = username,
        email = email,
        firstName = firstName,
        lastName = lastName,
        role = role,
        isActive = isActive,
        isExternal = isExternal,
        profilePicture = profilePicture,
        licenseAgreementConsent = licenseAgreementConsent,
        contentSharingConsent = contentSharingConsent,
        tourCompleted = tourCompleted,
        createdAt = createdAt.toString(),
        updatedAt = updatedAt.toString()
    )

private fun APIKey.toResponse() =
    APIKeyResponse(
        id = id.orThrow("APIKey"),
        name = name,
        keyPrefix = keyPrefix,
        plainTextKey = null, // Never return plaintext except on creation
        isActive = isActive,
        expiresAt = expiresAt?.toString(),
        scopes = scopes,
        createdAt = createdAt.toString(),
        lastUsedAt = lastUsedAt?.toString()
    )
