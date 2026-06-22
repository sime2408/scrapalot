package com.scrapalot.backend.dto

import java.util.UUID

data class AgentProfileResponse(
    val id: UUID,
    val workspaceId: UUID?,
    val slug: String,
    val name: String,
    val description: String?,
    val icon: String?,
    val systemPrompt: String,
    val ragStrategy: String?,
    val citationStyle: String?,
    val toolAllowlist: String?,
    val isSystem: Boolean,
    val createdAt: String,
    val updatedAt: String,
)

data class AgentProfilesListResponse(
    val profiles: List<AgentProfileResponse>,
)
