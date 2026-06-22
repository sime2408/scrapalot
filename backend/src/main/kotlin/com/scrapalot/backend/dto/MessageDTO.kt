package com.scrapalot.backend.dto

import java.time.LocalDateTime
import java.util.UUID

/**
 * Message DTOs for API requests and responses
 */

/**
 * Response DTO for a message
 */
data class MessageDTO(
    val id: UUID,
    val sessionId: UUID,
    val sender: String,
    val role: String,
    val content: String,
    val citations: Map<String, Any>? = null,
    val metadata: Map<String, Any>? = null,
    val feedback: Short? = null,
    val feedbackDetail: Short? = null,
    val usedGraphElementIds: Map<String, Any>? = null,
    val createdAt: LocalDateTime
)

data class MessageFeedbackRequest(
    val feedback: Short?, // 1 = positive, -1 = negative, null = remove feedback
    val feedbackDetail: Short? = null // optional 1..5 fine-grained rating; null falls back to extreme
)

/**
 * Request DTO for creating a new message
 */
data class CreateMessageRequest(
    val sessionId: UUID,
    val role: String,
    val content: String,
    val citations: Map<String, Any>? = null,
    val metadata: Map<String, Any>? = null
)

/**
 * Response DTO for paginated messages
 */
data class MessageListResponse(
    val messages: List<MessageDTO>,
    val total: Long,
    val page: Int,
    val pageSize: Int,
    val totalPages: Int
)
