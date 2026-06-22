package com.scrapalot.backend.mapper

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.domain.collection.Annotation
import com.scrapalot.backend.dto.AnnotationResponse
import com.scrapalot.backend.dto.CreateAnnotationRequest
import org.mapstruct.Mapper
import org.mapstruct.Mapping
import org.mapstruct.ReportingPolicy
import org.springframework.beans.factory.annotation.Autowired
import java.util.UUID

@Suppress("SpringAutowiredFieldsWarningInspection") // MapStruct abstract class requires field injection for non-mapping dependencies
@Mapper(
    componentModel = "spring",
    unmappedTargetPolicy = ReportingPolicy.IGNORE
)
abstract class AnnotationMapper {
    @Autowired
    protected lateinit var objectMapper: ObjectMapper

    /**
     * Maps an annotation entity to its response DTO.
     *
     * Implemented concretely rather than via MapStruct generation to correctly handle
     * the @JvmName-renamed getters on isExternal and isPinned in the entity.
     */
    fun toAnnotationResponse(annotation: Annotation): AnnotationResponse =
        AnnotationResponse(
            id = requireNotNull(annotation.id) { "Annotation ID must not be null" },
            userId = annotation.userId,
            documentId = annotation.documentId,
            collectionId = annotation.collectionId,
            sessionId = annotation.sessionId,
            annotationType = annotation.annotationType,
            selectedText = annotation.selectedText,
            comment = annotation.comment,
            color = annotation.color,
            pageLabel = annotation.pageLabel,
            sortIndex = annotation.sortIndex,
            positionJson = annotation.positionJson,
            viewerType = annotation.viewerType,
            tagIds = mapTagIdsToList(annotation.tagIds),
            isExternal = annotation.isExternal,
            isPinned = annotation.isPinned,
            createdAt = annotation.createdAt.toString(),
            updatedAt = annotation.updatedAt.toString()
        )

    fun toAnnotationResponseList(annotations: List<Annotation>): List<AnnotationResponse> = annotations.map { toAnnotationResponse(it) }

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "createdAt", ignore = true)
    @Mapping(target = "updatedAt", ignore = true)
    @Mapping(target = "isPinned", constant = "false")
    @Mapping(target = "isExternal", constant = "false")
    abstract fun toAnnotation(
        request: CreateAnnotationRequest,
        userId: UUID
    ): Annotation

    fun mapTagIdsToList(tagIds: String?): List<String>? {
        if (tagIds.isNullOrBlank()) return null
        return try {
            objectMapper.readValue(tagIds, Array<String>::class.java).toList()
        } catch (_: Exception) {
            null
        }
    }

    fun mapTagIdsToString(tagIds: List<String>?): String? {
        if (tagIds.isNullOrEmpty()) return null
        return objectMapper.writeValueAsString(tagIds)
    }
}
