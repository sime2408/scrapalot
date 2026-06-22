package com.scrapalot.backend.domain.profile

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

/**
 * Agent profile (Knowledge Agents UI).
 *
 * System profiles have workspace_id = NULL and is_system = TRUE.
 * Workspace-owned profiles have a workspace_id and is_system = FALSE.
 * The (workspace_id, slug) unique constraint accepts NULL on the
 * workspace side because Postgres treats NULL as distinct.
 */
@Entity
@Table(name = "agent_profiles", schema = "scrapalot")
data class AgentProfile(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "workspace_id", columnDefinition = "uuid")
    var workspaceId: UUID? = null,
    @Column(nullable = false, length = 64)
    var slug: String,
    @Column(nullable = false, length = 120)
    var name: String,
    @Column(columnDefinition = "TEXT")
    var description: String? = null,
    @Column(length = 32)
    var icon: String? = null,
    @Column(name = "system_prompt", nullable = false, columnDefinition = "TEXT")
    var systemPrompt: String,
    @Column(name = "rag_strategy", length = 64)
    var ragStrategy: String? = null,
    @Column(name = "citation_style", length = 16)
    var citationStyle: String? = null,
    @Column(name = "tool_allowlist", columnDefinition = "TEXT")
    var toolAllowlist: String? = null,
    @Column(name = "is_system", nullable = false)
    var isSystem: Boolean = false,
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant = Instant.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: Instant = Instant.now(),
) {
    @PreUpdate
    fun onUpdate() {
        updatedAt = Instant.now()
    }
}
