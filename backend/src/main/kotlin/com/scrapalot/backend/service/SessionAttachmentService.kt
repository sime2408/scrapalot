package com.scrapalot.backend.service

import com.scrapalot.backend.domain.chat.SessionAttachment
import com.scrapalot.backend.dto.ChatAttachmentDTO
import com.scrapalot.backend.dto.SessionAttachmentDTO
import com.scrapalot.backend.exception.NotFoundException
import com.scrapalot.backend.repository.SessionAttachmentRepository
import com.scrapalot.backend.repository.SessionRepository
import mu.KotlinLogging
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.UUID

private val logger = KotlinLogging.logger {}

/**
 * Owns the lifecycle of user-uploaded attachments that stay bound to a chat
 * session for the whole conversation.
 *
 * Flow:
 *  - The client sends a freshly-attached document's extracted text inline once
 *    (in the chat request). [persistAndLoad] stores it (de-duplicated, capped)
 *    and returns the FULL set of the session's attachments so ChatService can
 *    inject them into every gRPC call — including later messages where the
 *    client sends no attachments at all. That makes the document available to
 *    follow-up questions instead of being discarded after one response.
 *  - The UI lists chips via [listForSession] (metadata only) and removes one
 *    via [delete].
 */
@Service
class SessionAttachmentService(
    private val sessionAttachmentRepository: SessionAttachmentRepository,
    private val sessionRepository: SessionRepository
) {
    /**
     * Persist any genuinely-new incoming attachments for [sessionId], then
     * return the full session attachment set as [ChatAttachmentDTO]s for gRPC.
     *
     * De-dup key is (type, filename, capped-length) so re-sending the same chip
     * on a later message never creates duplicates. Content is capped at
     * [MAX_CONTENT_CHARS] to bound storage and per-message token cost.
     */
    @Transactional
    fun persistAndLoad(
        sessionId: UUID,
        incoming: List<ChatAttachmentDTO>,
        tier: String
    ): List<ChatAttachmentDTO> {
        if (incoming.isNotEmpty()) {
            val existingKeys =
                sessionAttachmentRepository
                    .findBySessionIdOrderByCreatedAtAsc(sessionId)
                    .map { dedupKey(it.type, it.filename, it.content.length) }
                    .toSet()
            incoming.forEach { att ->
                val capped = att.content.take(MAX_CONTENT_CHARS)
                val key = dedupKey(att.type, att.filename, capped.length)
                if (key !in existingKeys) {
                    sessionAttachmentRepository.save(
                        SessionAttachment(
                            sessionId = sessionId,
                            type = att.type.ifBlank { "document" },
                            filename = att.filename,
                            mimeType = att.mimeType.takeIf { it.isNotBlank() },
                            content = capped,
                            charCount = capped.length
                        )
                    )
                    logger.info { "Persisted session attachment '${att.filename}' (${capped.length} chars) for session $sessionId" }
                }
            }
        }

        // The full document stays persisted (chip + char_count are unchanged); only
        // the text RE-INJECTED into the LLM context on every message is bounded by a
        // per-tier budget. Without this, a 100k-char doc (~25k tokens) re-sent every
        // turn burns a researcher (100k tokens/mo) plan in a handful of questions.
        val budget = reinjectBudgetForTier(tier)
        var remaining = budget
        return sessionAttachmentRepository
            .findBySessionIdOrderByCreatedAtAsc(sessionId)
            .map { att ->
                val content =
                    if (att.content.length <= remaining) {
                        remaining -= att.content.length
                        att.content
                    } else {
                        val head = att.content.take(remaining.coerceAtLeast(0))
                        remaining = 0
                        if (head.isEmpty()) {
                            REINJECT_TRUNCATION_NOTICE
                        } else {
                            head + REINJECT_TRUNCATION_NOTICE
                        }
                    }
                ChatAttachmentDTO(type = att.type, filename = att.filename, content = content, mimeType = att.mimeType ?: "")
            }
    }

    @Transactional(readOnly = true)
    fun listForSession(
        sessionId: UUID,
        userId: UUID
    ): List<SessionAttachmentDTO> {
        requireSessionOwnership(sessionId, userId)
        return sessionAttachmentRepository
            .findBySessionIdOrderByCreatedAtAsc(sessionId)
            .map { SessionAttachmentDTO(it.id, it.type, it.filename, it.mimeType, it.charCount, it.createdAt) }
    }

    @Transactional
    fun delete(
        sessionId: UUID,
        attachmentId: UUID,
        userId: UUID
    ) {
        requireSessionOwnership(sessionId, userId)
        val attachment =
            sessionAttachmentRepository
                .findById(attachmentId)
                .orElseThrow { NotFoundException("Attachment not found: $attachmentId") }
        if (attachment.sessionId != sessionId) {
            throw NotFoundException("Attachment $attachmentId does not belong to session $sessionId")
        }
        sessionAttachmentRepository.delete(attachment)
        logger.info { "Deleted session attachment $attachmentId from session $sessionId" }
    }

    private fun requireSessionOwnership(
        sessionId: UUID,
        userId: UUID
    ) {
        if (!sessionRepository.existsByIdAndUserId(sessionId, userId)) {
            throw NotFoundException("Session not found: $sessionId")
        }
    }

    private fun dedupKey(
        type: String,
        filename: String,
        length: Int
    ): String = "$type|$filename|$length"

    /**
     * Total chars of attachment text re-injected into the LLM context PER MESSAGE,
     * by plan tier. Re-injection happens every turn so a follow-up can still see the
     * doc; this bounds the per-message cost so a big document can't drain a small
     * plan's monthly token allowance. Full content stays stored — only the per-turn
     * context is trimmed. (~4 chars ≈ 1 token.)
     */
    private fun reinjectBudgetForTier(tier: String): Int =
        when (tier.lowercase()) {
            "team", "enterprise" -> MAX_CONTENT_CHARS // ≥50M tokens/mo — send the full stored doc
            "pro" -> 120_000 // ~30k tokens — generous; 5M tokens/mo absorbs it
            else -> 24_000 // free / researcher (≤100k tokens/mo) — ~6k tokens; bounded
        }

    companion object {
        /** Per-attachment content cap (~50k tokens) to bound storage + token cost. */
        const val MAX_CONTENT_CHARS = 200_000

        /** Appended when a doc is trimmed to fit the per-tier re-injection budget. */
        const val REINJECT_TRUNCATION_NOTICE =
            "\n\n[Attached document trimmed to fit your plan's per-message context budget. " +
                "Add it to a Knowledge collection for full-document retrieval, or upgrade your plan for larger context.]"
    }
}
