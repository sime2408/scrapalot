package com.scrapalot.backend.domain.chat

import com.scrapalot.backend.domain.auth.User
import com.scrapalot.backend.domain.collection.Collection
import jakarta.persistence.*
import java.time.LocalDateTime
import java.util.UUID

/**
 * Chat session entity
 * Represents a conversation between a user and the AI assistant
 */
@Entity
@Table(name = "sessions", schema = "scrapalot")
class Session(
    @Id
    @Column(name = "id", nullable = false)
    var id: UUID = UUID.randomUUID(),
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: LocalDateTime = LocalDateTime.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: LocalDateTime = LocalDateTime.now(),
    @Column(name = "user_id", nullable = false)
    var userId: UUID,
    @Column(name = "collection_id", nullable = true)
    var collectionId: UUID? = null,
    @Column(name = "conversation_name", length = 255, nullable = true)
    var conversationName: String? = null,
    @Column(name = "conversation_summary", columnDefinition = "TEXT", nullable = true)
    var conversationSummary: String? = null,
    @Column(name = "last_model_used", length = 255, nullable = true)
    var lastModelUsed: String? = null,
    @Column(name = "session_folder_id", nullable = true)
    var sessionFolderId: UUID? = null,
    // Per-session marker (Gmail-label-style): a curated priority emoji + palette
    // color the user sets from the row's three-dots menu. NULL = unmarked.
    @Column(name = "marker_icon", length = 16, nullable = true)
    var markerIcon: String? = null,
    @Column(name = "marker_color", length = 16, nullable = true)
    var markerColor: String? = null,
    // Pin-to-top: when true the session floats to the top of its sidebar group
    // (folder or unfiled), independent of the marker and of recency ordering.
    @Column(name = "is_pinned", nullable = false)
    var isPinned: Boolean = false,
    // Relationships
    @Suppress("unused") // JPA relationship — used for lazy-loaded folder navigation in future folder features
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "session_folder_id", insertable = false, updatable = false)
    var sessionFolder: SessionFolder? = null,
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", insertable = false, updatable = false)
    var user: User? = null,
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "collection_id", insertable = false, updatable = false)
    var collection: Collection? = null,
    @OneToMany(mappedBy = "session", cascade = [CascadeType.ALL], orphanRemoval = true)
    var messages: MutableList<Message> = mutableListOf()
) {
    @PreUpdate
    fun preUpdate() {
        updatedAt = LocalDateTime.now()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Session) return false
        return id == other.id
    }

    override fun hashCode(): Int = id.hashCode()

    override fun toString(): String = "Session(id=$id, userId=$userId, conversationName=$conversationName, createdAt=$createdAt)"
}
