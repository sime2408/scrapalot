package com.scrapalot.backend.service

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.dto.AiGenerateResponse
import mu.KotlinLogging
import org.springframework.ai.chat.model.ChatModel
import org.springframework.ai.chat.prompt.Prompt
import org.springframework.ai.openai.OpenAiChatModel
import org.springframework.ai.openai.OpenAiChatOptions
import org.springframework.ai.openai.api.OpenAiApi
import org.springframework.stereotype.Service
import java.math.BigDecimal
import java.sql.DriverManager
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

private val logger = KotlinLogging.logger {}

/**
 * Spring AI-powered generation service for lightweight AI tasks.
 *
 * Creates OpenAiChatModel instances programmatically from system provider API keys
 * stored in model_providers (replicated from Python). This avoids gRPC round-trips
 * to scrapalot-chat for simple tasks like generating descriptions or suggestions.
 *
 * Use this for: generate description, suggest improvements, ask AI, summarize, translate.
 * Do NOT use for: RAG, deep research, entity extraction — those stay on Python via gRPC.
 */
@Service
class AiGenerationService(
    private val modelProviderService: ModelProviderService,
    private val tokenUsageService: TokenUsageService,
    private val objectMapper: ObjectMapper
) {
    private val chatModelCache = ConcurrentHashMap<String, CachedChatModel>()

    companion object {
        // The system provider key is intentionally NOT replicated over Redis, so
        // we read the live system_agent_config straight from the Python DB — the
        // same cross-DB pattern LlmInferenceController already uses.
        private const val PYTHON_DB_URL = "jdbc:postgresql://pgvector:5432/scrapalot"
        private const val PYTHON_DB_USER = "scrapalot"
        private const val PYTHON_DB_PASSWORD = "scrapalot"
    }

    private data class CachedChatModel(
        val chatModel: ChatModel,
        val apiKey: String,
        val modelName: String
    )

    /**
     * Generate a non-streaming AI response.
     */
    fun generate(
        prompt: String,
        systemPrompt: String?,
        userId: UUID,
        modelName: String? = null,
        temperature: Double? = null,
        maxTokens: Int? = null
    ): AiGenerateResponse {
        val (chatModel, aiPrompt, effectiveModel) = buildPromptContext(userId, prompt, systemPrompt, modelName, temperature, maxTokens)
        logger.info { "AI generation for user $userId, model: $effectiveModel, prompt length: ${prompt.length}" }

        val response = chatModel.call(aiPrompt)

        val result = response.result
        val content = result.output.text ?: ""
        val usage = response.metadata?.usage

        val inputTokens = usage?.promptTokens?.toLong() ?: 0L
        val outputTokens = usage?.completionTokens?.toLong() ?: 0L

        trackTokenUsage(userId, inputTokens, outputTokens)

        return AiGenerateResponse(
            content = content,
            model = effectiveModel,
            inputTokens = inputTokens,
            outputTokens = outputTokens,
            totalTokens = inputTokens + outputTokens
        )
    }

    /**
     * Generate a streaming AI response, yielding chunks as they arrive.
     */
    fun generateStream(
        prompt: String,
        systemPrompt: String?,
        userId: UUID,
        modelName: String? = null,
        temperature: Double? = null,
        maxTokens: Int? = null
    ): StreamContext {
        val (chatModel, aiPrompt, effectiveModel) = buildPromptContext(userId, prompt, systemPrompt, modelName, temperature, maxTokens)
        logger.info { "AI stream generation for user $userId, model: $effectiveModel" }
        return StreamContext(chatModel.stream(aiPrompt), userId, effectiveModel)
    }

    data class StreamContext(
        val flux: reactor.core.publisher.Flux<org.springframework.ai.chat.model.ChatResponse>,
        val userId: UUID,
        val model: String
    )

    /**
     * Track token usage after streaming completes (called by controller).
     */
    fun trackTokenUsage(
        userId: UUID,
        inputTokens: Long,
        outputTokens: Long
    ) {
        if (inputTokens <= 0 && outputTokens <= 0) return
        val estimatedCost = estimateCost(inputTokens, outputTokens)
        tokenUsageService.incrementUsage(userId, inputTokens, outputTokens, estimatedCost)
    }

    /**
     * Evict cached ChatModel when the provider changes (called from RedisStreamConsumer).
     */
    fun evictChatModelCache() {
        chatModelCache.clear()
        logger.info { "AI generation ChatModel cache evicted" }
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private data class PromptContext(
        val chatModel: ChatModel,
        val prompt: Prompt,
        val model: String
    )

    private fun buildPromptContext(
        userId: UUID,
        prompt: String,
        systemPrompt: String?,
        modelName: String?,
        temperature: Double?,
        maxTokens: Int?,
    ): PromptContext {
        val resolved = resolveSystemProvider(userId)
        val effectiveModel = modelName ?: resolved.modelName
        val chatModel = getOrCreateChatModel(resolved.apiKey, resolved.apiBase, effectiveModel)
        val options =
            OpenAiChatOptions
                .builder()
                .model(effectiveModel)
                .apply {
                    temperature?.let { temperature(it) }
                    maxTokens?.let { maxTokens(it) }
                }.build()
        return PromptContext(chatModel, Prompt(buildMessages(prompt, systemPrompt), options), effectiveModel)
    }

    private data class ResolvedProvider(
        val apiKey: String,
        val apiBase: String?,
        val modelName: String
    )

    private fun resolveSystemProvider(userId: UUID): ResolvedProvider {
        // Single source of truth: server_settings.system_agent_config (provider,
        // model, key, base). Switching it from the admin UI flips both the Python
        // agents and this Spring AI path at once.
        resolveSystemConfigFromDb()?.let { return it }

        // Fallback: legacy model_providers replica (used only if the config row is
        // missing or unreadable). Note: this path cannot know a freshly-set key
        // that never landed in the replica.
        val resolved =
            modelProviderService.resolveModelForRequest(
                userId = userId,
                providerType = "system",
                modelId = null,
                // Resolve the system model from the provider card, never a hardcoded name.
                modelName = modelProviderService.getSystemProviderModelName()
            ) ?: throw IllegalStateException("No system AI provider configured. Set up a model provider in admin settings.")

        val apiKey = requireNotNull(resolved.apiKey) { "System provider has no API key configured" }
        return ResolvedProvider(apiKey, resolved.apiBase, resolved.modelName)
    }

    private fun resolveSystemConfigFromDb(): ResolvedProvider? =
        runCatching {
            DriverManager.getConnection(PYTHON_DB_URL, PYTHON_DB_USER, PYTHON_DB_PASSWORD).use { conn ->
                conn
                    .prepareStatement(
                        "SELECT setting_value FROM server_settings WHERE setting_key = 'system_agent_config'"
                    ).use { stmt ->
                        stmt.executeQuery().use { rs ->
                            if (!rs.next()) return@runCatching null
                            val json =
                                rs.getString("setting_value")?.takeIf { it.isNotBlank() }
                                    ?: return@runCatching null
                            val node = objectMapper.readTree(json)
                            val providerType =
                                node.get("provider_type")?.asText()?.takeIf { it.isNotBlank() }
                                    ?: return@runCatching null
                            val modelName =
                                node.get("model_name")?.asText()?.takeIf { it.isNotBlank() }
                                    ?: return@runCatching null
                            val apiKey =
                                node.get("api_key")?.asText()?.takeIf { it.isNotBlank() }
                                    ?: return@runCatching null
                            val apiBase =
                                node.get("api_base")?.asText()?.takeIf { it.isNotBlank() }
                                    ?: defaultApiBaseFor(providerType)
                            ResolvedProvider(apiKey, apiBase, modelName)
                        }
                    }
            }
        }.getOrNull()

    private fun defaultApiBaseFor(providerType: String): String? =
        when (providerType.lowercase()) {
            "deepseek" -> "https://api.deepseek.com"
            else -> null // OpenAI and others fall back to Spring AI's built-in default base
        }

    private fun getOrCreateChatModel(
        apiKey: String,
        apiBase: String?,
        modelName: String
    ): ChatModel {
        val cacheKey = "$apiKey:$modelName"
        val cached = chatModelCache[cacheKey]
        if (cached != null && cached.apiKey == apiKey) {
            return cached.chatModel
        }

        val apiBuilder = OpenAiApi.builder().apiKey(apiKey)
        if (!apiBase.isNullOrBlank()) {
            apiBuilder.baseUrl(apiBase)
        }
        val openAiApi = apiBuilder.build()

        val chatModel =
            OpenAiChatModel
                .builder()
                .openAiApi(openAiApi)
                .defaultOptions(
                    OpenAiChatOptions
                        .builder()
                        .model(modelName)
                        .temperature(0.7)
                        .build()
                ).build()

        chatModelCache[cacheKey] = CachedChatModel(chatModel, apiKey, modelName)
        logger.info { "Created new ChatModel: model=$modelName, hasCustomBase=${!apiBase.isNullOrBlank()}" }
        return chatModel
    }

    private fun buildMessages(
        prompt: String,
        systemPrompt: String?
    ): List<org.springframework.ai.chat.messages.Message> {
        val messages = mutableListOf<org.springframework.ai.chat.messages.Message>()
        if (!systemPrompt.isNullOrBlank()) {
            messages.add(
                org.springframework.ai.chat.messages
                    .SystemMessage(systemPrompt)
            )
        }
        messages.add(
            org.springframework.ai.chat.messages
                .UserMessage(prompt)
        )
        return messages
    }

    private fun estimateCost(
        inputTokens: Long,
        outputTokens: Long
    ): BigDecimal {
        // gpt-4o-mini pricing: $0.15/1M input, $0.60/1M output
        val inputCost = BigDecimal.valueOf(inputTokens).multiply(BigDecimal("0.00000015"))
        val outputCost = BigDecimal.valueOf(outputTokens).multiply(BigDecimal("0.00000060"))
        return inputCost.add(outputCost)
    }
}
