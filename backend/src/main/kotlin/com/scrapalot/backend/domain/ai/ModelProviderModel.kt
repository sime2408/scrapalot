package com.scrapalot.backend.domain.ai

import jakarta.persistence.*
import java.time.LocalDateTime
import java.util.UUID

@Entity
@Table(
    name = "model_provider_models",
    schema = "scrapalot",
    indexes = [
        Index(name = "idx_model_provider_models_model_name", columnList = "model_name"),
        Index(name = "idx_model_provider_models_provider_id", columnList = "provider_id")
    ]
)
data class ModelProviderModel(
    @Id
    @Column(name = "id", nullable = false)
    var id: UUID = UUID.randomUUID(),
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: LocalDateTime = LocalDateTime.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: LocalDateTime = LocalDateTime.now(),
    @Column(name = "provider_id", nullable = false)
    var providerId: UUID,
    @Column(name = "model_name", length = 100, nullable = false)
    var modelName: String,
    @Column(name = "display_name", length = 100, nullable = true)
    var displayName: String? = null,
    @Column(name = "model_type", length = 50, nullable = false)
    var modelType: String,
    @Column(name = "model_namespace", length = 100, nullable = true)
    var modelNamespace: String? = null,
    @Column(name = "context_window", nullable = true)
    var contextWindow: Int? = null,
    @Column(name = "max_tokens", nullable = true)
    var maxTokens: Int? = null,
    @Column(name = "dimensions", nullable = true)
    var dimensions: Int? = null,
    @Column(name = "temperature_default", nullable = true)
    var temperatureDefault: Float? = null,
    @Column(name = "min_gpu_memory_mb", nullable = true)
    var minGpuMemoryMb: Int? = null,
    @Column(name = "min_cpu_memory_mb", nullable = true)
    var minCpuMemoryMb: Int? = null,
    @Column(name = "min_disk_space_mb", nullable = true)
    var minDiskSpaceMb: Int? = null,
    @Column(name = "input_cost", nullable = true)
    var inputCost: Float? = null,
    @Column(name = "output_cost", nullable = true)
    var outputCost: Float? = null,
    @Column(name = "supports_tools", nullable = false)
    var supportsTools: Boolean = false,
    @Column(name = "supports_streaming", nullable = false)
    var supportsStreaming: Boolean = false,
    @Column(name = "supports_function_calling", nullable = false)
    var supportsFunctionCalling: Boolean = false,
    @Column(name = "supports_vision", nullable = false)
    var supportsVision: Boolean = false,
    @Column(name = "supports_image_generation", nullable = false)
    var supportsImageGeneration: Boolean = false,
    @Column(name = "supports_audio_input", nullable = false)
    var supportsAudioInput: Boolean = false,
    @Column(name = "supports_audio_output", nullable = false)
    var supportsAudioOutput: Boolean = false,
    @Column(name = "supports_realtime", nullable = false)
    var supportsRealtime: Boolean = false,
    // Relationships
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "provider_id", insertable = false, updatable = false)
    var provider: ModelProvider? = null
) {
    @PreUpdate
    fun preUpdate() {
        updatedAt = LocalDateTime.now()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ModelProviderModel) return false
        return id == other.id
    }

    override fun hashCode(): Int = id.hashCode()

    override fun toString(): String = "ModelProviderModel(id=$id, modelName=$modelName, modelType=$modelType, providerId=$providerId)"
}
