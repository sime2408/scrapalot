package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.common.Empty
import com.scrapalot.backend.grpc.common.StatusResponse
import com.scrapalot.backend.grpc.llm.*
import kotlinx.coroutines.flow.Flow
import mu.KotlinLogging
import org.springframework.stereotype.Service

private val logger = KotlinLogging.logger {}

/**
 * gRPC client for Python LlmInferenceService.
 *
 * LLM model management, GPU operations, provider sync, and download progress.
 */
@Service
class LlmInferenceGrpcClient(
    private val stub: LlmInferenceServiceGrpcKt.LlmInferenceServiceCoroutineStub
) {
    suspend fun listDatabaseModels(request: ListDatabaseModelsRequest): ListDatabaseModelsResponse {
        logger.info { "gRPC ListDatabaseModels: provider_id=${request.providerId}" }
        return stub.listDatabaseModels(request)
    }

    suspend fun listProviderModels(request: ListProviderModelsRequest): GroupedProviderModelsResponse {
        logger.info { "gRPC ListProviderModels: providers=${request.providersList}" }
        return stub.listProviderModels(request)
    }

    suspend fun listEmbeddingModels(): EmbeddingModelsResponse {
        logger.info { "gRPC ListEmbeddingModels" }
        return stub.listEmbeddingModels(Empty.getDefaultInstance())
    }

    suspend fun getFeaturedModels(
        search: String? = null,
        minParameters: Int? = null,
        maxParameters: Int? = null,
    ): FeaturedModelsResponse {
        logger.info { "gRPC GetFeaturedModels: search=$search min=$minParameters max=$maxParameters" }
        val request =
            FeaturedModelsRequest
                .newBuilder()
                .apply {
                    search?.let { this.search = it }
                    minParameters?.let { this.minParameters = it }
                    maxParameters?.let { this.maxParameters = it }
                }.build()
        return stub.getFeaturedModels(request)
    }

    suspend fun getInstalledModels(): InstalledModelsResponse {
        logger.info { "gRPC GetInstalledModels" }
        return stub.getInstalledModels(Empty.getDefaultInstance())
    }

    suspend fun getStatus(): LlmStatusResponse {
        logger.info { "gRPC GetStatus" }
        return stub.getStatus(Empty.getDefaultInstance())
    }

    suspend fun getSystemCapabilities(): SystemCapabilitiesResponse {
        logger.info { "gRPC GetSystemCapabilities" }
        return stub.getSystemCapabilities(Empty.getDefaultInstance())
    }

    suspend fun getDeploymentStatus(): DeploymentStatusResponse {
        logger.info { "gRPC GetDeploymentStatus" }
        return stub.getDeploymentStatus(Empty.getDefaultInstance())
    }

    suspend fun getConfig(): LlmConfigResponse {
        logger.info { "gRPC GetConfig" }
        return stub.getConfig(Empty.getDefaultInstance())
    }

    suspend fun setConfig(request: LlmConfigRequest): StatusResponse {
        logger.info { "gRPC SetConfig" }
        return stub.setConfig(request)
    }

    suspend fun startService(): StatusResponse {
        logger.info { "gRPC StartService" }
        return stub.startService(Empty.getDefaultInstance())
    }

    suspend fun stopService(): StatusResponse {
        logger.info { "gRPC StopService" }
        return stub.stopService(Empty.getDefaultInstance())
    }

    suspend fun restartService(): StatusResponse {
        logger.info { "gRPC RestartService" }
        return stub.restartService(Empty.getDefaultInstance())
    }

    suspend fun reinitializeLocalModels(): StatusResponse {
        logger.info { "gRPC ReinitializeLocalModels" }
        return stub.reinitializeLocalModels(Empty.getDefaultInstance())
    }

    suspend fun downloadModel(request: DownloadModelRequest): StatusResponse {
        logger.info { "gRPC DownloadModel: model=${request.modelName}" }
        return stub.downloadModel(request)
    }

    suspend fun deleteModel(request: DeleteModelRequest): StatusResponse {
        logger.info { "gRPC DeleteModel: model=${request.modelName}" }
        return stub.deleteModel(request)
    }

    suspend fun undeployModel(request: UndeployModelRequest): StatusResponse {
        logger.info { "gRPC UndeployModel: model=${request.modelName}" }
        return stub.undeployModel(request)
    }

    suspend fun getLocalModelStatus(request: LocalModelStatusRequest): LocalModelStatusResponse {
        logger.info { "gRPC GetLocalModelStatus: model=${request.modelName}" }
        return stub.getLocalModelStatus(request)
    }

    suspend fun startModelGpu(request: StartGpuRequest): StatusResponse {
        logger.info { "gRPC StartModelGpu: model=${request.modelName}" }
        return stub.startModelGpu(request)
    }

    suspend fun stopModelGpu(request: StopGpuRequest): StatusResponse {
        logger.info { "gRPC StopModelGpu: model=${request.modelName}" }
        return stub.stopModelGpu(request)
    }

    suspend fun getGpuStatus(request: GpuStatusRequest): GpuStatusResponse {
        logger.info { "gRPC GetGpuStatus: model=${request.modelName}" }
        return stub.getGpuStatus(request)
    }

    suspend fun getOverallGpuStatus(): GpuStatusResponse {
        logger.info { "gRPC GetOverallGpuStatus" }
        return stub.getOverallGpuStatus(Empty.getDefaultInstance())
    }

    suspend fun refreshProviderModels(): StatusResponse {
        logger.info { "gRPC RefreshProviderModels" }
        return stub.refreshProviderModels(Empty.getDefaultInstance())
    }

    suspend fun fetchProviderModels(): StatusResponse {
        logger.info { "gRPC FetchProviderModels" }
        return stub.fetchProviderModels(Empty.getDefaultInstance())
    }

    fun getDownloadProgress(request: DownloadProgressRequest): Flow<DownloadProgressChunk> {
        logger.info { "gRPC GetDownloadProgress: model=${request.modelName}" }
        return stub.getDownloadProgress(request)
    }
}
