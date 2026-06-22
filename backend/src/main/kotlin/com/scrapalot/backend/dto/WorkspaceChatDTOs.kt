package com.scrapalot.backend.dto

import java.time.Instant
import java.util.UUID

data class WorkspaceChatMessageRequest(
    val content: String,
    val workspaceId: UUID
)

data class WorkspaceChatMessageResponse(
    val id: UUID,
    val workspaceId: UUID,
    val senderId: UUID,
    val senderUsername: String?,
    val senderFirstName: String?,
    val senderLastName: String?,
    val senderProfilePicture: String?,
    val content: String,
    val createdAt: Instant
)

data class WorkspaceChatPresenceResponse(
    val userId: UUID,
    val username: String?,
    val firstName: String?,
    val lastName: String?,
    val profilePicture: String?,
    val isOnline: Boolean,
    val lastSeenAt: Instant
)

data class WorkspaceChatPresenceUpdate(
    val userId: UUID,
    val workspaceId: UUID,
    val username: String?,
    val firstName: String?,
    val lastName: String?,
    val profilePicture: String?,
    val isOnline: Boolean,
    val lastSeenAt: Instant
)
