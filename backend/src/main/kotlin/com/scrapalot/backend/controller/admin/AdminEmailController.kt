package com.scrapalot.backend.controller.admin

import com.scrapalot.backend.domain.auth.User
import com.scrapalot.backend.dto.EmailResponse
import com.scrapalot.backend.dto.InvitationEmailRequest
import com.scrapalot.backend.dto.ProTrialEmailRequest
import com.scrapalot.backend.dto.ReleaseNotesEmailRequest
import com.scrapalot.backend.dto.TestEmailRequest
import com.scrapalot.backend.email.ReleaseHighlight
import com.scrapalot.backend.service.EmailService
import com.scrapalot.backend.service.InvitationTokenService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.getAuthenticatedUser
import com.scrapalot.backend.utils.isAdmin
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toResponseEntity
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import org.springframework.web.server.ResponseStatusException
import java.time.LocalDate
import java.time.format.DateTimeFormatter

@RestController
@RequestMapping("/api/v1/admin/email")
class AdminEmailController(
    private val emailService: EmailService,
    private val userService: UserService,
    private val invitationTokenService: InvitationTokenService
) {
    @PostMapping("/test")
    fun sendTestEmail(
        @Valid @RequestBody request: TestEmailRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<EmailResponse> =
        resultOf {
            requireAdmin(userDetails)
            val success = emailService.sendInvitation(request.email, "Test User", "Scrapalot Admin")
            EmailResponse(success, if (success) "Test email sent" else "Failed to send", if (success) 1 else 0)
        }.toResponseEntity()

    @PostMapping("/invitation")
    fun sendInvitation(
        @Valid @RequestBody request: InvitationEmailRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<EmailResponse> =
        resultOf {
            val admin = requireAdmin(userDetails)
            val inviterName =
                listOfNotNull(admin.firstName, admin.lastName)
                    .joinToString(" ")
                    .ifBlank { admin.username ?: "Admin" }
            val token =
                invitationTokenService.createToken(
                    request.email,
                    request.recipientName,
                    requireNotNull(admin.id) {
                        "Admin user must have an ID"
                    },
                    request.subscriptionPlanId,
                    request.workspaceId,
                    request.billingExempt,
                    request.locale,
                    request.role
                )
            val success = emailService.sendInvitation(request.email, request.recipientName, inviterName, token.token)
            EmailResponse(success, if (success) "Invitation sent to ${request.email}" else "Failed to send", if (success) 1 else 0)
        }.toResponseEntity()

    @PostMapping("/pro-trial")
    fun sendProTrialEmail(
        @Valid @RequestBody request: ProTrialEmailRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<EmailResponse> =
        resultOf {
            requireAdmin(userDetails)
            val trialEnd = LocalDate.now().plusMonths(1).format(DateTimeFormatter.ofPattern("MMMM d, yyyy"))
            val success = emailService.sendProTrial(request.email, request.recipientName, trialEnd)
            EmailResponse(success, if (success) "Pro trial email sent to ${request.email}" else "Failed to send", if (success) 1 else 0)
        }.toResponseEntity()

    @PostMapping("/release-notes")
    fun sendReleaseNotes(
        @Valid @RequestBody request: ReleaseNotesEmailRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<EmailResponse> =
        resultOf {
            requireAdmin(userDetails)

            val recipients = request.emails ?: userService.findAllActive().mapNotNull { it.email }
            if (recipients.isEmpty()) throw ResponseStatusException(HttpStatus.BAD_REQUEST, "No recipients")

            val highlights = request.highlights.map { ReleaseHighlight(it.emoji, it.title, it.description) }
            val sentCount = emailService.sendReleaseNotes(recipients, request.version, request.releaseDate, highlights)

            EmailResponse(sentCount > 0, "Sent $sentCount/${recipients.size} release notes emails", sentCount)
        }.toResponseEntity()

    private fun requireAdmin(userDetails: UserDetails): User {
        val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
        if (!user.isAdmin()) throw ResponseStatusException(HttpStatus.FORBIDDEN, "Admin access required")
        return user
    }
}
