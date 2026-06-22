package com.scrapalot.backend.dto

import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import java.time.LocalDateTime
import java.util.UUID

data class SessionFolderDTO(
    val id: UUID,
    val userId: UUID,
    val name: String,
    val position: Int,
    val sessionCount: Long = 0,
    val createdAt: LocalDateTime,
    val updatedAt: LocalDateTime
)

data class CreateSessionFolderRequest(
    @field:NotBlank(message = "Folder name is required")
    @field:Size(max = 100, message = "Folder name cannot exceed 100 characters")
    val name: String
)

data class UpdateSessionFolderRequest(
    val name: String? = null,
    val position: Int? = null
)

data class MoveSessionRequest(
    val sessionFolderId: UUID? = null
)
