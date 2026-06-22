package com.scrapalot.backend.dto

import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import java.util.UUID

/**
 * Document quality rating wire shapes.
 *
 * Star widget POSTs RateDocumentRequest with rating=null to clear.
 * Server-side absent rating is treated as "no opinion" — the UI shows
 * an empty star row and retrieval makes no boost decision.
 */

data class RateDocumentRequest(
    @field:NotNull
    val documentId: UUID,
    @field:NotNull
    val workspaceId: UUID,
    /** 1..5, or null to clear an existing rating. */
    @field:Min(1) @field:Max(5)
    val rating: Short? = null,
    @field:Size(max = 500)
    val notes: String? = null,
)

data class UserDocumentRatingResponse(
    val documentId: UUID,
    val workspaceId: UUID,
    val rating: Short?,
    val notes: String?,
    val ratedAt: String?,
    val updatedAt: String?,
)

data class UserDocumentRatingsBatchResponse(
    val ratings: List<UserDocumentRatingResponse>,
)

data class ListRatingsRequest(
    @field:NotNull
    val documentIds: List<UUID>,
)
