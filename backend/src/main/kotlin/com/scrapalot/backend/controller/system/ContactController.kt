package com.scrapalot.backend.controller.system

import com.scrapalot.backend.dto.ContactRequest
import com.scrapalot.backend.dto.EmailResponse
import com.scrapalot.backend.service.EmailService
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toResponseEntity
import jakarta.validation.Valid
import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

private val logger = KotlinLogging.logger {}

@RestController
@RequestMapping("/api/v1/contact")
class ContactController(
    private val emailService: EmailService,
    @param:Value("\${email.contact-notify-address:simun.sunjic@gmail.com}") private val notifyEmail: String
) {
    @PostMapping
    fun submitContactForm(
        @Valid @RequestBody request: ContactRequest
    ): ResponseEntity<EmailResponse> =
        resultOf {
            logger.info { "[Contact] Form submission from ${request.email}" }
            val success =
                emailService.sendContactNotification(
                    firstName = request.firstName,
                    lastName = request.lastName,
                    senderEmail = request.email,
                    company = request.company,
                    message = request.message,
                    notifyEmail = notifyEmail
                )
            if (success) {
                EmailResponse(true, "Your message has been sent. We will get back to you within 24 hours.")
            } else {
                EmailResponse(false, "Failed to send message. Please try again or email us directly.")
            }
        }.toResponseEntity()
}
