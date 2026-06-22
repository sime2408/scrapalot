package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.settings.UserSetting
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.stereotype.Repository
import java.util.UUID

@Suppress("unused")
@Repository
interface UserSettingRepository : JpaRepository<UserSetting, UUID> {
    fun findByUserId(userId: UUID): List<UserSetting>

    fun findByUserIdAndSettingKey(
        userId: UUID,
        settingKey: String
    ): UserSetting?

    fun existsByUserIdAndSettingKey(
        userId: UUID,
        settingKey: String
    ): Boolean

    fun deleteByUserIdAndSettingKey(
        userId: UUID,
        settingKey: String
    ): Int

    fun deleteByUserId(userId: UUID): Int
}
