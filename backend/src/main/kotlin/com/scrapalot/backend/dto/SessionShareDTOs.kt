package com.scrapalot.backend.dto

import java.time.Instant
import java.time.LocalDateTime
import java.util.UUID

data class SessionShareDTO(
    val id: UUID,
    val sessionId: UUID,
    val shareToken: String,
    val messageSnapshotCount: Int,
    val createdAt: Instant,
    val expiresAt: Instant?,
    val shareUrl: String
)

data class CreateSessionShareRequest(
    val expiresAt: Instant? = null
)

data class SharedConversationDTO(
    val conversationName: String?,
    val sharedAt: Instant,
    val messages: List<SharedMessageDTO>
)

data class SharedMessageDTO(
    val role: String,
    val content: String,
    val createdAt: LocalDateTime
)
