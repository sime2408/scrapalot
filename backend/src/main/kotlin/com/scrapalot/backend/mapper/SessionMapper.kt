package com.scrapalot.backend.mapper

import com.scrapalot.backend.domain.chat.Session
import com.scrapalot.backend.dto.SessionDTO
import com.scrapalot.backend.dto.UpdateSessionRequest
import org.mapstruct.Mapper
import org.mapstruct.Mapping
import org.mapstruct.MappingTarget
import org.mapstruct.NullValuePropertyMappingStrategy

/**
 * MapStruct mapper for Session entity
 */
@Mapper(
    componentModel = "spring",
    nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE
)
interface SessionMapper {
    /**
     * Convert entity to DTO
     */
    @Mapping(target = "messageCount", ignore = true)
    fun toDto(entity: Session): SessionDTO

    /**
     * Convert DTOs to entities
     */
    fun toDtoList(entities: List<Session>): List<SessionDTO>

    /**
     * Update entity from request (partial update)
     */
    @Mapping(target = "id", ignore = true)
    @Mapping(target = "userId", ignore = true)
    @Mapping(target = "collectionId", ignore = true)
    @Mapping(target = "createdAt", ignore = true)
    @Mapping(target = "updatedAt", expression = "java(java.time.LocalDateTime.now())")
    @Mapping(target = "user", ignore = true)
    @Mapping(target = "collection", ignore = true)
    @Mapping(target = "messages", ignore = true)
    @Mapping(target = "sessionFolderId", ignore = true)
    @Mapping(target = "sessionFolder", ignore = true)
    @Mapping(target = "markerIcon", ignore = true)
    @Mapping(target = "markerColor", ignore = true)
    // Kotlin Boolean `isPinned` exposes setPinned() → MapStruct property `pinned`.
    @Mapping(target = "pinned", ignore = true)
    fun updateEntity(
        request: UpdateSessionRequest,
        @MappingTarget entity: Session
    )
}
