package com.scrapalot.backend.dto

import java.time.LocalDateTime
import java.util.UUID

/**
 * Session DTOs for API requests and responses
 */

/**
 * Response DTO for session
 */
data class SessionDTO(
    val id: UUID,
    val userId: UUID,
    val collectionId: UUID?,
    val sessionFolderId: UUID?,
    val conversationName: String?,
    val conversationSummary: String?,
    val lastModelUsed: String?,
    val markerIcon: String? = null,
    val markerColor: String? = null,
    val isPinned: Boolean = false,
    val createdAt: LocalDateTime,
    val updatedAt: LocalDateTime,
    val messageCount: Long? = null
)

/**
 * Request DTO for creating a new session
 */
data class CreateSessionRequest(
    val collectionId: UUID? = null,
    val conversationName: String? = null,
    val lastModelUsed: String? = null
)

/**
 * Request DTO for updating an existing session
 */
data class UpdateSessionRequest(
    val conversationName: String? = null,
    val conversationSummary: String? = null,
    val lastModelUsed: String? = null
)

/**
 * Request DTO for setting/clearing a session marker. Dedicated endpoint so a
 * rename never wipes the marker (and vice-versa). Both null = clear the marker.
 */
data class SetSessionMarkerRequest(
    val markerIcon: String? = null,
    val markerColor: String? = null
)

/**
 * Request DTO for pinning/unpinning a session. Dedicated endpoint so a rename or
 * marker change never toggles the pin (and vice-versa).
 */
data class SetSessionPinRequest(
    val isPinned: Boolean
)

/**
 * Response DTO for paginated sessions
 */
data class SessionListResponse(
    val sessions: List<SessionDTO>,
    val total: Long,
    val page: Int,
    val pageSize: Int,
    val totalPages: Int
)

/**
 * Response DTO for session metrics (token usage aggregation)
 */
data class SessionMetricsResponse(
    val sessionId: UUID,
    val totalTokens: Long,
    val totalCost: Double,
    val totalRequests: Int,
    val avgTokensPerSecond: Double,
    val providers: Map<String, ProviderMetrics>
)

data class ProviderMetrics(
    val totalTokens: Long,
    val totalCost: Double,
    val requestCount: Int
)
