package com.scrapalot.backend.domain.collection

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "collections", schema = "scrapalot")
data class Collection(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(nullable = false, length = 100)
    var name: String,
    // Stable identifier for the OpenAI-compatible API surface
    // (model="scrapalot:workspace-slug:collection-slug"). Set on create
    // via SlugUtils, unique per workspace_id.
    @Column(nullable = false, length = 120)
    var slug: String,
    @Column(columnDefinition = "TEXT")
    var description: String? = null,
    // True once the user manually edits the description. The background
    // collection-memory digest (Python → Redis stream) refreshes the description
    // only while this is false, so a user-owned description is never overwritten.
    @Column(name = "description_user_edited", nullable = false)
    var descriptionUserEdited: Boolean = false,
    @Column(name = "workspace_id", nullable = false, columnDefinition = "uuid")
    var workspaceId: UUID,
    @Column(name = "chunking_strategy", nullable = true, length = 50)
    var chunkingStrategy: String? = null,
    @Column(name = "chunk_size", nullable = true)
    var chunkSize: Int? = null,
    @Column(name = "chunk_overlap", nullable = true)
    var chunkOverlap: Int? = null,
    @Column(name = "parent_collection_id", columnDefinition = "uuid")
    var parentCollectionId: UUID? = null,
    @Column(name = "depth", nullable = false)
    var depth: Int = 0,
    @Column(name = "sort_order", nullable = false)
    var sortOrder: Int = 0,
    @Column(name = "is_processing", nullable = false)
    var isProcessing: Boolean = false,
    @Column(name = "processing_error", columnDefinition = "TEXT")
    var processingError: String? = null,
    // free-text addendum injected as layer 3 of the
    // system-prompt builder priority chain. UI caps at 2000 chars.
    @Column(name = "custom_instructions", columnDefinition = "TEXT")
    var customInstructions: String? = null,
    // Knowledge-graph build tier for every book in this collection:
    // 0=none (embeddings only), 1=light (entities + MENTIONS/REFERENCES via spaCy),
    // 2=full (LLM entities + co-occurrence + PageRank + communities + cross-book).
    // NULL = inherit from the parent collection; a root collection still NULL
    // resolves to 0. Source of truth here; replicated to Python over the
    // collections Redis stream.
    @Column(name = "graph_tier")
    var graphTier: Int? = null,
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant = Instant.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: Instant = Instant.now()
) {
    @PreUpdate
    fun onUpdate() {
        updatedAt = Instant.now()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Collection) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "Collection(id=$id, name='$name', workspaceId=$workspaceId, isProcessing=$isProcessing)"
}
