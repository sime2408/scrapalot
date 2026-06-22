package com.scrapalot.backend.service

import com.fasterxml.jackson.annotation.JsonProperty
import com.google.api.client.googleapis.auth.oauth2.GoogleIdTokenVerifier
import com.google.api.client.http.javanet.NetHttpTransport
import com.google.api.client.json.gson.GsonFactory
import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.HttpEntity
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.MediaType
import org.springframework.stereotype.Service
import org.springframework.util.LinkedMultiValueMap
import org.springframework.util.MultiValueMap
import org.springframework.web.client.RestTemplate
import org.springframework.web.client.exchange
import org.springframework.web.client.postForEntity

private val logger = KotlinLogging.logger {}

/**
 * Google OAuth user info response
 */
data class GoogleUserInfo(
    val id: String,
    val email: String,
    val name: String,
    @field:JsonProperty("given_name")
    val givenName: String?,
    @field:JsonProperty("family_name")
    val familyName: String?,
    val picture: String?
)

/**
 * Google OAuth token response
 */
data class GoogleTokenResponse(
    @field:JsonProperty("access_token")
    val accessToken: String,
    @field:JsonProperty("token_type")
    val tokenType: String,
    @field:JsonProperty("expires_in")
    val expiresIn: Int,
    @field:JsonProperty("refresh_token")
    val refreshToken: String?,
    val scope: String?
)

/**
 * Google OAuth integration service
 */
@Service
class GoogleOAuthService(
    @param:Value("\${oauth.google.client-id}") private val clientId: String,
    @param:Value("\${oauth.google.client-secret}") private val clientSecret: String,
    @param:Value("\${oauth.google.redirect-uri}") private val redirectUri: String,
    @param:Value("\${oauth.google.frontend-url}") private val frontendUrl: String,
    @param:Value("\${oauth.google.enabled}") private val enabled: Boolean
) {
    private val restTemplate = RestTemplate()
    private val tokenUrl = "https://oauth2.googleapis.com/token"
    private val userInfoUrl = "https://www.googleapis.com/oauth2/v2/userinfo"

    // Verifies signatures against Google's JWKS (fetched + cached internally).
    // Audience = our web client ID, which the Android Credential Manager flow
    // uses as serverClientId — so mobile id_tokens carry this audience too.
    private val idTokenVerifier: GoogleIdTokenVerifier by lazy {
        GoogleIdTokenVerifier
            .Builder(NetHttpTransport(), GsonFactory.getDefaultInstance())
            .setAudience(listOf(clientId))
            .build()
    }

    init {
        logger.info { "Google OAuth service initialized (enabled=$enabled)" }
        if (clientId.isBlank() || clientSecret.isBlank()) {
            logger.warn { "Google OAuth credentials not configured" }
        } else {
            logger.debug { "Google OAuth config - client_id: ${clientId.take(10)}..." }
            logger.debug { "Google OAuth config - redirect_uri: $redirectUri" }
        }
    }

    /**
     * Exchange authorization code for an access token
     */
    fun exchangeCodeForToken(code: String): GoogleTokenResponse? =
        try {
            logger.info { "Exchanging authorization code for access token" }

            val headers = HttpHeaders()
            headers.contentType = MediaType.APPLICATION_FORM_URLENCODED

            val body: MultiValueMap<String, String> = LinkedMultiValueMap()
            body.add("client_id", clientId)
            body.add("client_secret", clientSecret)
            body.add("code", code)
            body.add("grant_type", "authorization_code")
            body.add("redirect_uri", redirectUri)

            val request = HttpEntity(body, headers)

            val response =
                restTemplate.postForEntity<GoogleTokenResponse>(
                    tokenUrl,
                    request
                )

            if (response.statusCode.is2xxSuccessful && response.body != null) {
                logger.info { "Successfully exchanged code for access token" }
                response.body
            } else {
                logger.error { "Token exchange failed: ${response.statusCode}" }
                null
            }
        } catch (e: Exception) {
            logger.error(e) { "Error exchanging code for token: ${e.message}" }
            null
        }

    /**
     * Get user information from Google using an access token
     */
    fun getUserInfo(accessToken: String): GoogleUserInfo? =
        try {
            logger.info { "Fetching user info from Google" }

            val headers = HttpHeaders()
            headers.setBearerAuth(accessToken)

            val request = HttpEntity<Void>(headers)

            val response =
                restTemplate.exchange<GoogleUserInfo>(
                    userInfoUrl,
                    HttpMethod.GET,
                    request
                )

            if (response.statusCode.is2xxSuccessful && response.body != null) {
                logger.info { "Successfully retrieved user info: ${response.body?.email}" }
                response.body
            } else {
                logger.error { "User info request failed: ${response.statusCode}" }
                null
            }
        } catch (e: Exception) {
            logger.error(e) { "Error getting user info: ${e.message}" }
            null
        }

    /**
     * Verify a Google ID token (native mobile Credential Manager flow) and
     * map its payload to the same GoogleUserInfo the web flow produces.
     * Returns null when the token is invalid, expired, or has a wrong audience.
     */
    fun verifyIdToken(idToken: String): GoogleUserInfo? =
        try {
            val verified = idTokenVerifier.verify(idToken)
            if (verified == null) {
                logger.warn { "Google ID token failed verification (bad signature/audience/expiry)" }
                null
            } else {
                val payload = verified.payload
                GoogleUserInfo(
                    id = payload.subject,
                    email = payload.email,
                    name = payload["name"] as? String ?: "",
                    givenName = payload["given_name"] as? String,
                    familyName = payload["family_name"] as? String,
                    picture = payload["picture"] as? String
                )
            }
        } catch (e: Exception) {
            logger.error(e) { "Error verifying Google ID token: ${e.message}" }
            null
        }

    /**
     * Get OAuth configuration
     */
    fun getConfig(): Map<String, Any> =
        mapOf(
            "client_id" to clientId,
            "redirect_uri" to redirectUri,
            "enabled" to enabled
        )

    /**
     * Get frontend redirect URL with an access token
     */
    fun getFrontendRedirectUrl(accessToken: String): String = "$frontendUrl/dashboard?access_token=$accessToken&token_type=bearer"
}
