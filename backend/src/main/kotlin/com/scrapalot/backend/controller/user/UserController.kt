package com.scrapalot.backend.controller.user

import com.scrapalot.backend.domain.auth.User
import com.scrapalot.backend.dto.AcceptLicenseRequest
import com.scrapalot.backend.dto.AdminCreateUserRequest
import com.scrapalot.backend.dto.AdminResetPasswordRequest
import com.scrapalot.backend.dto.AdminUpdateUserRequest
import com.scrapalot.backend.dto.ChangePasswordRequest
import com.scrapalot.backend.dto.TokenResponse
import com.scrapalot.backend.dto.UpdateUserRequest
import com.scrapalot.backend.dto.UserResponse
import com.scrapalot.backend.service.AuthService
import com.scrapalot.backend.service.SubscriptionService
import com.scrapalot.backend.service.UsageType
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.*
import jakarta.validation.Valid
import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Value
import org.springframework.core.io.FileSystemResource
import org.springframework.core.io.Resource
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import org.springframework.web.multipart.MultipartFile
import java.io.File
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.util.NoSuchElementException
import java.util.UUID

private val logger = KotlinLogging.logger {}

@RestController
@RequestMapping("/api/v1/users")
class UserController(
    private val userService: UserService,
    private val authService: AuthService,
    private val subscriptionService: SubscriptionService,
    @param:Value("\${application.upload.path:data/upload}")
    private val uploadPath: String
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    @PostMapping("/create")
    fun createUser(
        @Valid @RequestBody request: AdminCreateUserRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<UserResponse> =
        resultOf {
            val currentUser = userDetails.getAuthenticatedUser(userService).getOrThrow()
            if (!currentUser.isAdmin()) {
                throw SecurityException("Only admins can create new users")
            }

            authService
                .register(
                    username = request.username,
                    email = request.email,
                    password = request.password,
                    firstName = request.firstName,
                    lastName = request.lastName,
                    licenseAgreementConsent = false,
                    contentSharingConsent = true
                ).toResponse()
        }.toResponseEntity(HttpStatus.CREATED)

    @PutMapping("/edit/{userId}")
    fun adminUpdateUser(
        @PathVariable userId: UUID,
        @Valid @RequestBody request: AdminUpdateUserRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<UserResponse> =
        resultOf {
            val currentUser = userDetails.getAuthenticatedUser(userService).getOrThrow()
            val currentUserId = currentUser.id.orThrow("User")

            if (!currentUser.isAdmin() && currentUserId != userId) {
                throw SecurityException("You can only update your own account unless you're an admin")
            }

            if (request.role != null && !currentUser.isAdmin()) {
                throw SecurityException("Only admins can change user roles")
            }

            if (request.billingExempt != null && !currentUser.isAdmin()) {
                throw SecurityException("Only admins can change billing exemption")
            }

            if (request.subscriptionPlanName != null && !currentUser.isAdmin()) {
                throw SecurityException("Only admins can assign subscription plans")
            }

            val updates =
                buildUpdateMap {
                    "firstName" to request.firstName
                    "lastName" to request.lastName
                    "email" to request.email
                    "role" to request.role
                    "isActive" to request.isActive
                    "profilePicture" to request.profilePicture
                    "billingExempt" to request.billingExempt
                }

            val updatedUser = userService.adminUpdateUser(userId, updates)

            // Community Edition has no subscription plans / billing — every feature
            // is available to every user, so the admin plan-assignment step is dropped.

            updatedUser.toResponse(subscriptionService)
        }.toResponseEntity()

    @PostMapping("/edit/{userId}/reset-password")
    fun adminResetPassword(
        @PathVariable userId: UUID,
        @Valid @RequestBody request: AdminResetPasswordRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val currentUser = userDetails.getAuthenticatedUser(userService).getOrThrow()
            if (!currentUser.isAdmin()) {
                throw SecurityException("Only admins can reset user passwords")
            }

            userService.adminResetPassword(userId, request.newPassword)
            Unit
        }.toNoContentResponse()

    @PostMapping("/desktop-auto-login")
    fun desktopAutoLogin(): ResponseEntity<TokenResponse> =
        resultOf {
            val username = "admin"
            val password = "admin123"

            try {
                authService.login(username, password)
            } catch (_: Exception) {
                logger.info { "Admin user not found or password incorrect, attempting to create/update" }

                val existingUser = userService.findByUsername(username)
                if (existingUser != null) {
                    userService.changePassword(existingUser.id.orThrow("User"), null, password)
                } else {
                    authService.registerAdmin(
                        username = username,
                        email = "admin@scrapalot.local",
                        password = password
                    )
                }

                authService.login(username, password)
            }
        }.toResponseEntity()

    @GetMapping("/me")
    fun getCurrentUser(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<UserResponse> =
        resultOf {
            logger.debug("Getting current user: {}", userDetails.username)
            userDetails
                .getAuthenticatedUser(userService)
                .getOrThrow()
                .toResponse()
        }.toResponseEntity()

    @GetMapping("/{userId}")
    fun getUser(
        @PathVariable userId: UUID
    ): ResponseEntity<UserResponse> =
        resultOf {
            userService
                .findById(userId)
                .orNotFound("User not found: $userId")
                .toResponse()
        }.toResponseEntity()

    @GetMapping("/search")
    fun searchUsers(
        @RequestParam(required = false, defaultValue = "") query: String,
        @RequestParam(required = false) excludeUserId: UUID?,
        @RequestParam(defaultValue = "20") limit: Int,
        @RequestParam(defaultValue = "1") page: Int,
        @RequestParam(required = false, name = "page_size") pageSize: Int?,
        @RequestParam(required = false, defaultValue = "false", name = "include_inactive") includeInactive: Boolean
    ): ResponseEntity<Map<String, Any>> =
        resultOf {
            val effectiveLimit = pageSize ?: limit
            // Admin user management passes include_inactive=true so deactivated
            // users stay visible (and reactivatable); share/invite flows omit it
            // and keep seeing only active users.
            val users =
                if (query.isBlank()) {
                    if (includeInactive) userService.findAll() else userService.findAllActive()
                } else if (includeInactive) {
                    userService.searchAllUsers(query, excludeUserId ?: UUID.randomUUID())
                } else {
                    userService.searchUsers(query, excludeUserId ?: UUID.randomUUID())
                }
            val total = users.size
            val paginated =
                users
                    .drop((page - 1) * effectiveLimit)
                    .take(effectiveLimit)
                    .map { it.toResponse(subscriptionService) }
            mapOf("users" to paginated, "total" to total)
        }.toResponseEntity()

    @GetMapping("/by-email")
    fun getUserByEmail(
        @RequestParam email: String
    ): ResponseEntity<UserResponse> =
        resultOf {
            userService
                .findByEmailOrUsername(email)
                .orNotFound("User not found: $email")
                .toResponse()
        }.toResponseEntity()

    @PostMapping("/me/accept-license")
    fun acceptMyLicense(
        @RequestParam(name = "content_sharing_consent", required = false, defaultValue = "true")
        contentSharingConsent: Boolean,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<UserResponse> =
        resultOf {
            val userId = userDetails.userId()
            userService.acceptLicenseAgreement(userId, contentSharingConsent).toResponse()
        }.toResponseEntity()

    @PutMapping("/me/tour-completed")
    fun markTourCompleted(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<UserResponse> =
        resultOf {
            val userId = userDetails.userId()
            userService.markTourCompleted(userId).toResponse()
        }.toResponseEntity()

    @PostMapping("/me/profile-picture", consumes = [MediaType.MULTIPART_FORM_DATA_VALUE])
    fun uploadProfilePicture(
        @RequestParam("file") file: MultipartFile,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<UserResponse> =
        resultOf {
            val userId = userDetails.userId()

            val contentType =
                file.contentType
                    ?: throw IllegalArgumentException("File content type is missing")

            if (!contentType.startsWith("image/")) {
                logger.warn { "Invalid file type for profile picture: $contentType" }
                throw IllegalArgumentException("File must be an image")
            }

            // Hard storage-quota gate — profile pictures are small but must
            // not be a way around an exhausted plan.
            val quota = subscriptionService.checkUsageLimit(userId, UsageType.STORAGE_BYTES, file.size)
            if (!quota.allowed) {
                throw SecurityException(quota.message ?: "Storage quota exceeded")
            }

            val extension =
                when (contentType) {
                    "image/jpeg" -> "jpg"
                    "image/png" -> "png"
                    "image/webp" -> "webp"
                    else -> "jpg"
                }

            File(uploadPath).apply {
                if (!exists()) {
                    mkdirs()
                    logger.info { "Created upload directory: $absolutePath" }
                }
            }

            val filename = "$userId.$extension"
            val destinationFile = Paths.get(uploadPath, filename)
            Files.copy(file.inputStream, destinationFile, StandardCopyOption.REPLACE_EXISTING)

            logger.info { "Profile picture uploaded for user $userId: $filename (size: ${file.size} bytes)" }

            userService
                .updateUser(
                    userId = userId,
                    updates = mapOf("profilePicture" to filename)
                ).toResponse()
        }.toResponseEntity()

    @GetMapping("/profile-pictures/{filename}")
    fun getProfilePicture(
        @PathVariable filename: String
    ): ResponseEntity<Resource> =
        resultOf {
            // Security: Only allow UUID-based filenames to prevent path traversal
            val (name, extension) =
                filename
                    .split(".")
                    .takeIf { it.size == 2 }
                    ?: throw IllegalArgumentException("Invalid filename format")

            // Validate UUID format
            runCatching { UUID.fromString(name) }
                .getOrElse { throw IllegalArgumentException("Invalid UUID in filename") }

            // Validate extension
            if (extension !in listOf("jpg", "jpeg", "png", "webp")) {
                throw IllegalArgumentException("Invalid file extension: $extension")
            }

            val filePath = Paths.get(uploadPath, filename)
            val file = filePath.toFile()

            if (!file.exists() || !file.isFile) {
                throw NoSuchElementException("Profile picture not found: $filename")
            }

            val resource: Resource = FileSystemResource(file)

            // Determine content type
            val contentType =
                when (extension) {
                    "png" -> MediaType.IMAGE_PNG
                    "webp" -> MediaType.parseMediaType("image/webp")
                    else -> MediaType.IMAGE_JPEG
                }

            ResponseEntity
                .ok()
                .contentType(contentType)
                .header(HttpHeaders.CACHE_CONTROL, "public, max-age=31536000")
                .body(resource)
        }.fold(
            onSuccess = { it },
            onFailure = { exception ->
                logger.error(exception) { "Get profile picture failed: ${exception.message}" }
                when (exception) {
                    is NoSuchElementException -> ResponseEntity.notFound().build()
                    is IllegalArgumentException -> ResponseEntity.badRequest().build()
                    else -> ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build()
                }
            }
        )

    @DeleteMapping("/me/profile-picture")
    fun deleteProfilePicture(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<UserResponse> =
        resultOf {
            val userId = userDetails.userId()
            userService
                .updateUser(
                    userId = userId,
                    updates = mapOf("profilePicture" to null)
                ).toResponse()
        }.toResponseEntity()

    @PutMapping("/{userId}")
    fun updateUser(
        @PathVariable userId: UUID,
        @Valid @RequestBody request: UpdateUserRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<UserResponse> =
        resultOf {
            val currentUserId = userDetails.userId()

            if (currentUserId != userId) {
                throw SecurityException("Users can only update their own profile")
            }

            val updates =
                buildUpdateMap {
                    "firstName" to request.firstName
                    "lastName" to request.lastName
                    "profilePicture" to request.profilePicture
                }

            userService.updateUser(userId, updates).toResponse()
        }.toResponseEntity()

    @PostMapping("/{userId}/change-password")
    fun changePassword(
        @PathVariable userId: UUID,
        @Valid @RequestBody request: ChangePasswordRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val currentUserId = userDetails.userId()

            if (currentUserId != userId) {
                throw SecurityException("Users can only change their own password")
            }

            userService.changePassword(userId, request.currentPassword, request.newPassword)
            Unit
        }.toNoContentResponse()

    @PostMapping("/{userId}/accept-license")
    fun acceptLicense(
        @PathVariable userId: UUID,
        @Valid @RequestBody request: AcceptLicenseRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<UserResponse> =
        resultOf {
            val currentUserId = userDetails.userId()

            if (currentUserId != userId) {
                throw SecurityException("Users can only accept license for themselves")
            }

            userService
                .acceptLicenseAgreement(
                    userId,
                    request.contentSharingConsent ?: true
                ).toResponse()
        }.toResponseEntity()

    @DeleteMapping("/{userId}")
    fun deleteUser(
        @PathVariable userId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            // Need full User object for admin role check
            val currentUser = userDetails.getAuthenticatedUser(userService).getOrThrow()

            if (currentUser.id.orThrow("User") != userId && !currentUser.isAdmin()) {
                throw SecurityException("Insufficient permissions to delete user")
            }

            userService.deleteUser(userId)
        }.toNoContentResponse()
}

private fun User.toResponse(subscriptionService: SubscriptionService? = null): UserResponse {
    val planName =
        subscriptionService?.let { svc ->
            id?.let { userId -> svc.getUserSubscriptionWithPlan(userId)?.second?.name }
        }
    return UserResponse(
        id = id.orThrow("Entity"),
        username = username,
        email = email,
        firstName = firstName,
        lastName = lastName,
        role = role,
        isSuperadmin = isSuperadmin,
        isActive = isActive,
        isExternal = isExternal,
        profilePicture = profilePicture,
        licenseAgreementConsent = licenseAgreementConsent,
        contentSharingConsent = contentSharingConsent,
        tourCompleted = tourCompleted,
        billingExempt = billingExempt,
        subscriptionPlanName = planName,
        createdAt = createdAt.toString(),
        updatedAt = updatedAt.toString()
    )
}
