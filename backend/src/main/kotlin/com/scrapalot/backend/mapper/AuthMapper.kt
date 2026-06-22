package com.scrapalot.backend.mapper

import com.scrapalot.backend.domain.auth.APIKey
import com.scrapalot.backend.dto.APIKeyResponse
import com.scrapalot.backend.dto.TokenResponse
import org.mapstruct.Mapper
import org.mapstruct.Mapping
import org.mapstruct.ReportingPolicy

/**
 * MapStruct mapper for Auth-related entities and DTOs
 */
@Mapper(
    componentModel = "spring",
    unmappedTargetPolicy = ReportingPolicy.IGNORE
)
interface AuthMapper {
    /**
     * Convert tokens to TokenResponse DTO
     */
    @Mapping(target = "tokenType", constant = "bearer")
    @Mapping(target = "expiresIn", constant = "3600L")
    fun toTokenResponse(
        accessToken: String,
        refreshToken: String
    ): TokenResponse

    /**
     * Convert APIKey entity to APIKeyResponse DTO
     */
    @Mapping(target = "plainTextKey", ignore = true)
    fun toAPIKeyResponse(apiKey: APIKey): APIKeyResponse

    /**
     * Convert list of APIKey entities to a list of APIKeyResponse DTOs
     */
    fun toAPIKeyResponseList(apiKeys: List<APIKey>): List<APIKeyResponse>
}
