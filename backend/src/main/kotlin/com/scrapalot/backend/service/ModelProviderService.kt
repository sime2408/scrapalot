package com.scrapalot.backend.service

import com.scrapalot.backend.domain.ai.ModelProvider
import com.scrapalot.backend.domain.ai.ModelProviderModel
import com.scrapalot.backend.dto.ResolvedModel
import com.scrapalot.backend.repository.ModelProviderModelRepository
import com.scrapalot.backend.repository.ModelProviderRepository
import mu.KotlinLogging
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.UUID

private val logger = KotlinLogging.logger {}

@Service
@Transactional(readOnly = true)
class ModelProviderService(
    private val providerRepository: ModelProviderRepository,
    private val modelRepository: ModelProviderModelRepository
) {
    companion object {
        private val LOCAL_PROVIDER_TYPES = setOf("local", "lmstudio", "ollama", "vllm")
    }

    fun getActiveProviders(userId: UUID): List<ModelProvider> {
        val providers = providerRepository.findActiveForUser(userId, "active")
        logger.info { "Found ${providers.size} active providers for user $userId" }
        return providers
    }

    fun getSpecificProviderAndModel(
        userId: UUID,
        providerType: String,
        modelId: String
    ): ResolvedModel? {
        val provider = findProviderByType(userId, providerType)

        if (provider != null) {
            val model = findModel(provider, modelId)
            if (model != null) return toResolvedModel(provider, model)
        } else {
            logger.warn { "No active provider found for user $userId with type $providerType, trying fallback" }
        }

        // Fallback: try to find the model in any accessible provider
        val fallbackModel = tryFallbackModelLookup(userId, modelId)
        if (fallbackModel != null) return fallbackModel

        logger.error { "Requested provider $providerType with model $modelId not found for user $userId" }
        return null
    }

    fun resolveModelForRequest(
        userId: UUID,
        providerType: String?,
        modelId: String?,
        modelName: String?
    ): ResolvedModel? {
        // Priority 1: Direct lookup with both modelId and providerType
        if (!modelId.isNullOrBlank() && !providerType.isNullOrBlank()) {
            val resolved = getSpecificProviderAndModel(userId, providerType, modelId)
            if (resolved != null) {
                return resolved
            }
            logger.error { "Requested provider $providerType with model $modelId not found for user $userId" }
            return null
        }

        // Priority 2: Get all active providers and find by providerType
        val activeProviders = getActiveProviders(userId)
        if (activeProviders.isEmpty()) {
            logger.error { "No active providers found for user $userId" }
            return null
        }

        val selectedProvider =
            if (!providerType.isNullOrBlank()) {
                if (providerType.lowercase() == "system") {
                    // For "system" type, prefer actual "system" type providers; fall back to OpenAI or any other
                    selectSystemProvider(activeProviders.filter { it.userId == null })
                } else {
                    activeProviders.firstOrNull { it.providerType == providerType }
                }
            } else {
                activeProviders.first()
            }

        if (selectedProvider == null) {
            logger.error { "Provider $providerType not found among active providers for user $userId" }
            return null
        }

        // For local/system providers, require explicit model selection
        val isSystemProvider = selectedProvider.userId == null
        val effectiveModelName =
            modelName ?: if (
                selectedProvider.providerType in LOCAL_PROVIDER_TYPES || isSystemProvider
            ) {
                logger.error { "No model specified for ${selectedProvider.providerType} provider" }
                return null
            } else {
                // For remote providers, use model from request or first available
                val models = modelRepository.findByProviderId(selectedProvider.id)
                models.firstOrNull()?.modelName ?: run {
                    logger.error { "No models available for provider ${selectedProvider.id}" }
                    return null
                }
            }

        logger.info { "Using model: $effectiveModelName (Provider: ${selectedProvider.providerType}, ID: ${selectedProvider.id})" }

        return ResolvedModel(
            providerId = selectedProvider.id,
            providerName = selectedProvider.name,
            providerType = if (isSystemProvider) "system" else selectedProvider.providerType,
            modelName = effectiveModelName,
            modelId = null,
            apiKey = selectedProvider.apiKey,
            apiBase = selectedProvider.apiBase,
            isSystemProvider = isSystemProvider
        )
    }

    /**
     * The model configured for the system ("Scrapalot AI") provider, read from
     * the synced provider card. Single source of truth — callers must NOT
     * hardcode a system model name (e.g. "gpt-4o-mini"); switching the system
     * provider/model from the admin UI is the only thing that should change it.
     * Returns null when no system provider/model is configured.
     */
    fun getSystemProviderModelName(): String? {
        val provider = selectSystemProvider(providerRepository.findByUserIdIsNullAndStatus("active")) ?: return null
        return modelRepository.findByProviderId(provider.id).firstOrNull()?.modelName
    }

    private fun selectSystemProvider(candidates: List<ModelProvider>): ModelProvider? {
        val systemTypeProvider = candidates.firstOrNull { it.providerType == "system" }
        if (systemTypeProvider != null) {
            logger.info { "Using system provider: ${systemTypeProvider.name}" }
            return systemTypeProvider
        }
        val openAiProvider = candidates.firstOrNull { it.providerType == "openai" }
        if (openAiProvider != null) {
            logger.info { "No system-type provider found, using OpenAI as system provider: ${openAiProvider.name}" }
            return openAiProvider
        }
        logger.warn { "No system or OpenAI provider found, using first available system provider" }
        return candidates.firstOrNull()
    }

    private fun findProviderByType(
        userId: UUID,
        providerType: String
    ): ModelProvider? =
        when {
            providerType.lowercase() == "system" -> {
                // Prefer actual "system" type providers; fall back to OpenAI or any other system provider
                selectSystemProvider(providerRepository.findByUserIdIsNullAndStatus("active"))
            }

            providerType.lowercase() in LOCAL_PROVIDER_TYPES ->
                providerRepository.findByProviderTypeAndStatusActive(providerType).firstOrNull()

            else ->
                // Check user-specific provider first, then fall back to system provider
                providerRepository.findByProviderTypeAndStatusAndUserId(providerType, "active", userId)
                    ?: providerRepository.findByProviderTypeAndStatusAndUserIdIsNull(providerType, "active")
        }

    private fun findModel(
        provider: ModelProvider,
        modelId: String
    ): ModelProviderModel? {
        // Try as UUID first
        try {
            val uuid = UUID.fromString(modelId)
            val model = modelRepository.findById(uuid).orElse(null)
            if (model != null && model.providerId == provider.id) return model
        } catch (_: IllegalArgumentException) {
            // Not a UUID, try as model name
        }

        return modelRepository.findByProviderIdAndModelName(provider.id, modelId)
    }

    private fun tryFallbackModelLookup(
        userId: UUID,
        modelId: String
    ): ResolvedModel? {
        try {
            val uuid = UUID.fromString(modelId)
            val model = modelRepository.findAccessibleModelById(uuid, userId) ?: return null
            val provider = providerRepository.findById(model.providerId).orElse(null) ?: return null

            logger.info { "Found model $modelId in different provider: ${provider.name} (type: ${provider.providerType})" }
            return toResolvedModel(provider, model)
        } catch (_: IllegalArgumentException) {
            return null
        }
    }

    private fun toResolvedModel(
        provider: ModelProvider,
        model: ModelProviderModel
    ): ResolvedModel =
        ResolvedModel(
            providerId = provider.id,
            providerName = provider.name,
            providerType = provider.providerType,
            modelName = model.modelName,
            modelId = model.id,
            apiKey = provider.apiKey,
            apiBase = provider.apiBase,
            isSystemProvider = provider.userId == null
        )
}
