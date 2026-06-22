package com.scrapalot.backend.email

data class ReleaseHighlight(
    val emoji: String,
    val title: String,
    val description: String
)

object EmailTemplates {
    private fun load(name: String): String =
        checkNotNull(EmailTemplates::class.java.getResourceAsStream("/email/$name")) {
            "Email template not found: $name"
        }.bufferedReader().readText()

    private fun String.fill(vararg pairs: Pair<String, String>): String = pairs.fold(this) { acc, (key, value) -> acc.replace("{{$key}}", value) }

    private fun wrap(
        title: String,
        content: String,
        baseUrl: String
    ): String = load("layout.html").fill("title" to title, "content" to content, "baseUrl" to baseUrl)

    fun invitation(
        recipientName: String?,
        inviterName: String,
        signupUrl: String,
        baseUrl: String
    ): String {
        val greeting = recipientName?.takeIf { it.isNotBlank() }?.let { "Hi $it," } ?: "Hello,"
        val content =
            load("invitation.html").fill(
                "greeting" to greeting,
                "inviterName" to inviterName,
                "signupUrl" to signupUrl
            )
        return wrap("You're Invited to Scrapalot AI", content, baseUrl)
    }

    fun workspaceShared(
        recipientName: String?,
        sharerName: String,
        workspaceName: String,
        permissionLabel: String,
        openUrl: String,
        baseUrl: String
    ): String {
        val greeting = recipientName?.takeIf { it.isNotBlank() }?.let { "Hi $it," } ?: "Hello,"
        val content =
            load("workspace-shared.html").fill(
                "greeting" to greeting,
                "sharerName" to sharerName,
                "workspaceName" to workspaceName,
                "permissionLabel" to permissionLabel,
                "openUrl" to openUrl
            )
        return wrap("A workspace was shared with you", content, baseUrl)
    }

    fun newUserNotification(
        name: String,
        email: String,
        method: String,
        adminUrl: String,
        baseUrl: String
    ): String {
        val content =
            load("new-user.html").fill(
                "name" to name,
                "email" to email,
                "method" to method,
                "adminUrl" to adminUrl
            )
        return wrap("New user signed up", content, baseUrl)
    }

    fun proTrial(
        recipientName: String?,
        trialEndDate: String,
        dashboardUrl: String,
        baseUrl: String
    ): String {
        val name = recipientName?.takeIf { it.isNotBlank() } ?: "there"
        val content =
            load("pro-trial.html").fill(
                "name" to name,
                "trialEndDate" to trialEndDate,
                "dashboardUrl" to dashboardUrl
            )
        return wrap("Your Pro Trial is Active", content, baseUrl)
    }

    fun contactNotification(
        firstName: String,
        lastName: String,
        senderEmail: String,
        company: String?,
        message: String,
        baseUrl: String
    ): String {
        val companyLine =
            if (!company.isNullOrBlank()) {
                load("contact-notification-company.html").fill("company" to company)
            } else {
                ""
            }
        val content =
            load("contact-notification.html").fill(
                "firstName" to firstName,
                "lastName" to lastName,
                "senderEmail" to senderEmail,
                "companyLine" to companyLine,
                "message" to message
            )
        return wrap("New contact message from $firstName $lastName", content, baseUrl)
    }

    fun releaseNotes(
        version: String,
        releaseDate: String,
        highlights: List<ReleaseHighlight>,
        changelogUrl: String,
        baseUrl: String
    ): String {
        val highlightTemplate = load("release-notes-highlight.html")
        val highlightsHtml =
            highlights.joinToString("") { h ->
                highlightTemplate.fill("emoji" to h.emoji, "title" to h.title, "description" to h.description)
            }
        val content =
            load("release-notes.html").fill(
                "version" to version,
                "releaseDate" to releaseDate,
                "highlightsHtml" to highlightsHtml,
                "changelogUrl" to changelogUrl
            )
        return wrap("Scrapalot AI v$version — What's New", content, baseUrl)
    }
}
