package com.scrapalot.backend.mapper

import com.scrapalot.backend.domain.collection.Collection
import com.scrapalot.backend.dto.CollectionResponse
import org.mapstruct.Mapper
import org.mapstruct.Mapping
import org.mapstruct.ReportingPolicy

/**
 * MapStruct mapper for Collection entity and DTOs
 */
@Mapper(
    componentModel = "spring",
    unmappedTargetPolicy = ReportingPolicy.IGNORE
)
interface CollectionMapper {
    /**
     * Convert Collection entity to CollectionResponse DTO
     */
    @Mapping(target = "processingStatus", expression = "java(collection.isProcessing() ? \"processing\" : \"completed\")")
    @Mapping(target = "settings", expression = "java(java.util.Collections.emptyMap())")
    fun toCollectionResponse(collection: Collection): CollectionResponse

    /**
     * Convert list of Collection entities to a list of CollectionResponse DTOs
     */
    fun toCollectionResponseList(collections: List<Collection>): List<CollectionResponse>
}
