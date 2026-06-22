package com.scrapalot.backend.dto

import jakarta.validation.constraints.NotBlank
import java.util.UUID

data class DocumentResponse(
    val id: UUID,
    val fileName: String,
    val fileType: String?,
    val fileSize: Long,
    val filePath: String,
    val collectionId: UUID,
    val userId: UUID,
    val processingStatus: String,
    val processingProgress: Int,
    val errorMessage: String?,
    val fileMetadata: Map<String, Any>?,
    val uploadedAt: String?,
    val processedAt: String?,
    val createdAt: String?,
    val updatedAt: String?
)

data class StorageUsageResponse(
    val collectionId: UUID?,
    val workspaceId: UUID?,
    val documentCount: Long,
    val totalSize: Long,
    val formattedSize: String
)

data class RegisterMarkdownDocumentRequest(
    @field:NotBlank(message = "collectionId is required")
    val collectionId: String,
    @field:NotBlank(message = "filename is required")
    val filename: String,
    @field:NotBlank(message = "title is required")
    val title: String,
    @field:NotBlank(message = "markdownContent is required")
    val markdownContent: String,
    val metadata: Map<String, Any> = emptyMap()
)

data class RegisterMarkdownDocumentResponse(
    val documentId: String,
    val status: String = "pending"
)
