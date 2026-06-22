package com.scrapalot.backend.service

import com.scrapalot.backend.config.NewUserDefaults
import com.scrapalot.backend.domain.auth.User
import com.scrapalot.backend.dto.TokenResponse
import com.scrapalot.backend.repository.UserRepository
import com.scrapalot.backend.security.JwtTokenProvider
import com.scrapalot.backend.utils.orThrow
import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Value
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.UUID

private val logger = KotlinLogging.logger {}

@Service
@Transactional
class AuthService(
    private val userRepository: UserRepository,
    private val userService: UserService,
    private val workspaceService: WorkspaceService,
    private val collectionService: CollectionService,
    private val settingsService: SettingsService,
    private val subscriptionService: SubscriptionService,
    private val passwordEncoder: PasswordEncoder,
    private val jwtTokenProvider: JwtTokenProvider,
    private val newUserDefaults: NewUserDefaults,
    private val refreshTokenService: RefreshTokenService,
    private val emailService: EmailService,
    @param:Value("\${email.contact-notify-address:simun.sunjic@gmail.com}") private val notifyEmail: String
) {
    /**
     * Notify the operator that a new account was created. Best-effort: a mail
     * failure must never break sign-up, which has already committed. Covers
     * both email registration and first-time OAuth (Google) sign-up.
     */
    private fun notifyNewUser(
        user: User,
        method: String
    ) {
        runCatching {
            val name =
                listOfNotNull(user.firstName, user.lastName)
                    .filter { it.isNotBlank() }
                    .joinToString(" ")
                    .ifBlank { user.username ?: user.email ?: "Unknown" }
            emailService.sendNewUserNotification(
                toEmail = notifyEmail,
                newUserName = name,
                newUserEmail = user.email ?: "(no email)",
                method = method
            )
        }.onFailure { e ->
            logger.warn(e) { "Failed to send new-user notification for ${user.id}" }
        }
    }
    fun login(
        usernameOrEmail: String,
        password: String,
        userAgent: String? = null
    ): TokenResponse {
        val user =
            userRepository.findByEmailOrUsername(usernameOrEmail)
                ?: throw IllegalArgumentException("Invalid credentials")

        if (!user.isActive) {
            throw IllegalArgumentException("User account is not active")
        }

        if (user.password == null || !passwordEncoder.matches(password, user.password)) {
            throw IllegalArgumentException("Invalid credentials")
        }

        // Defensive idempotent seed: if a legacy account exists in `users`
        // without a `settings_general` row (observed for the maintainer
        // himself — `simun.sunjic@gmail.com` had a users row but no
        // settings row), the missing row breaks i18n language detection
        // on first login + force-decodes Croatian voice as English. Every
        // current creation path already seeds settings, but this guard
        // catches anything created before that became routine and any
        // future code that forgets the seed call.
        user.id?.let { ensureGeneralSettings(it) }

        logger.info { "User logged in: ${user.id} (${user.username ?: user.email})" }

        return generateTokens(user, userAgent)
    }

    /**
     * Seed `settings_general` for a user if missing. Cheap (one
     * SELECT, an INSERT only on the miss path) so it can run on every
     * login without measurable cost — the lookup goes through
     * SettingsService which already participates in the standard
     * @Transactional + Redis SAGA flow.
     */
    private fun ensureGeneralSettings(userId: UUID) {
        if (settingsService.getGeneralSettings(userId) == null) {
            settingsService.setGeneralSettings(userId, newUserDefaults.generalSettings)
            logger.info { "Backfilled missing settings_general for legacy user $userId" }
        }
    }

    fun register(
        username: String,
        email: String,
        password: String,
        firstName: String?,
        lastName: String?,
        licenseAgreementConsent: Boolean,
        contentSharingConsent: Boolean,
        role: String = "USER"
    ): User {
        // Create user
        val user =
            userService.createUser(
                username = username,
                email = email,
                password = password,
                firstName = firstName,
                lastName = lastName,
                role = role,
                isExternal = false,
                licenseAgreementConsent = licenseAgreementConsent,
                contentSharingConsent = contentSharingConsent
            )

        val userId = user.id.orThrow("User")

        // Create default workspace
        val workspace = workspaceService.createWorkspace(newUserDefaults.defaultWorkspaceName, userId)
        val workspaceId = workspace.id.orThrow("Workspace")

        // Create default collection
        collectionService.createCollection(
            name = newUserDefaults.defaultCollectionName,
            workspaceId = workspaceId,
            userId = userId
        )

        // Create default settings
        createDefaultSettings(userId)

        // Assign default subscription plan (researcher)
        try {
            subscriptionService.createDefaultSubscription(userId)
            logger.info { "Assigned default subscription plan to user $userId" }
        } catch (e: Exception) {
            logger.warn(e) { "Failed to assign default subscription plan to user $userId" }
        }

        logger.info { "User registered: ${user.id} with workspace: ${workspace.id}" }
        notifyNewUser(user, "Email registration")

        return user
    }

    fun registerAdmin(
        username: String,
        email: String,
        password: String
    ): User {
        val user =
            userService.createUser(
                username = username,
                email = email,
                password = password,
                firstName = null,
                lastName = null,
                role = "admin",
                isExternal = false,
                licenseAgreementConsent = true,
                contentSharingConsent = true
            )

        val userId = user.id.orThrow("User")
        val workspace = workspaceService.createWorkspace(newUserDefaults.defaultWorkspaceName, userId)
        collectionService.createCollection(
            name = newUserDefaults.defaultCollectionName,
            workspaceId = workspace.id.orThrow("Workspace"),
            userId = userId
        )
        createDefaultSettings(userId)

        logger.info { "Admin user registered: ${user.id}" }
        return user
    }

    /** Used by the mobile Google flow to ask consent before creating an account. */
    fun emailExists(email: String): Boolean = userRepository.findByEmail(email) != null

    fun registerOrLoginWithOAuth(
        email: String,
        firstName: String?,
        lastName: String?,
        profilePicture: String?
    ): Pair<User, TokenResponse> {
        // Try to find existing user
        val existingUser = userRepository.findByEmail(email)

        val user =
            if (existingUser != null) {
                // Update last login time + fill missing profile fields from Google
                val updated =
                    existingUser.copy(
                        firstName = existingUser.firstName ?: firstName,
                        lastName = existingUser.lastName ?: lastName,
                        profilePicture = existingUser.profilePicture ?: profilePicture,
                        updatedAt = Instant.now()
                    )
                userRepository.save(updated)
            } else {
                // Create new user via OAuth
                val createdUser =
                    userService.createUser(
                        username = userService.generateUniqueUsername(email),
                        email = email,
                        password = null,
                        firstName = firstName,
                        lastName = lastName,
                        role = "USER",
                        isExternal = true,
                        licenseAgreementConsent = false, // Will be prompted later
                        contentSharingConsent = true
                    )

                // Update profile picture if provided, using the saved result
                val newUser =
                    if (profilePicture != null) {
                        userRepository.save(createdUser.copy(profilePicture = profilePicture, updatedAt = Instant.now()))
                    } else {
                        createdUser
                    }

                // Create a default workspace and collection
                val newUserId = newUser.id.orThrow("NewUser")
                val oauthWorkspace = workspaceService.createWorkspace(newUserDefaults.defaultWorkspaceName, newUserId)
                collectionService.createCollection(
                    name = newUserDefaults.defaultCollectionName,
                    workspaceId = oauthWorkspace.id.orThrow("Workspace"),
                    userId = newUserId
                )

                // Create default settings
                createDefaultSettings(newUserId)

                logger.info { "User registered via OAuth: ${newUser.id} ($email)" }
                notifyNewUser(newUser, "Google (OAuth)")
                newUser
            }

        val tokens = generateTokens(user)
        return Pair(user, tokens)
    }

    fun refreshToken(refreshToken: String): TokenResponse {
        if (!jwtTokenProvider.validateRefreshToken(refreshToken)) {
            throw IllegalArgumentException("Invalid refresh token")
        }

        // Extract user ID from a token (now contains UUID, not username)
        val userIdString =
            jwtTokenProvider.getUsernameFromToken(refreshToken)
                ?: throw IllegalArgumentException("Invalid refresh token")

        // Parse UUID and find user
        val userId =
            try {
                UUID.fromString(userIdString)
            } catch (_: IllegalArgumentException) {
                throw IllegalArgumentException("Invalid user ID format in token")
            }

        val user =
            userRepository.findById(userId).orElse(null)
                ?: throw IllegalArgumentException("User not found")

        if (!user.isActive) {
            throw IllegalArgumentException("User account is not active")
        }

        // Validate against Redis token family (if familyId present in JWT)
        val familyId = jwtTokenProvider.getFamilyIdFromToken(refreshToken)

        logger.info { "Refreshing token for user: ${user.id}, familyId: $familyId" }

        if (familyId != null) {
            // New-style token with familyId: validate hash, generate new tokens in same family, rotate hash
            val userIdStr = userId.toString()
            val accessToken = jwtTokenProvider.generateAccessToken(userIdStr, user.role)
            val newRefreshTokenCandidate = jwtTokenProvider.generateRefreshToken(userIdStr, familyId)

            // `rotate` returns the token the caller should hand back —
            // either the candidate we just minted (normal rotation) or
            // the cached token from an earlier concurrent rotation
            // inside the grace window. If it returns null the family
            // is genuinely revoked / unrecognised.
            val refreshTokenToReturn =
                refreshTokenService.rotate(
                    userId,
                    familyId,
                    refreshToken,
                    newRefreshTokenCandidate,
                ) ?: throw IllegalArgumentException("Refresh token has been revoked or reused")

            return TokenResponse(
                accessToken = accessToken,
                refreshToken = refreshTokenToReturn,
                expiresIn = jwtTokenProvider.getAccessTokenTtlSeconds()
            )
        }

        // Legacy token without familyId: just generate new tokens (backward compatible)
        return generateTokens(user)
    }

    fun revokeRefreshToken(
        userId: UUID,
        familyId: String
    ) {
        refreshTokenService.revokeFamily(userId, familyId)
    }

    fun revokeAllRefreshTokens(userId: UUID) {
        refreshTokenService.revokeAllForUser(userId)
    }

    /**
     * Issue tokens for `targetUserId` on behalf of an admin. The admin
     * uses this to step into a regular user's session and observe the
     * UX they experience (subscription gating, plan limits, default
     * settings, etc.) without having to know their password.
     *
     * Token contents are identical to a normal login — the user-agent
     * field is overwritten with `impersonation-by-<adminId>` so the
     * refresh-token family entry in Redis carries the audit trail.
     * Logged at WARN level so the trace is visible in production logs.
     *
     * Caller is expected to verify admin role + non-self target before
     * invoking; the service only enforces the target-user invariants
     * (exists, active).
     */
    fun impersonate(
        targetUserId: UUID,
        adminUserId: UUID
    ): TokenResponse {
        val target =
            userRepository.findById(targetUserId).orElseThrow {
                IllegalArgumentException("Target user not found: $targetUserId")
            }
        if (!target.isActive) {
            throw IllegalArgumentException("Cannot impersonate inactive user")
        }

        logger.warn {
            "ADMIN IMPERSONATION: admin=$adminUserId target=$targetUserId username=${target.username ?: target.email}"
        }

        return generateTokens(target, userAgent = "impersonation-by-$adminUserId")
    }

    private fun generateTokens(
        user: User,
        userAgent: String? = null
    ): TokenResponse {
        // Use user UUID as subject (JWT RFC 7519 standard + Python backend compatibility)
        val userId = user.id.orThrow("User")
        val userIdStr = userId.toString()

        // Create token family in Redis and embed familyId in refresh token
        val accessToken = jwtTokenProvider.generateAccessToken(userIdStr, user.role)
        val familyId = UUID.randomUUID().toString()
        val refreshToken = jwtTokenProvider.generateRefreshToken(userIdStr, familyId)

        // Store token family in Redis with the same familyId embedded in JWT
        refreshTokenService.createTokenFamily(userId, familyId, refreshToken, userAgent)

        return TokenResponse(
            accessToken = accessToken,
            refreshToken = refreshToken,
            expiresIn = jwtTokenProvider.getAccessTokenTtlSeconds()
        )
    }

    private fun createDefaultSettings(userId: UUID) {
        settingsService.setGeneralSettings(userId, newUserDefaults.generalSettings)
        settingsService.setDocumentProcessingSettings(userId, newUserDefaults.documentProcessing)
        logger.info { "Created default settings for user: $userId" }
    }
}
