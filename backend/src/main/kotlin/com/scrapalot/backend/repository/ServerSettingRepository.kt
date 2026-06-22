package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.settings.ServerSetting
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.stereotype.Repository
import java.util.UUID

@Suppress("unused")
@Repository
interface ServerSettingRepository : JpaRepository<ServerSetting, UUID> {
    fun findBySettingKey(settingKey: String): ServerSetting?

    fun existsBySettingKey(settingKey: String): Boolean

    fun deleteBySettingKey(settingKey: String): Int
}
