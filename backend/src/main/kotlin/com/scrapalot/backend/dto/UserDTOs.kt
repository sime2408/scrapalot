package com.scrapalot.backend.dto

import jakarta.validation.constraints.*
import java.util.UUID

// User Response
data class UserResponse(
    val id: UUID,
    val username: String?,
    val email: String?,
    val firstName: String?,
    val lastName: String?,
    val role: String,
    val isSuperadmin: Boolean = false,
    val isActive: Boolean,
    val isExternal: Boolean,
    val profilePicture: String? = null,
    val licenseAgreementConsent: Boolean,
    val contentSharingConsent: Boolean,
    val tourCompleted: Boolean = false,
    val billingExempt: Boolean = false,
    val subscriptionPlanName: String? = null,
    val createdAt: String,
    val updatedAt: String
)

// Update User Request
data class UpdateUserRequest(
    @field:Size(max = 100, message = "First name cannot exceed 100 characters")
    val firstName: String? = null,
    @field:Size(max = 100, message = "Last name cannot exceed 100 characters")
    val lastName: String? = null,
    @field:Size(max = 2048, message = "Profile picture URL cannot exceed 2048 characters")
    val profilePicture: String? = null
)

// Change Password Request
data class ChangePasswordRequest(
    @field:NotBlank(message = "Current password is required")
    val currentPassword: String,
    @field:NotBlank(message = "New password is required")
    @field:Size(min = 8, max = 128, message = "Password must be between 8 and 128 characters")
    val newPassword: String
)

// Accept License Request
@Suppress("JpaImmutableNotNullablePropertyInspection") // DTO, not a JPA entity — val fields with @NotNull are intentional
data class AcceptLicenseRequest(
    @field:NotNull(message = "License agreement consent is required")
    val licenseAgreementConsent: Boolean,
    val contentSharingConsent: Boolean? = true
)

// Admin Create User Request
data class AdminCreateUserRequest(
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
    val lastName: String? = null
)

// Admin Update User Request
data class AdminUpdateUserRequest(
    @field:Size(max = 100, message = "First name cannot exceed 100 characters")
    val firstName: String? = null,
    @field:Size(max = 100, message = "Last name cannot exceed 100 characters")
    val lastName: String? = null,
    @field:Email(message = "Invalid email format")
    val email: String? = null,
    @field:Pattern(regexp = "^(user|admin)$", message = "Role must be 'user' or 'admin'")
    val role: String? = null,
    val isActive: Boolean? = null,
    @field:Size(max = 2048, message = "Profile picture URL cannot exceed 2048 characters")
    val profilePicture: String? = null,
    val billingExempt: Boolean? = null,
    @field:Size(max = 50, message = "Subscription plan name cannot exceed 50 characters")
    val subscriptionPlanName: String? = null
)

// Admin Reset Password Request
data class AdminResetPasswordRequest(
    @field:NotBlank(message = "New password is required")
    @field:Size(min = 8, max = 128, message = "Password must be between 8 and 128 characters")
    val newPassword: String
)
