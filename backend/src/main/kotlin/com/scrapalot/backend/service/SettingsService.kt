package com.scrapalot.backend.service

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.domain.settings.ServerSetting
import com.scrapalot.backend.domain.settings.UserSetting
import com.scrapalot.backend.repository.ServerSettingRepository
import com.scrapalot.backend.repository.UserSettingRepository
import mu.KotlinLogging
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.server.ResponseStatusException
import java.time.Duration
import java.time.Instant
import java.util.NoSuchElementException
import java.util.UUID

private val logger = KotlinLogging.logger {}

@Service
@Transactional
class SettingsService(
    private val userSettingRepository: UserSettingRepository,
    private val serverSettingRepository: ServerSettingRepository,
    private val redisEventPublisher: RedisEventPublisher,
    private val sagaAckWaiter: SagaAckWaiter,
    private val objectMapper: ObjectMapper
) {
    // User Settings
    @Transactional(readOnly = true)
    fun getUserSetting(
        userId: UUID,
        key: String
    ): UserSetting? = userSettingRepository.findByUserIdAndSettingKey(userId, key)

    @Transactional(readOnly = true)
    fun getAllUserSettings(userId: UUID): List<UserSetting> = userSettingRepository.findByUserId(userId)

    fun setUserSetting(
        userId: UUID,
        key: String,
        value: Map<String, Any>?
    ): UserSetting {
        val valueJson = if (value != null) objectMapper.writeValueAsString(value) else "{}"

        executeSaga("setting sync") { sagaId ->
            redisEventPublisher.publishUserSettingToStream(sagaId, userId, key, valueJson, "UPSERT")
        }

        val existing = userSettingRepository.findByUserIdAndSettingKey(userId, key)

        return if (existing != null) {
            val updated =
                existing.copy(
                    settingValue = value,
                    updatedAt = Instant.now()
                )
            userSettingRepository.save(updated)
        } else {
            val newSetting =
                UserSetting(
                    userId = userId,
                    settingKey = key,
                    settingValue = value,
                    createdAt = Instant.now(),
                    updatedAt = Instant.now()
                )
            userSettingRepository.save(newSetting)
        }
    }

    fun deleteUserSetting(
        userId: UUID,
        key: String
    ) {
        executeSaga("setting delete") { sagaId ->
            redisEventPublisher.publishUserSettingToStream(sagaId, userId, key, "{}", "DELETE")
        }

        val deleted = userSettingRepository.deleteByUserIdAndSettingKey(userId, key)
        if (deleted == 0) {
            throw NoSuchElementException("User setting not found: $key for user: $userId")
        }
        logger.info { "Deleted user setting: $key for user: $userId" }
    }

    // Server Settings
    @Transactional(readOnly = true)
    fun getServerSetting(key: String): ServerSetting? = serverSettingRepository.findBySettingKey(key)

    @Transactional(readOnly = true)
    fun getAllServerSettings(): List<ServerSetting> = serverSettingRepository.findAll()

    fun setServerSetting(
        key: String,
        value: Map<String, Any>?
    ): ServerSetting {
        val existing = serverSettingRepository.findBySettingKey(key)

        return if (existing != null) {
            val updated =
                existing.copy(
                    settingValue = value,
                    updatedAt = Instant.now()
                )
            serverSettingRepository.save(updated)
        } else {
            val newSetting =
                ServerSetting(
                    settingKey = key,
                    settingValue = value,
                    createdAt = Instant.now(),
                    updatedAt = Instant.now()
                )
            serverSettingRepository.save(newSetting)
        }
    }

    fun deleteServerSetting(key: String) {
        val deleted = serverSettingRepository.deleteBySettingKey(key)
        if (deleted == 0) {
            throw NoSuchElementException("Server setting not found: $key")
        }
        logger.info { "Deleted server setting: $key" }
    }

    // Helper methods for specific settings
    @Transactional(readOnly = true)
    fun getSelectedWorkspace(userId: UUID): UUID? {
        val setting = getUserSetting(userId, "selected_workspace")
        return (setting?.settingValue?.get("workspace_id") as? String)?.let { UUID.fromString(it) }
    }

    fun setSelectedWorkspace(
        userId: UUID,
        workspaceId: UUID
    ) {
        setUserSetting(userId, "selected_workspace", mapOf("workspace_id" to workspaceId.toString()))
        logger.info { "Set selected workspace for user: $userId to workspace: $workspaceId" }
    }

    @Transactional(readOnly = true)
    fun getGeneralSettings(userId: UUID): Map<String, Any>? = getUserSetting(userId, "settings_general")?.settingValue

    fun setGeneralSettings(
        userId: UUID,
        settings: Map<String, Any>
    ) {
        // Merge with existing settings to prevent partial updates from wiping unrelated fields
        val existing = getGeneralSettings(userId) ?: emptyMap()
        val merged = existing + settings
        setUserSetting(userId, "settings_general", merged)
        logger.info { "Updated general settings for user: $userId" }
    }

    @Transactional(readOnly = true)
    fun getDocumentProcessingSettings(userId: UUID): Map<String, Any>? = getUserSetting(userId, "document_processing")?.settingValue

    fun setDocumentProcessingSettings(
        userId: UUID,
        settings: Map<String, Any>
    ) {
        setUserSetting(userId, "document_processing", settings)
        logger.info { "Updated document processing settings for user: $userId" }
    }

    private fun executeSaga(
        operation: String,
        publish: (sagaId: String) -> Unit
    ) {
        val sagaId = UUID.randomUUID().toString()
        publish(sagaId)
        val ack = sagaAckWaiter.waitForAck(sagaId, Duration.ofSeconds(10))
        if (ack == null || ack.status != "ACK") {
            val errorDetail = ack?.error ?: "timeout"
            logger.error { "SAGA failed for $operation: $errorDetail (saga_id=$sagaId)" }
            throw ResponseStatusException(
                HttpStatus.SERVICE_UNAVAILABLE,
                "AI backend did not confirm $operation: $errorDetail"
            )
        }
    }
}
