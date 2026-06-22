package com.scrapalot.backend.service

import com.scrapalot.backend.domain.auth.User
import com.scrapalot.backend.repository.UserRepository
import jakarta.persistence.EntityManager
import mu.KotlinLogging
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.*

private val logger = KotlinLogging.logger {}

@Service
@Transactional
class UserService(
    private val userRepository: UserRepository,
    private val passwordEncoder: PasswordEncoder,
    private val entityManager: EntityManager
) {
    @Transactional(readOnly = true)
    fun findById(id: UUID): User? = userRepository.findById(id).orElse(null)

    @Transactional(readOnly = true)
    fun findByUsername(username: String): User? = userRepository.findByUsername(username)

    @Transactional(readOnly = true)
    fun findByEmailOrUsername(identifier: String): User? = userRepository.findByEmailOrUsername(identifier)

    @Transactional(readOnly = true)
    fun searchUsers(
        query: String,
        excludeUserId: UUID
    ): List<User> = userRepository.searchUsers(query, excludeUserId)

    // Admin user management: include deactivated users so they remain visible
    // and can be reactivated.
    @Transactional(readOnly = true)
    fun searchAllUsers(
        query: String,
        excludeUserId: UUID
    ): List<User> = userRepository.searchAllUsers(query, excludeUserId)

    @Transactional(readOnly = true)
    fun findAllActive(): List<User> = userRepository.findByIsActive(true)

    @Transactional(readOnly = true)
    fun findAll(): List<User> = userRepository.findAll()

    // Derive a unique username from the local-part of an email (everything before
    // '@'). Used by OAuth registration, where Google/etc. give us no username but
    // the rest of the app (member lists, mentions, search) expects one. The raw
    // local-part is lower-cased and stripped to the [a-z0-9._-] charset the column
    // allows, capped at 50 chars, then a numeric suffix is appended until the
    // result is free. Falls back to "user" when the local-part sanitizes to empty.
    @Transactional(readOnly = true)
    fun generateUniqueUsername(email: String): String {
        val localPart = email.substringBefore('@')
        val base =
            localPart
                .lowercase()
                .replace(Regex("[^a-z0-9._-]"), "")
                .trim('.', '_', '-')
                .take(50)
                .ifBlank { "user" }

        if (!userRepository.existsByUsername(base)) return base

        var suffix = 1
        while (true) {
            val candidate = base.take(50 - suffix.toString().length) + suffix
            if (!userRepository.existsByUsername(candidate)) return candidate
            suffix++
        }
    }

    fun createUser(
        username: String?,
        email: String?,
        password: String?,
        firstName: String?,
        lastName: String?,
        role: String = "user",
        isExternal: Boolean = false,
        licenseAgreementConsent: Boolean = false,
        contentSharingConsent: Boolean = true
    ): User {
        // Validate uniqueness
        if (username != null && userRepository.existsByUsername(username)) {
            throw IllegalArgumentException("Username already exists")
        }
        if (email != null && userRepository.existsByEmail(email)) {
            throw IllegalArgumentException("Email already exists")
        }

        val hashedPassword = password?.let { passwordEncoder.encode(it) }

        val user =
            User(
                username = username,
                email = email,
                password = hashedPassword,
                firstName = firstName,
                lastName = lastName,
                role = role,
                isActive = true,
                isExternal = isExternal,
                licenseAgreementConsent = licenseAgreementConsent,
                contentSharingConsent = contentSharingConsent,
                createdAt = Instant.now(),
                updatedAt = Instant.now()
            )

        val savedUser = userRepository.save(user)
        logger.info { "Created user: ${savedUser.id} (${savedUser.username ?: savedUser.email})" }

        return savedUser
    }

    fun updateUser(
        userId: UUID,
        updates: Map<String, Any?>
    ): User {
        val user =
            userRepository.findById(userId).orElseThrow {
                NoSuchElementException("User not found: $userId")
            }

        // Create updated user (data classes are immutable)
        val updatedUser =
            user.copy(
                firstName = (updates["firstName"] as? String) ?: user.firstName,
                lastName = (updates["lastName"] as? String) ?: user.lastName,
                email = (updates["email"] as? String) ?: user.email,
                profilePicture = (updates["profilePicture"] as? String) ?: user.profilePicture,
                updatedAt = Instant.now()
            )

        return userRepository.save(updatedUser)
    }

    fun adminUpdateUser(
        userId: UUID,
        updates: Map<String, Any?>
    ): User {
        val user =
            userRepository.findById(userId).orElseThrow {
                NoSuchElementException("User not found: $userId")
            }

        val updatedUser =
            user.copy(
                firstName = (updates["firstName"] as? String) ?: user.firstName,
                lastName = (updates["lastName"] as? String) ?: user.lastName,
                email = (updates["email"] as? String) ?: user.email,
                profilePicture = (updates["profilePicture"] as? String) ?: user.profilePicture,
                role = (updates["role"] as? String) ?: user.role,
                isActive = (updates["isActive"] as? Boolean) ?: user.isActive,
                billingExempt = (updates["billingExempt"] as? Boolean) ?: user.billingExempt,
                updatedAt = Instant.now()
            )

        logger.info { "Admin updated user: $userId" }
        return userRepository.save(updatedUser)
    }

    fun changePassword(
        userId: UUID,
        currentPassword: String?,
        newPassword: String
    ): User {
        val user =
            userRepository.findById(userId).orElseThrow {
                NoSuchElementException("User not found: $userId")
            }

        // Validate current password if user has one
        user.password?.takeIf { it.isNotEmpty() }?.let { existingPassword ->
            if (currentPassword == null) {
                throw IllegalArgumentException("Current password is required")
            }
            if (!passwordEncoder.matches(currentPassword, existingPassword)) {
                throw IllegalArgumentException("Current password is incorrect")
            }
        }

        // Validate new password
        if (newPassword.length < 8) {
            throw IllegalArgumentException("New password must be at least 8 characters long")
        }

        val hashedPassword = passwordEncoder.encode(newPassword)
        val updatedUser =
            user.copy(
                password = hashedPassword,
                updatedAt = Instant.now()
            )

        logger.info { "Password changed for user: $userId" }
        return userRepository.save(updatedUser)
    }

    fun adminResetPassword(
        userId: UUID,
        newPassword: String
    ): User {
        val user =
            userRepository.findById(userId).orElseThrow {
                NoSuchElementException("User not found: $userId")
            }

        if (newPassword.length < 8) {
            throw IllegalArgumentException("New password must be at least 8 characters long")
        }

        val hashedPassword = passwordEncoder.encode(newPassword)
        val updatedUser =
            user.copy(
                password = hashedPassword,
                updatedAt = Instant.now()
            )

        logger.info { "Admin reset password for user: $userId" }
        return userRepository.save(updatedUser)
    }

    fun deleteUser(userId: UUID) {
        if (!userRepository.existsById(userId)) {
            throw NoSuchElementException("User not found: $userId")
        }

        // Delete child entities in correct FK order using native SQL
        val deletions =
            listOf(
                // Level 4: deepest children first
                "DELETE FROM scrapalot.messages WHERE session_id IN (SELECT id FROM scrapalot.sessions WHERE user_id = :userId)",
                "DELETE FROM scrapalot.note_comments WHERE note_id IN (SELECT id FROM scrapalot.notes WHERE user_id = :userId)",
                "DELETE FROM scrapalot.note_shares WHERE note_id IN (SELECT id FROM scrapalot.notes WHERE user_id = :userId)",
                "DELETE FROM scrapalot.note_versions WHERE note_id IN (SELECT id FROM scrapalot.notes WHERE user_id = :userId)",
                // Level 3: notes reference sessions AND user
                "DELETE FROM scrapalot.notes WHERE user_id = :userId",
                "UPDATE scrapalot.notes SET last_edited_by = NULL WHERE last_edited_by = :userId",
                // Level 3: sessions
                "DELETE FROM scrapalot.sessions WHERE user_id = :userId",
                "DELETE FROM scrapalot.session_folders WHERE user_id = :userId",
                // Level 3: workspace children (before workspaces)
                "DELETE FROM scrapalot.workspace_chat_messages WHERE sender_id = :userId",
                "DELETE FROM scrapalot.workspace_chat_presence WHERE user_id = :userId",
                "DELETE FROM scrapalot.chat_conversations WHERE workspace_id IN (SELECT id FROM scrapalot.workspaces WHERE user_id = :userId)",
                "DELETE FROM scrapalot.connectors WHERE workspace_id IN (SELECT id FROM scrapalot.workspaces WHERE user_id = :userId)",
                "DELETE FROM scrapalot.collections WHERE workspace_id IN (SELECT id FROM scrapalot.workspaces WHERE user_id = :userId)",
                "DELETE FROM scrapalot.workspace_users WHERE user_id = :userId",
                // Level 2: direct user children
                "DELETE FROM scrapalot.workspaces WHERE user_id = :userId",
                "DELETE FROM scrapalot.user_settings WHERE user_id = :userId",
                "DELETE FROM scrapalot.user_subscriptions WHERE user_id = :userId",
                "DELETE FROM scrapalot.user_token_usage WHERE user_id = :userId",
                "DELETE FROM scrapalot.api_keys WHERE user_id = :userId",
                "DELETE FROM scrapalot.model_providers WHERE user_id = :userId",
                "UPDATE scrapalot.invitation_tokens SET invited_by = NULL WHERE invited_by = :userId",
                // Level 1: the user
                "DELETE FROM scrapalot.users WHERE id = :userId",
            )

        @Suppress("SqlSourceToSinkFlow") // all SQL strings are hardcoded literals above; userId is a bind parameter
        fun exec(sql: String) = entityManager.createNativeQuery(sql).setParameter("userId", userId).executeUpdate()
        deletions.forEach { exec(it) }

        logger.info { "Deleted user and all associated data: $userId" }
    }

    fun markTourCompleted(userId: UUID): User {
        val user =
            userRepository.findById(userId).orElseThrow {
                NoSuchElementException("User not found: $userId")
            }

        val updatedUser =
            user.copy(
                tourCompleted = true,
                updatedAt = Instant.now()
            )

        logger.info { "Tour marked as completed for user: $userId" }
        return userRepository.save(updatedUser)
    }

    fun acceptLicenseAgreement(
        userId: UUID,
        contentSharingConsent: Boolean
    ): User {
        val user =
            userRepository.findById(userId).orElseThrow {
                NoSuchElementException("User not found: $userId")
            }

        val updatedUser =
            user.copy(
                licenseAgreementConsent = true,
                contentSharingConsent = contentSharingConsent,
                updatedAt = Instant.now()
            )

        logger.info { "License agreement accepted for user: $userId (content sharing: $contentSharingConsent)" }
        return userRepository.save(updatedUser)
    }
}
