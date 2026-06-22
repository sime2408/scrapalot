package com.scrapalot.backend.grpc

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.grpc.common.Empty
import com.scrapalot.backend.grpc.common.StatusResponse
import com.scrapalot.backend.grpc.common.Timestamp
import com.scrapalot.backend.grpc.settings.*
import com.scrapalot.backend.service.SettingsService
import com.scrapalot.backend.utils.grpcCall
import io.grpc.Status
import io.grpc.StatusRuntimeException
import mu.KotlinLogging
import net.devh.boot.grpc.server.service.GrpcService
import java.util.UUID
import com.scrapalot.backend.grpc.common.UUID as ProtoUUID

private val logger = KotlinLogging.logger {}

@Suppress("HasPlatformType") // gRPC grpcCall { } infers return type from proto builder — explicit types would be verbose
@GrpcService
class SettingsServiceImpl(
    private val settingsService: SettingsService,
    private val objectMapper: ObjectMapper,
) : SettingsServiceGrpcKt.SettingsServiceCoroutineImplBase() {
    // ── User Settings ────────────────────────────────────────────────────────

    override suspend fun getUserSetting(request: GetUserSettingRequest) =
        grpcCall {
            val userId = request.userId.uuid("user_id")
            val key = request.key.requireNotBlank("Setting key")
            settingsService
                .getUserSetting(userId, key)
                ?.toResponse()
                ?.also { logger.debug { "Retrieved user setting: $key for user: $userId" } }
                ?: throw StatusRuntimeException(Status.NOT_FOUND.withDescription("User setting not found: $key"))
        }

    override suspend fun getAllUserSettings(request: ProtoUUID) =
        grpcCall {
            val userId = request.uuid("user_id")
            val settings = settingsService.getAllUserSettings(userId)
            logger.debug { "Retrieved ${settings.size} user settings for user: $userId" }
            UserSettingListResponse.newBuilder().addAllSettings(settings.map { it.toResponse() }).build()
        }

    override suspend fun setUserSetting(request: SetUserSettingRequest) =
        grpcCall {
            val userId = request.userId.uuid("user_id")
            val key = request.key.requireNotBlank("Setting key")
            settingsService
                .setUserSetting(userId, key, request.value.parseJsonMap())
                .toResponse()
                .also { logger.info { "Set user setting: $key for user: $userId" } }
        }

    override suspend fun setUserSettings(request: SetUserSettingsRequest) =
        grpcCall {
            val userId = request.userId.uuid("user_id")
            request.settingsMap.forEach { (key, json) -> settingsService.setUserSetting(userId, key, json.parseJsonMap()) }
            logger.info { "Set ${request.settingsMap.size} user settings for user: $userId" }
            statusOk("Settings updated successfully")
        }

    override suspend fun deleteUserSetting(request: DeleteUserSettingRequest) =
        grpcCall {
            val userId = request.userId.uuid("user_id")
            val key = request.key.requireNotBlank("Setting key")
            settingsService.deleteUserSetting(userId, key)
            logger.info { "Deleted user setting: $key for user: $userId" }
            statusOk("Setting deleted successfully")
        }

    // ── Server Settings ──────────────────────────────────────────────────────

    override suspend fun getServerSetting(request: GetServerSettingRequest) =
        grpcCall {
            val key = request.key.requireNotBlank("Setting key")
            settingsService
                .getServerSetting(key)
                ?.toServerResponse()
                ?.also { logger.debug { "Retrieved server setting: $key" } }
                ?: throw StatusRuntimeException(Status.NOT_FOUND.withDescription("Server setting not found: $key"))
        }

    override suspend fun getAllServerSettings(request: Empty) =
        grpcCall {
            val settings = settingsService.getAllServerSettings()
            logger.debug { "Retrieved ${settings.size} server settings" }
            ServerSettingListResponse.newBuilder().addAllSettings(settings.map { it.toServerResponse() }).build()
        }

    override suspend fun setServerSetting(request: SetServerSettingRequest) =
        grpcCall {
            val key = request.key.requireNotBlank("Setting key")
            settingsService
                .setServerSetting(key, request.value.parseJsonMap())
                .toServerResponse()
                .also { logger.info { "Set server setting: $key" } }
        }

    override suspend fun deleteServerSetting(request: DeleteServerSettingRequest) =
        grpcCall {
            val key = request.key.requireNotBlank("Setting key")
            settingsService.deleteServerSetting(key)
            logger.info { "Deleted server setting: $key" }
            statusOk("Server setting deleted successfully")
        }

    // ── Specialized getters ──────────────────────────────────────────────────

    override suspend fun getSelectedWorkspace(request: ProtoUUID) =
        grpcCall {
            val userId = request.uuid("user_id")
            val workspaceId = settingsService.getSelectedWorkspace(userId)
            logger.debug { "Retrieved selected workspace for user: $userId -> $workspaceId" }
            SelectedWorkspaceResponse
                .newBuilder()
                .apply {
                    workspaceId?.let { setWorkspaceId(ProtoUUID.newBuilder().setValue(it.toString()).build()) }
                }.build()
        }

    override suspend fun getDocumentProcessingSettings(request: ProtoUUID) =
        grpcCall {
            val userId = request.uuid("user_id")
            val settings = settingsService.getDocumentProcessingSettings(userId)
            logger.debug { "Retrieved document processing settings for user: $userId" }
            DocumentProcessingSettingsResponse
                .newBuilder()
                .apply {
                    settings?.let { s ->
                        (s["chunking_strategy"] as? String)?.let { setChunkingStrategy(it) }
                        (s["embedding_model"] as? String)?.let { setEmbeddingModel(it) }
                        (s["chunk_size"] as? Number)?.let { setChunkSize(it.toInt()) }
                        (s["chunk_overlap"] as? Number)?.let { setChunkOverlap(it.toInt()) }
                        s
                            .filterKeys { it !in listOf("chunking_strategy", "embedding_model", "chunk_size", "chunk_overlap") }
                            .takeIf { it.isNotEmpty() }
                            ?.let { setAdditionalSettings(objectMapper.writeValueAsString(it)) }
                    }
                }.build()
        }

    override suspend fun getRAGSettings(request: ProtoUUID) =
        grpcCall {
            val userId = request.uuid("user_id")
            val settings = settingsService.getGeneralSettings(userId)
            logger.debug { "Retrieved RAG settings for user: $userId" }
            RAGSettingsResponse
                .newBuilder()
                .apply {
                    settings?.let { s ->
                        (s["rag_strategy"] as? String)?.let { setRagStrategy(it) }
                        (s["rag_orchestrator"] as? String)?.let { setRagOrchestrator(it) }
                        (s["use_agentic_routing"] as? Boolean)?.let { setUseAgenticRouting(it) }
                        (s["top_k"] as? Number)?.let { setTopK(it.toInt()) }
                        (s["similarity_threshold"] as? Number)?.let { setSimilarityThreshold(it.toDouble()) }
                        s
                            .filterKeys { it !in listOf("rag_strategy", "rag_orchestrator", "use_agentic_routing", "top_k", "similarity_threshold") }
                            .takeIf { it.isNotEmpty() }
                            ?.let { setAdditionalSettings(objectMapper.writeValueAsString(it)) }
                    }
                }.build()
        }

    // ── Helpers ──────────────────────────────────────────────────────────────

    @Suppress("SameParameterValue")
    private fun ProtoUUID.uuid(field: String): UUID =
        runCatching { UUID.fromString(value) }
            .getOrElse { throw StatusRuntimeException(Status.INVALID_ARGUMENT.withDescription("Invalid UUID for $field: $value")) }

    @Suppress("SameParameterValue")
    private fun String.requireNotBlank(field: String): String = takeIf { it.isNotBlank() } ?: throw StatusRuntimeException(Status.INVALID_ARGUMENT.withDescription("$field cannot be blank"))

    @Suppress("UNCHECKED_CAST")
    private fun String.parseJsonMap(): Map<String, Any>? =
        takeIf { it.isNotBlank() }?.let { json ->
            runCatching { objectMapper.readValue(json, Map::class.java) as Map<String, Any> }
                .getOrElse { e -> throw StatusRuntimeException(Status.INVALID_ARGUMENT.withDescription("Invalid JSON: ${e.message}")) }
        }

    private fun statusOk(message: String) =
        StatusResponse
            .newBuilder()
            .setSuccess(true)
            .setMessage(message)
            .build()

    private fun java.time.Instant.toTimestamp() =
        Timestamp
            .newBuilder()
            .setSeconds(epochSecond)
            .setNanos(nano)
            .build()

    private fun com.scrapalot.backend.domain.settings.UserSetting.toResponse(): UserSettingResponse =
        UserSettingResponse
            .newBuilder()
            .setUserId(ProtoUUID.newBuilder().setValue(userId.toString()).build())
            .setKey(settingKey)
            .setValue(settingValue?.let { objectMapper.writeValueAsString(it) } ?: "{}")
            .setCreatedAt(createdAt.toTimestamp())
            .setUpdatedAt(updatedAt.toTimestamp())
            .build()

    private fun com.scrapalot.backend.domain.settings.ServerSetting.toServerResponse(): ServerSettingResponse =
        ServerSettingResponse
            .newBuilder()
            .setKey(settingKey)
            .setValue(settingValue?.let { objectMapper.writeValueAsString(it) } ?: "{}")
            .setIsPublic(false)
            .setCreatedAt(createdAt.toTimestamp())
            .setUpdatedAt(updatedAt.toTimestamp())
            .build()
}
