package com.scrapalot.backend.dto

import com.scrapalot.backend.utils.ValidJson
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import java.util.UUID

/**
 * Annotation response DTO — returned to frontend.
 */
data class AnnotationResponse(
    val id: UUID,
    val userId: UUID,
    val documentId: UUID,
    val collectionId: UUID,
    val sessionId: UUID?,
    val annotationType: Short,
    val selectedText: String?,
    val comment: String?,
    val color: String,
    val pageLabel: String?,
    val sortIndex: String?,
    val positionJson: String,
    val viewerType: String,
    val tagIds: List<String>? = null,
    val isExternal: Boolean = false,
    val isPinned: Boolean,
    val createdAt: String,
    val updatedAt: String
)

/**
 * Create an annotation request DTO.
 *
 * Position JSON format:
 * - PDF:  {"type":"pdf","pageIndex":0,"rects":[{"left":12.5,"top":45.2,"width":75.0,"height":1.8}]}
 * - EPUB: {"type":"epub","cfi":"epubcfi(/6/4[chap01]!/4/2/16,/1:0,/1:10)","sectionIndex":3}
 */
@Suppress("JpaImmutableNotNullablePropertyInspection") // DTO, not a JPA entity — val fields with @NotNull are intentional
data class CreateAnnotationRequest(
    @field:NotNull(message = "Document ID is required")
    val documentId: UUID,
    @field:NotNull(message = "Collection ID is required")
    val collectionId: UUID,
    val sessionId: UUID? = null,
    val annotationType: Short = 1,
    @field:Size(max = 100000, message = "Selected text cannot exceed 100KB")
    val selectedText: String? = null,
    @field:Size(max = 10000, message = "Comment cannot exceed 10KB")
    val comment: String? = null,
    @field:Pattern(
        regexp = "^#[0-9a-fA-F]{6}$",
        message = "Color must be a hex color code (e.g., #ffd400)"
    )
    val color: String = "#ffd400",
    val pageLabel: String? = null,
    val sortIndex: String? = null,
    @field:NotBlank(message = "Position JSON is required")
    @field:Size(max = 65000, message = "Position JSON cannot exceed 65KB")
    @field:ValidJson(message = "Position JSON must be valid JSON")
    val positionJson: String,
    @field:Pattern(
        regexp = "^(pdf|epub)$",
        message = "Viewer type must be 'pdf' or 'epub'"
    )
    val viewerType: String = "pdf",
    val tagIds: List<String>? = null
)

/**
 * Update annotation request DTO — all fields optional (partial update).
 */
data class UpdateAnnotationRequest(
    @field:Size(max = 10000, message = "Comment cannot exceed 10KB")
    val comment: String? = null,
    @field:Pattern(
        regexp = "^#[0-9a-fA-F]{6}$",
        message = "Color must be a hex color code"
    )
    val color: String? = null,
    val isPinned: Boolean? = null,
    val tagIds: List<String>? = null
)

/**
 * Bulk create annotation request (e.g., Zotero connector import).
 */
data class BulkCreateAnnotationsRequest(
    val annotations: List<CreateAnnotationRequest>
)

/**
 * Annotation count per document — for badges in Library view.
 */
data class AnnotationCountResponse(
    val documentId: UUID,
    val count: Long
)

/**
 * Sharing DTOs (multi-user annotation sharing).
 *
 * Permission values are validated against {"read","write"} in the service.
 */
data class CreateAnnotationShareRequest(
    @field:NotNull(message = "Recipient user_id is required")
    val sharedWithUserId: UUID,
    @field:Pattern(
        regexp = "^(read|write)$",
        message = "Permission must be 'read' or 'write'"
    )
    val permission: String = "read",
)

data class AnnotationShareResponse(
    val annotationId: UUID,
    val sharedWithUserId: UUID,
    val permission: String,
    val createdAt: String,
)
