package com.scrapalot.backend.dto

import jakarta.validation.constraints.Email
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import java.util.UUID

data class InvitationEmailRequest(
    @field:Email @field:NotBlank val email: String,
    val recipientName: String? = null,
    val subscriptionPlanId: UUID? = null,
    val workspaceId: UUID? = null,
    val billingExempt: Boolean = false,
    val locale: String? = null,
    // "admin" invites the user straight as an admin; anything else → normal user.
    val role: String = "user"
)

data class ProTrialEmailRequest(
    @field:Email @field:NotBlank val email: String,
    val recipientName: String? = null,
    val userId: UUID? = null
)

data class ReleaseNotesEmailRequest(
    val emails: List<@Email String>? = null,
    @field:NotBlank val version: String,
    @field:NotBlank val releaseDate: String,
    @field:Size(min = 1) val highlights: List<ReleaseHighlightDto>
)

data class ReleaseHighlightDto(
    val emoji: String,
    @field:NotBlank val title: String,
    @field:NotBlank val description: String
)

data class TestEmailRequest(
    @field:Email @field:NotBlank val email: String
)

data class EmailResponse(
    val success: Boolean,
    val message: String,
    val sentCount: Int = 0
)

data class ContactRequest(
    @field:NotBlank @field:Size(max = 100) val firstName: String,
    @field:NotBlank @field:Size(max = 100) val lastName: String,
    @field:Email @field:NotBlank val email: String,
    @field:Size(max = 200) val company: String? = null,
    @field:NotBlank @field:Size(min = 10, max = 5000) val message: String
)
