package com.scrapalot.backend.dto

import java.time.Instant
import java.util.UUID

data class DirectMessageRequest(
    val recipientId: UUID,
    val workspaceId: UUID,
    val content: String
)

data class DirectMessageResponse(
    val id: UUID,
    val conversationId: UUID,
    val senderId: UUID,
    val senderUsername: String?,
    val senderFirstName: String?,
    val senderLastName: String?,
    val senderProfilePicture: String?,
    val content: String,
    val readAt: Instant?,
    val createdAt: Instant
)

data class DirectConversationResponse(
    val id: UUID,
    // NULL for admin conversations (admin_dm / admin_broadcast).
    val workspaceId: UUID?,
    val otherUserId: UUID,
    val otherUsername: String?,
    val otherFirstName: String?,
    val otherLastName: String?,
    val otherProfilePicture: String?,
    val lastMessage: String?,
    val lastMessageAt: Instant?,
    val unreadCount: Long,
    val createdAt: Instant,
    // peer | admin_dm | admin_broadcast — frontend routes admin_* to the bell/toast,
    // and treats admin_broadcast as read-only.
    val kind: String = "peer"
)

// ---- Admin messaging overlay ----

data class AdminMessageRequest(
    val content: String
)

data class AdminBroadcastRequest(
    val content: String
)

data class AdminBroadcastResult(
    val delivered: Int
)

@Suppress("unused") // future API — typing indicator DTO for planned WebSocket real-time typing events
data class DirectMessageTypingNotification(
    val conversationId: UUID,
    val userId: UUID,
    val username: String?,
    val isTyping: Boolean
)
