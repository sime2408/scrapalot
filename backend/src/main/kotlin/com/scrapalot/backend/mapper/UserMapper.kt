package com.scrapalot.backend.mapper

import com.scrapalot.backend.domain.auth.User
import com.scrapalot.backend.dto.UpdateUserRequest
import com.scrapalot.backend.dto.UserResponse
import org.mapstruct.Mapper
import org.mapstruct.Mapping
import org.mapstruct.MappingTarget
import org.mapstruct.ReportingPolicy

/**
 * MapStruct mapper for User entity and DTOs
 */
@Mapper(
    componentModel = "spring",
    unmappedTargetPolicy = ReportingPolicy.IGNORE
)
interface UserMapper {
    /**
     * Convert User entity to UserResponse DTO
     */
    fun toUserResponse(user: User): UserResponse

    /**
     * Convert list of User entities to a list of UserResponse DTOs
     */
    fun toUserResponseList(users: List<User>): List<UserResponse>

    /**
     * Update User entity from UpdateUserRequest DTO
     */
    @Mapping(target = "id", ignore = true)
    @Mapping(target = "username", ignore = true)
    @Mapping(target = "email", ignore = true)
    @Mapping(target = "password", ignore = true)
    @Mapping(target = "role", ignore = true)
    @Mapping(target = "licenseAgreementConsent", ignore = true)
    @Mapping(target = "contentSharingConsent", ignore = true)
    @Mapping(target = "createdAt", ignore = true)
    @Mapping(target = "updatedAt", ignore = true)
    fun updateUserFromDto(
        request: UpdateUserRequest,
        @MappingTarget user: User
    )
}
