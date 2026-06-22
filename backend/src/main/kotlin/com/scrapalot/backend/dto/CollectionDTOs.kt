package com.scrapalot.backend.dto

import jakarta.validation.constraints.*
import java.util.UUID

// Collection Response
data class CollectionResponse(
    val id: UUID,
    val name: String,
    // Stable slug used in the OpenAI-compat `model` field.
    val slug: String,
    val description: String?,
    val workspaceId: UUID,
    val userId: UUID,
    val parentCollectionId: UUID? = null,
    val depth: Int = 0,
    val sortOrder: Int = 0,
    val chunkingStrategy: String,
    val chunkSize: Int,
    val chunkOverlap: Int,
    val processingStatus: String,
    val settings: Map<String, Any>?,
    // null when no per-collection prompt addendum.
    val customInstructions: String? = null,
    // Knowledge-graph build tier: 0=none, 1=light, 2=full; null=inherit from parent.
    val graphTier: Int? = null,
    val createdAt: String,
    val updatedAt: String
)

// Create Collection Request
@Suppress("JpaImmutableNotNullablePropertyInspection") // DTO, not a JPA entity — val fields with @NotNull are intentional
data class CreateCollectionRequest(
    @field:NotBlank(message = "Collection name is required")
    @field:Size(min = 1, max = 100, message = "Collection name must be between 1 and 100 characters")
    val name: String,
    // Cap aligned with AI-generated description sizes (CollectionAIGrpcClient
    // GenerateDescription emits up to ~600 chars; allow headroom for editing).
    @field:Size(max = 2000, message = "Description cannot exceed 2000 characters")
    val description: String? = null,
    @field:NotNull(message = "Workspace ID is required")
    val workspaceId: UUID,
    @field:Pattern(regexp = "^(recursive|semantic|sentence|paragraph|fixed)$", message = "Invalid chunking strategy")
    val chunkingStrategy: String = "recursive",
    @field:Min(value = 100, message = "Chunk size must be at least 100")
    @field:Max(value = 10000, message = "Chunk size cannot exceed 10000")
    val chunkSize: Int = 1000,
    @field:Min(value = 0, message = "Chunk overlap cannot be negative")
    @field:Max(value = 1000, message = "Chunk overlap cannot exceed 1000")
    val chunkOverlap: Int = 200,
    val parentCollectionId: UUID? = null,
    // Knowledge-graph build tier: 0=none, 1=light, 2=full; null=inherit from parent.
    @field:Min(value = 0, message = "graph_tier must be 0, 1 or 2")
    @field:Max(value = 2, message = "graph_tier must be 0, 1 or 2")
    val graphTier: Int? = null,
    val settings: Map<String, Any>? = null
)

// Update Collection Request
data class UpdateCollectionRequest(
    @field:Size(min = 1, max = 100, message = "Collection name must be between 1 and 100 characters")
    val name: String? = null,
    // Cap aligned with AI-generated description sizes (CollectionAIGrpcClient
    // GenerateDescription emits up to ~600 chars; allow headroom for editing).
    @field:Size(max = 2000, message = "Description cannot exceed 2000 characters")
    val description: String? = null,
    @field:Pattern(regexp = "^(recursive|semantic|sentence|paragraph|fixed)$", message = "Invalid chunking strategy")
    val chunkingStrategy: String? = null,
    @field:Min(value = 100, message = "Chunk size must be at least 100")
    @field:Max(value = 10000, message = "Chunk size cannot exceed 10000")
    val chunkSize: Int? = null,
    @field:Min(value = 0, message = "Chunk overlap cannot be negative")
    @field:Max(value = 1000, message = "Chunk overlap cannot exceed 1000")
    val chunkOverlap: Int? = null,
    val parentCollectionId: UUID? = null,
    val settings: Map<String, Any>? = null,
    // pass an empty string ("") to clear an existing
    // value; null means "do not touch". 2000-char cap enforced here so
    // the validation message reaches the UI.
    @field:Size(max = 2000, message = "Custom instructions cannot exceed 2000 characters")
    val customInstructions: String? = null,
    // Knowledge-graph build tier: 0=none, 1=light, 2=full; null means "do not touch"
    // (use -1 to explicitly reset back to inherit-from-parent).
    @field:Min(value = -1, message = "graph_tier must be -1 (inherit), 0, 1 or 2")
    @field:Max(value = 2, message = "graph_tier must be -1 (inherit), 0, 1 or 2")
    val graphTier: Int? = null
)

// Collection Summary Response
data class CollectionSummaryResponse(
    val collectionId: UUID,
    val name: String,
    val documentCount: Long,
    val totalSize: Long,
    val processingStatus: String
)

// Pagination metadata (compatible with Python backend format)
data class CollectionPaginationResponse(
    val page: Int,
    val limit: Int,
    val total: Int,
    val hasMore: Boolean
)

// Paginated Collections Response
data class PaginatedCollectionsResponse(
    val collections: List<CollectionResponse>,
    val pagination: CollectionPaginationResponse
)
