package com.scrapalot.backend.service

import com.scrapalot.backend.email.EmailTemplates
import com.scrapalot.backend.email.ReleaseHighlight
import jakarta.mail.internet.InternetAddress
import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Value
import org.springframework.mail.javamail.JavaMailSender
import org.springframework.mail.javamail.MimeMessageHelper
import org.springframework.stereotype.Service

private val logger = KotlinLogging.logger {}

@Service
class EmailService(
    private val mailSender: JavaMailSender,
    @param:Value("\${email.from-address}") private val fromAddress: String,
    @param:Value("\${email.from-name}") private val fromName: String,
    @param:Value("\${email.reply-to-address}") private val replyToAddress: String,
    @param:Value("\${email.enabled}") private val enabled: Boolean,
    @param:Value("\${email.base-url}") private val baseUrl: String
) {
    fun sendInvitation(
        toEmail: String,
        recipientName: String?,
        inviterName: String,
        token: String? = null
    ): Boolean {
        val signupUrl = if (token != null) "$baseUrl/invite?token=$token" else "$baseUrl/register?invited=true"
        val html = EmailTemplates.invitation(recipientName, inviterName, signupUrl, baseUrl)
        return sendHtml(toEmail, "You're Invited to Scrapalot AI", html)
    }

    fun sendWorkspaceShared(
        toEmail: String,
        recipientName: String?,
        sharerName: String,
        workspaceId: String,
        workspaceName: String,
        permissionLabel: String
    ): Boolean {
        // Deep-link: switch the recipient to the shared workspace and open the
        // Knowledge Stacks library view on arrival (handled in the frontend).
        val openUrl = "$baseUrl/dashboard?workspace=$workspaceId&view=library"
        val html = EmailTemplates.workspaceShared(recipientName, sharerName, workspaceName, permissionLabel, openUrl, baseUrl)
        return sendHtml(toEmail, "$sharerName shared \"$workspaceName\" with you — Scrapalot AI", html)
    }

    fun sendNewUserNotification(
        toEmail: String,
        newUserName: String,
        newUserEmail: String,
        method: String
    ): Boolean {
        val adminUrl = "$baseUrl/admin"
        val html = EmailTemplates.newUserNotification(newUserName, newUserEmail, method, adminUrl, baseUrl)
        return sendHtml(toEmail, "New Scrapalot user: $newUserEmail", html)
    }

    fun sendProTrial(
        toEmail: String,
        recipientName: String?,
        trialEndDate: String
    ): Boolean {
        val dashboardUrl = "$baseUrl/dashboard"
        val html = EmailTemplates.proTrial(recipientName, trialEndDate, dashboardUrl, baseUrl)
        return sendHtml(toEmail, "Your Pro Trial is Active — Scrapalot AI", html)
    }

    fun sendContactNotification(
        firstName: String,
        lastName: String,
        senderEmail: String,
        company: String?,
        message: String,
        notifyEmail: String
    ): Boolean {
        val html = EmailTemplates.contactNotification(firstName, lastName, senderEmail, company, message, baseUrl)
        val subject = "New contact message from $firstName $lastName — Scrapalot"
        // Reply-To the submitter so the operator answers the person directly.
        return sendHtml(notifyEmail, subject, html, replyTo = senderEmail)
    }

    fun sendReleaseNotes(
        toEmails: List<String>,
        version: String,
        releaseDate: String,
        highlights: List<ReleaseHighlight>
    ): Int {
        val changelogUrl = "$baseUrl/changelog"
        val html = EmailTemplates.releaseNotes(version, releaseDate, highlights, changelogUrl, baseUrl)
        val subject = "Scrapalot AI v$version — What's New"

        var sentCount = 0
        toEmails.forEach { email ->
            if (sendHtml(email, subject, html)) sentCount++
        }
        return sentCount
    }

    private fun sendHtml(
        to: String,
        subject: String,
        htmlBody: String,
        replyTo: String = replyToAddress
    ): Boolean {
        if (!enabled) {
            logger.info { "[Email] DISABLED — would send to=$to subject=\"$subject\"" }
            return true
        }

        return runCatching {
            val message = mailSender.createMimeMessage()
            MimeMessageHelper(message, true, "UTF-8").apply {
                setFrom(InternetAddress(fromAddress, fromName))
                setTo(to)
                replyTo.takeIf { it.isNotBlank() }?.let { setReplyTo(it) }
                setSubject(subject)
                setText(htmlBody, true)
            }
            mailSender.send(message)
            logger.info { "[Email] Sent to=$to subject=\"$subject\"" }
            true
        }.onFailure { e ->
            logger.error(e) { "[Email] Failed to send to=$to subject=\"$subject\"" }
        }.getOrDefault(false)
    }
}
