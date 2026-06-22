package com.scrapalot.backend.mapper

import com.scrapalot.backend.domain.chat.Message
import com.scrapalot.backend.dto.CreateMessageRequest
import com.scrapalot.backend.dto.MessageDTO
import org.mapstruct.Mapper
import org.mapstruct.Mapping

/**
 * MapStruct mapper for Message entity
 */
@Mapper(componentModel = "spring")
interface MessageMapper {
    /**
     * Convert entity to DTO
     */
    fun toDto(entity: Message): MessageDTO

    /**
     * Convert DTOs to entities
     */
    fun toDtoList(entities: List<Message>): List<MessageDTO>

    /**
     * Create entity from request
     */
    @Mapping(target = "id", expression = "java(java.util.UUID.randomUUID())")
    @Mapping(target = "createdAt", expression = "java(java.time.LocalDateTime.now())")
    @Mapping(target = "sender", source = "role")
    @Mapping(target = "session", ignore = true)
    fun toEntity(request: CreateMessageRequest): Message
}
