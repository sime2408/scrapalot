package com.scrapalot.backend.dto

import jakarta.validation.constraints.*
import java.util.UUID

// User Setting Response
data class UserSettingResponse(
    val id: UUID,
    val userId: UUID,
    val settingKey: String,
    val settingValue: Map<String, Any>?,
    val createdAt: String,
    val updatedAt: String
)

// Server Setting Response
data class ServerSettingResponse(
    val id: UUID,
    val settingKey: String,
    val settingValue: Any?,
    val createdAt: String,
    val updatedAt: String
)

// Batch Settings Request
data class BatchSettingsRequest(
    @field:NotEmpty(message = "Settings map cannot be empty")
    @field:Size(max = 50, message = "Cannot update more than 50 settings at once")
    val settings: Map<String, Map<String, Any>?>
)
