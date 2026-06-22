package com.scrapalot.backend.mapper

import com.scrapalot.backend.domain.settings.ServerSetting
import com.scrapalot.backend.domain.settings.UserSetting
import com.scrapalot.backend.dto.ServerSettingResponse
import com.scrapalot.backend.dto.UserSettingResponse
import org.mapstruct.Mapper
import org.mapstruct.ReportingPolicy

/**
 * MapStruct mapper for Settings entities and DTOs
 */
@Mapper(
    componentModel = "spring",
    unmappedTargetPolicy = ReportingPolicy.IGNORE
)
interface SettingsMapper {
    /**
     * Convert UserSetting entity to UserSettingResponse DTO
     */
    fun toUserSettingResponse(setting: UserSetting): UserSettingResponse

    /**
     * Convert list of UserSetting entities to a list of UserSettingResponse DTOs
     */
    fun toUserSettingResponseList(settings: List<UserSetting>): List<UserSettingResponse>

    /**
     * Convert ServerSetting entity to ServerSettingResponse DTO
     */
    fun toServerSettingResponse(setting: ServerSetting): ServerSettingResponse

    /**
     * Convert list of ServerSetting entities to a list of ServerSettingResponse DTOs
     */
    fun toServerSettingResponseList(settings: List<ServerSetting>): List<ServerSettingResponse>
}
