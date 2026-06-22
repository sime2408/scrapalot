package com.scrapalot.backend.service

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.persistence.EntityManager
import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.annotation.Transactional
import org.springframework.transaction.support.TransactionTemplate
import java.util.UUID

private val logger = KotlinLogging.logger {}

// ── JsonNode convenience extensions ──────────────────────────────────────────

private fun JsonNode.str(key: String): String? = get(key)?.asText()?.takeIf { it != "null" }

private fun JsonNode.bool(
    key: String,
    default: Boolean = false
): Boolean = get(key)?.asBoolean() ?: default

private fun JsonNode.int(key: String): Int? = get(key)?.asInt()

private fun JsonNode.float(key: String): Float? = get(key)?.floatValue()

private fun JsonNode.uuid(key: String): UUID? = str(key)?.let { UUID.fromString(it) }

@Service
class ModelProviderSyncService(
    @param:Qualifier("streamStringRedisTemplate")
    private val pythonRedisTemplate: StringRedisTemplate,
    private val objectMapper: ObjectMapper,
    private val entityManager: EntityManager,
    transactionManager: PlatformTransactionManager,
) {
    private val txTemplate = TransactionTemplate(transactionManager)

    companion object {
        const val SNAPSHOT_KEY = "scrapalot:sync:model_providers_snapshot"
    }

    @EventListener(ApplicationReadyEvent::class)
    fun onStartup() =
        runCatching {
            txTemplate.executeWithoutResult { reconcileFromSnapshot() }
        }.onFailure { logger.error(it) { "Model provider snapshot reconciliation failed on startup" } }

    fun reconcileFromSnapshot() {
        val snapshot = readSnapshot() ?: return

        val activeIds =
            snapshot
                .mapNotNull { entry ->
                    val provider = entry.get("provider") ?: return@mapNotNull null
                    val id = provider.str("id") ?: return@mapNotNull null
                    upsertProvider(provider)
                    entry.get("models")?.takeIf { it.isArray }?.let { models ->
                        deleteModelsForProvider(id)
                        models.forEach { insertModel(it) }
                    }
                    id
                }.toSet()

        if (activeIds.isNotEmpty()) deleteStaleProviders(activeIds)
        logger.info("Reconciled {} model providers from snapshot", activeIds.size)
    }

    @Transactional
    fun handleProviderCreatedOrUpdated(payload: JsonNode) = upsertProvider(payload)

    @Transactional
    fun handleProviderDeleted(providerId: String) {
        deleteModelsForProvider(providerId)
        nativeUpdate("DELETE FROM scrapalot.model_providers WHERE id = :id", "id" to UUID.fromString(providerId))
        logger.debug("Deleted provider: {}", providerId)
    }

    @Transactional
    fun handleModelsSynced(providerId: String) {
        readSnapshot()
            ?.firstOrNull { it.get("provider")?.str("id") == providerId }
            ?.let { entry ->
                deleteModelsForProvider(providerId)
                entry.get("models")?.takeIf { it.isArray }?.forEach { insertModel(it) }
                logger.debug("Synced models for provider: {}", providerId)
            }
    }

    // ── Snapshot I/O ─────────────────────────────────────────────────────────

    private fun readSnapshot(): JsonNode? =
        pythonRedisTemplate
            .opsForValue()
            .get(SNAPSHOT_KEY)
            ?.takeIf { it.isNotBlank() }
            ?.let { objectMapper.readTree(it) }
            ?.takeIf { it.isArray }
            ?: run {
                logger.info("No valid model providers snapshot in Redis")
                null
            }

    // ── Upsert helpers ───────────────────────────────────────────────────────

    private fun upsertProvider(node: JsonNode) {
        val id = node.uuid("id") ?: return
        val name = node.str("name") ?: return

        val resolvedUserId =
            node.str("user_id")?.let { uid ->
                val uuid = UUID.fromString(uid)
                uuid.takeIf { userExists(it) }
                    ?: run {
                        logger.warn("Skipping user_id {} for provider {} — user not found", uid, name)
                        null
                    }
            }

        entityManager
            .createNativeQuery(
                """
                INSERT INTO scrapalot.model_providers (id, name, provider_type, status, api_base, show_models, description, user_id, created_at, updated_at)
                VALUES (:id, :name, :providerType, :status, :apiBase, :showModels, :description, :userId, NOW(), NOW())
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name, provider_type = EXCLUDED.provider_type, status = EXCLUDED.status,
                    api_base = EXCLUDED.api_base, show_models = EXCLUDED.show_models, description = EXCLUDED.description,
                    user_id = EXCLUDED.user_id, updated_at = NOW()
                """.trimIndent()
            ).apply {
                setParameter("id", id)
                setParameter("name", name)
                setParameter("providerType", node.str("provider_type") ?: "local")
                setParameter("status", node.str("status") ?: "active")
                setParameter("apiBase", node.str("api_base"))
                setParameter("showModels", node.bool("show_models", true))
                setParameter("description", node.str("description"))
                setParameter("userId", resolvedUserId)
            }.executeUpdate()

        logger.debug("Upserted provider: {} ({})", name, id)
    }

    private fun insertModel(node: JsonNode) {
        val id = node.uuid("id") ?: return
        val providerId = node.uuid("provider_id") ?: return
        val modelName = node.str("model_name") ?: return

        entityManager
            .createNativeQuery(
                """
                INSERT INTO scrapalot.model_provider_models
                    (id, provider_id, model_name, display_name, model_type, model_namespace,
                     context_window, max_tokens, dimensions, temperature_default,
                     input_cost, output_cost, supports_tools,
                     supports_streaming, supports_function_calling, supports_vision,
                     supports_image_generation, supports_audio_input,
                     supports_audio_output, supports_realtime,
                     created_at, updated_at)
                VALUES (:id, :providerId, :modelName, :displayName, :modelType, :modelNamespace,
                        :contextWindow, :maxTokens, :dimensions, :temperatureDefault,
                        :inputCost, :outputCost, :supportsTools, false, false, false,
                        :supportsImageGeneration, :supportsAudioInput,
                        :supportsAudioOutput, :supportsRealtime,
                        NOW(), NOW())
                ON CONFLICT (id) DO UPDATE SET
                    model_name = EXCLUDED.model_name, display_name = EXCLUDED.display_name,
                    model_type = EXCLUDED.model_type, model_namespace = EXCLUDED.model_namespace,
                    context_window = EXCLUDED.context_window, max_tokens = EXCLUDED.max_tokens,
                    dimensions = EXCLUDED.dimensions, temperature_default = EXCLUDED.temperature_default,
                    input_cost = EXCLUDED.input_cost, output_cost = EXCLUDED.output_cost,
                    supports_tools = EXCLUDED.supports_tools,
                    supports_image_generation = EXCLUDED.supports_image_generation,
                    supports_audio_input = EXCLUDED.supports_audio_input,
                    supports_audio_output = EXCLUDED.supports_audio_output,
                    supports_realtime = EXCLUDED.supports_realtime,
                    updated_at = NOW()
                """.trimIndent()
            ).apply {
                setParameter("id", id)
                setParameter("providerId", providerId)
                setParameter("modelName", modelName)
                setParameter("displayName", node.str("display_name"))
                setParameter("modelType", node.str("model_type") ?: "NORMAL")
                setParameter("modelNamespace", node.str("model_namespace"))
                setParameter("contextWindow", node.int("context_window"))
                setParameter("maxTokens", node.int("max_tokens"))
                setParameter("dimensions", node.int("dimensions"))
                setParameter("temperatureDefault", node.float("temperature_default"))
                setParameter("inputCost", node.float("input_cost"))
                setParameter("outputCost", node.float("output_cost"))
                setParameter("supportsTools", node.bool("supports_tools"))
                setParameter("supportsImageGeneration", node.bool("supports_image_generation"))
                setParameter("supportsAudioInput", node.bool("supports_audio_input"))
                setParameter("supportsAudioOutput", node.bool("supports_audio_output"))
                setParameter("supportsRealtime", node.bool("supports_realtime"))
            }.executeUpdate()
    }

    // ── Delete helpers ───────────────────────────────────────────────────────

    private fun deleteModelsForProvider(providerId: String) = nativeUpdate("DELETE FROM scrapalot.model_provider_models WHERE provider_id = :id", "id" to UUID.fromString(providerId))

    private fun deleteStaleProviders(activeIds: Set<String>) {
        val uuids = activeIds.map { UUID.fromString(it) }
        nativeUpdate("DELETE FROM scrapalot.model_provider_models WHERE provider_id NOT IN (:ids)", "ids" to uuids)
        nativeUpdate("DELETE FROM scrapalot.model_providers WHERE id NOT IN (:ids)", "ids" to uuids)
    }

    private fun nativeUpdate(
        sql: String,
        vararg params: Pair<String, Any?>
    ) = entityManager.createNativeQuery(sql).apply { params.forEach { (k, v) -> setParameter(k, v) } }.executeUpdate()

    private fun userExists(userId: UUID): Boolean =
        (
            entityManager
                .createNativeQuery("SELECT COUNT(*) FROM scrapalot.users WHERE id = :id")
                .setParameter("id", userId)
                .singleResult as Number
        ).toLong() > 0
}
