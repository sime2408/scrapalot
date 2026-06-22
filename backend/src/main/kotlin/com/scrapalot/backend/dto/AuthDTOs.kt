package com.scrapalot.backend.dto

import com.fasterxml.jackson.annotation.JsonAlias
import com.fasterxml.jackson.annotation.JsonProperty
import jakarta.validation.constraints.*
import java.util.UUID

// Login Request
data class LoginRequest(
    @field:NotBlank(message = "Username or email is required")
    @field:JsonProperty("username_or_email")
    @field:JsonAlias("username", "usernameOrEmail")
    val usernameOrEmail: String,
    @field:NotBlank(message = "Password is required")
    val password: String
)

// Register Request
data class RegisterRequest(
    @field:NotBlank(message = "Username is required")
    @field:Size(min = 3, max = 50, message = "Username must be between 3 and 50 characters")
    @field:Pattern(regexp = "^[a-zA-Z0-9._-]+$", message = "Username can only contain letters, numbers, dots, underscores, and hyphens")
    val username: String,
    @field:NotBlank(message = "Email is required")
    @field:Email(message = "Invalid email format")
    val email: String,
    @field:NotBlank(message = "Password is required")
    @field:Size(min = 8, max = 128, message = "Password must be between 8 and 128 characters")
    val password: String,
    @field:Size(max = 100, message = "First name cannot exceed 100 characters")
    val firstName: String? = null,
    @field:Size(max = 100, message = "Last name cannot exceed 100 characters")
    val lastName: String? = null,
    val licenseAgreementConsent: Boolean = false,
    val contentSharingConsent: Boolean = false
)

// OAuth Request
data class OAuthRequest(
    @field:NotBlank(message = "Email is required")
    @field:Email(message = "Invalid email format")
    val email: String,
    @field:Size(max = 100, message = "First name cannot exceed 100 characters")
    val firstName: String? = null,
    @field:Size(max = 100, message = "Last name cannot exceed 100 characters")
    val lastName: String? = null,
    @field:Size(max = 2048, message = "Profile picture URL cannot exceed 2048 characters")
    val profilePicture: String? = null
)

// Token Response (OAuth2 standard format with snake_case)
// Note: refreshToken is nullable - sent as HTTP-only cookie, not in JSON response (for security)
data class TokenResponse(
    @field:JsonProperty("access_token")
    val accessToken: String,
    @field:JsonProperty("refresh_token")
    val refreshToken: String? = null, // Nullable - sent as cookie, not JSON
    @field:JsonProperty("expires_in")
    val expiresIn: Long,
    @field:JsonProperty("token_type")
    val tokenType: String = "bearer"
)

// Refresh Token Request
data class RefreshTokenRequest(
    @field:NotBlank(message = "Refresh token is required")
    @field:JsonProperty("refresh_token")
    @field:JsonAlias("refreshToken") // Also accept camelCase for compatibility
    val refreshToken: String
)

// API Key Request
data class CreateAPIKeyRequest(
    @field:NotBlank(message = "API key name is required")
    @field:Size(min = 1, max = 100, message = "API key name must be between 1 and 100 characters")
    val name: String,
    val expiresAt: String? = null,
    val scopes: Map<String, Any>? = null
)

// API Key Response
data class APIKeyResponse(
    val id: UUID,
    val name: String,
    val keyPrefix: String,
    val plainTextKey: String? = null, // Only returned on creation
    val isActive: Boolean,
    val expiresAt: String? = null,
    val scopes: Map<String, Any>? = null,
    val createdAt: String,
    val lastUsedAt: String? = null
)

// Invitation Token Validation Response
data class InvitationTokenResponse(
    val email: String,
    @field:JsonProperty("recipient_name")
    val recipientName: String?,
    @field:JsonProperty("expires_at")
    val expiresAt: String,
    @field:JsonProperty("user_exists")
    val userExists: Boolean = false
)

// Invitation Register Request
data class InvitationRegisterRequest(
    @field:NotBlank(message = "Token is required")
    val token: String,
    @field:NotBlank(message = "Username is required")
    @field:Size(min = 3, max = 50, message = "Username must be between 3 and 50 characters")
    @field:Pattern(regexp = "^[a-zA-Z0-9._-]+$", message = "Username can only contain letters, numbers, dots, underscores, and hyphens")
    val username: String,
    @field:NotBlank(message = "Password is required")
    @field:Size(min = 8, max = 128, message = "Password must be between 8 and 128 characters")
    val password: String,
    @field:Size(max = 100, message = "First name cannot exceed 100 characters")
    val firstName: String? = null,
    @field:Size(max = 100, message = "Last name cannot exceed 100 characters")
    val lastName: String? = null,
    val licenseAgreementConsent: Boolean = false,
    val contentSharingConsent: Boolean = false
)

// Google OAuth Configuration Response
data class GoogleOAuthConfigResponse(
    @field:JsonProperty("client_id")
    val clientId: String,
    @field:JsonProperty("redirect_uri")
    val redirectUri: String,
    val enabled: Boolean
)

// Native mobile Google Sign-In (Credential Manager id_token flow)
data class GoogleMobileLoginRequest(
    @field:NotBlank(message = "ID token is required")
    @field:JsonProperty("id_token")
    val idToken: String,
    // First call leaves this false so the app can ask the user to confirm
    // account creation; the retry after consent sets it true.
    @field:JsonProperty("create_if_missing")
    val createIfMissing: Boolean = false
)
