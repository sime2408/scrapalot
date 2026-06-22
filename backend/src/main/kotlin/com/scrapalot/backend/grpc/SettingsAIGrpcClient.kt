package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.common.Empty
import com.scrapalot.backend.grpc.common.StatusResponse
import com.scrapalot.backend.grpc.settings.*
import mu.KotlinLogging
import org.springframework.stereotype.Service

private val logger = KotlinLogging.logger {}

/**
 * gRPC client for Python SettingsAIService.
 *
 * Model provider management, embedding config, RAG strategies, and service status.
 */
@Service
class SettingsAIGrpcClient(
    private val stub: SettingsAIServiceGrpcKt.SettingsAIServiceCoroutineStub
) {
    suspend fun listProviders(request: ListProvidersRequest): ListProvidersResponse {
        logger.info { "gRPC ListProviders: user_id=${request.userId}" }
        return stub.listProviders(request)
    }

    suspend fun createProvider(request: CreateProviderRequest): ProviderResponse {
        logger.info { "gRPC CreateProvider: name=${request.name}" }
        return stub.createProvider(request)
    }

    suspend fun updateProvider(request: UpdateProviderRequest): ProviderResponse {
        logger.info { "gRPC UpdateProvider: id=${request.providerId}" }
        return stub.updateProvider(request)
    }

    suspend fun deleteProvider(request: DeleteProviderRequest): StatusResponse {
        logger.info { "gRPC DeleteProvider: id=${request.providerId}" }
        return stub.deleteProvider(request)
    }

    suspend fun listModels(request: ListModelsRequest): ListModelsResponse {
        logger.info { "gRPC ListModels" }
        return stub.listModels(request)
    }

    suspend fun setSelectedModel(request: SetSelectedModelRequest): SelectedModelResponse {
        logger.info { "gRPC SetSelectedModel: model=${request.modelName}" }
        return stub.setSelectedModel(request)
    }

    suspend fun getEmbeddingConfig(request: EmbeddingConfigRequest): EmbeddingConfigResponse {
        logger.info { "gRPC GetEmbeddingConfig: user_id=${request.userId}" }
        return stub.getEmbeddingConfig(request)
    }

    suspend fun setEmbeddingConfig(request: SetEmbeddingConfigRequest): StatusResponse {
        logger.info { "gRPC SetEmbeddingConfig: model=${request.embeddingModel}" }
        return stub.setEmbeddingConfig(request)
    }

    suspend fun listEmbeddingModels(): ListModelsResponse {
        logger.info { "gRPC ListEmbeddingModels" }
        return stub.listEmbeddingModels(Empty.getDefaultInstance())
    }

    suspend fun listRagStrategies(): RagStrategiesResponse {
        logger.info { "gRPC ListRagStrategies" }
        return stub.listRagStrategies(Empty.getDefaultInstance())
    }

    suspend fun getServiceStatus(): ServiceStatusResponse {
        logger.info { "gRPC GetServiceStatus" }
        return stub.getServiceStatus(Empty.getDefaultInstance())
    }

    suspend fun getServiceLogs(request: ServiceLogsRequest): ServiceLogsResponse {
        logger.info { "gRPC GetServiceLogs: lines=${request.lines}" }
        return stub.getServiceLogs(request)
    }

    @Suppress("unused") // future API — direct gRPC sync for user settings (normal path uses Redis Streams SAGA)
    suspend fun syncUserSetting(request: SyncUserSettingRequest): StatusResponse {
        logger.debug { "gRPC SyncUserSetting: key=${request.settingKey}, op=${request.operation}" }
        return stub.syncUserSetting(request)
    }

    suspend fun getSystemAgentConfig(): SystemAgentConfigResponse {
        logger.info { "gRPC GetSystemAgentConfig" }
        return stub.getSystemAgentConfig(Empty.getDefaultInstance())
    }

    suspend fun setSystemAgentConfig(request: SetSystemAgentConfigRequest): StatusResponse {
        logger.info { "gRPC SetSystemAgentConfig: provider=${request.providerType}, model=${request.modelName}" }
        return stub.setSystemAgentConfig(request)
    }

    suspend fun getSpeechConfig(): SpeechConfigResponse {
        logger.info { "gRPC GetSpeechConfig" }
        return stub.getSpeechConfig(Empty.getDefaultInstance())
    }

    suspend fun setSpeechConfig(request: SetSpeechConfigRequest): StatusResponse {
        logger.info { "gRPC SetSpeechConfig: stt=${request.sttProvider}, tts=${request.ttsProvider}" }
        return stub.setSpeechConfig(request)
    }

    suspend fun getAdminDefaultSystemPrompt(): AdminDefaultSystemPromptResponse {
        logger.info { "gRPC GetAdminDefaultSystemPrompt" }
        return stub.getAdminDefaultSystemPrompt(Empty.getDefaultInstance())
    }

    suspend fun setAdminDefaultSystemPrompt(request: SetAdminDefaultSystemPromptRequest): StatusResponse {
        logger.info { "gRPC SetAdminDefaultSystemPrompt: len=${request.prompt.length}" }
        return stub.setAdminDefaultSystemPrompt(request)
    }
}
