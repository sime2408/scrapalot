package com.scrapalot.backend.controller.ai

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.grpc.LlmInferenceGrpcClient
import com.scrapalot.backend.grpc.common.StatusResponse
import com.scrapalot.backend.grpc.llm.*
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.asJsonResponse
import com.scrapalot.backend.utils.isAdmin
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.reactive.asPublisher
import kotlinx.coroutines.runBlocking
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.web.bind.annotation.*
import reactor.core.publisher.Flux
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.sql.DriverManager
import java.time.Duration

@RestController
@RequestMapping("/api/v1/llm-inference")
class LlmInferenceController(
    private val llmInferenceGrpcClient: LlmInferenceGrpcClient,
    private val objectMapper: ObjectMapper,
    private val userService: UserService,
) {
    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Local-AI WRITE operations (model downloads, GPU deploys, service
     * restarts, config) mutate the SHARED inference host — admin-role only,
     * matching the UI, which already renders those controls just for admins.
     * Read endpoints (status, capabilities, model lists) stay open to any
     * authenticated user; provider-sync endpoints are per-user and untouched.
     */
    private fun requireAdmin() {
        val username =
            SecurityContextHolder.getContext().authentication?.name
                ?: throw SecurityException("Authentication required")
        val user =
            userService.findByEmailOrUsername(username)
                ?: throw SecurityException("Authentication required")
        if (!user.isAdmin()) {
            throw SecurityException("Local AI management requires admin role")
        }
    }

    private fun statusResult(
        success: Boolean,
        message: String
    ): ResponseEntity<Map<String, Any>> = ResponseEntity.ok(mapOf("success" to success, "message" to message))

    private fun StatusResponse.toResult() = statusResult(success, message)

    // ── Model listing ────────────────────────────────────────────────────────

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @GetMapping("/database-models")
    fun listDatabaseModels(
        @RequestParam(required = false) providerId: String?,
        @RequestParam(defaultValue = "1") page: Int,
        @RequestParam(defaultValue = "20") limit: Int,
    ): ResponseEntity<String> =
        runBlocking {
            llmInferenceGrpcClient
                .listDatabaseModels(
                    ListDatabaseModelsRequest
                        .newBuilder()
                        .setProviderId(providerId ?: "")
                        .setPage(page)
                        .setLimit(limit)
                        .build()
                ).modelsJson
                .asJsonResponse()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @GetMapping("/list-models")
    fun listProviderModels(
        @RequestParam(required = false) providers: List<String>?,
        @RequestParam(required = false) modelType: String?,
        @RequestParam(required = false) search: String?,
        @RequestParam(defaultValue = "1") page: Int,
        @RequestParam(defaultValue = "50") limit: Int,
        @RequestParam(defaultValue = "false") refresh: Boolean,
    ): ResponseEntity<String> =
        runBlocking {
            llmInferenceGrpcClient
                .listProviderModels(
                    ListProviderModelsRequest
                        .newBuilder()
                        .setModelType(modelType ?: "")
                        .setSearch(search ?: "")
                        .setPage(page)
                        .setLimit(limit)
                        .setRefresh(refresh)
                        .apply { providers?.forEach { addProviders(it) } }
                        .build()
                ).responseJson
                .asJsonResponse()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @GetMapping("/embedding-models")
    fun listEmbeddingModels(): ResponseEntity<String> =
        runBlocking {
            llmInferenceGrpcClient.listEmbeddingModels().modelsJson.asJsonResponse()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @GetMapping("/featured-models")
    fun getFeaturedModels(
        @RequestParam(required = false) search: String?,
        @RequestParam(name = "min_parameters", required = false) minParameters: Int?,
        @RequestParam(name = "max_parameters", required = false) maxParameters: Int?,
    ): ResponseEntity<String> =
        runBlocking {
            // The frontend has always sent these filters; they were silently
            // dropped here, so HuggingFace search in Local Providers never worked.
            llmInferenceGrpcClient.getFeaturedModels(search, minParameters, maxParameters).modelsJson.asJsonResponse()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @GetMapping("/installed-models")
    fun getInstalledModels(): ResponseEntity<String> =
        runBlocking {
            llmInferenceGrpcClient.getInstalledModels().modelsJson.asJsonResponse()
        }

    // ── Service status ───────────────────────────────────────────────────────

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @GetMapping("/status")
    fun getStatus(): ResponseEntity<String> =
        runBlocking {
            llmInferenceGrpcClient.getStatus().statusJson.asJsonResponse()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @GetMapping("/system-capabilities")
    fun getSystemCapabilities(): ResponseEntity<Map<String, Any?>> =
        runBlocking {
            val response = llmInferenceGrpcClient.getSystemCapabilities()
            val caps = mutableMapOf<String, Any?>("gpu_available" to response.gpuAvailable, "cuda_version" to response.cudaVersion)
            if (response.capabilitiesJson.isNotEmpty()) {
                @Suppress("UNCHECKED_CAST")
                caps.putAll(objectMapper.readValue(response.capabilitiesJson, Map::class.java) as Map<String, Any?>)
            }
            ResponseEntity.ok(caps)
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @GetMapping("/deployment-status")
    fun getDeploymentStatus(): ResponseEntity<String> =
        runBlocking {
            llmInferenceGrpcClient.getDeploymentStatus().statusJson.asJsonResponse()
        }

    // ── Config ───────────────────────────────────────────────────────────────

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @GetMapping("/config")
    fun getConfig(): ResponseEntity<String> =
        runBlocking {
            llmInferenceGrpcClient.getConfig().configJson.asJsonResponse()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @RequestMapping("/config", method = [RequestMethod.PUT, RequestMethod.POST])
    fun setConfig(
        @RequestBody configJson: String
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            requireAdmin()
            llmInferenceGrpcClient.setConfig(LlmConfigRequest.newBuilder().setConfigJson(configJson).build()).toResult()
        }

    // ── Service control ──────────────────────────────────────────────────────

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @PostMapping("/service/start")
    fun startService(): ResponseEntity<Map<String, Any>> =
        runBlocking {
            requireAdmin()
            llmInferenceGrpcClient.startService().toResult()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @PostMapping("/service/stop")
    fun stopService(): ResponseEntity<Map<String, Any>> =
        runBlocking {
            requireAdmin()
            llmInferenceGrpcClient.stopService().toResult()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @PostMapping("/restart")
    fun restartService(): ResponseEntity<Map<String, Any>> =
        runBlocking {
            requireAdmin()
            llmInferenceGrpcClient.restartService().toResult()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @PostMapping("/reinitialize-local-models")
    fun reinitializeLocalModels(): ResponseEntity<Map<String, Any>> =
        runBlocking {
            requireAdmin()
            llmInferenceGrpcClient.reinitializeLocalModels().toResult()
        }

    // ── Model operations ─────────────────────────────────────────────────────

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @PostMapping("/download-model")
    fun downloadModel(
        @RequestBody body: Map<String, String>
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            requireAdmin()
            llmInferenceGrpcClient
                .downloadModel(
                    DownloadModelRequest
                        .newBuilder()
                        .setModelName(body["model_name"] ?: body["modelName"] ?: "")
                        .setProvider(body["provider"] ?: "")
                        .build()
                ).toResult()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @DeleteMapping("/models/{modelName}")
    fun deleteModel(
        @PathVariable modelName: String
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            requireAdmin()
            llmInferenceGrpcClient.deleteModel(DeleteModelRequest.newBuilder().setModelName(modelName).build()).toResult()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @PostMapping("/undeploy-model")
    fun undeployModel(
        @RequestBody body: Map<String, String>
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            requireAdmin()
            llmInferenceGrpcClient
                .undeployModel(
                    UndeployModelRequest
                        .newBuilder()
                        .setModelName(body["model_name"] ?: body["modelName"] ?: "")
                        .build()
                ).toResult()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @GetMapping("/models/{modelName}/status")
    fun getLocalModelStatus(
        @PathVariable modelName: String
    ): ResponseEntity<String> =
        runBlocking {
            llmInferenceGrpcClient.getLocalModelStatus(LocalModelStatusRequest.newBuilder().setModelName(modelName).build()).statusJson.asJsonResponse()
        }

    // ── GPU operations ───────────────────────────────────────────────────────

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @PostMapping("/deploy-model")
    fun startModelGpu(
        @RequestBody body: Map<String, String?>
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            requireAdmin()
            val modelName = body["model_name"] ?: body["modelName"] ?: ""
            val configJson = body["config_json"] ?: body["configJson"]
            llmInferenceGrpcClient
                .startModelGpu(
                    StartGpuRequest
                        .newBuilder()
                        .setModelName(modelName)
                        .setConfigJson(configJson ?: "")
                        .build()
                ).toResult()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @PostMapping("/gpu/{modelName}/stop")
    fun stopModelGpu(
        @PathVariable modelName: String
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            requireAdmin()
            llmInferenceGrpcClient.stopModelGpu(StopGpuRequest.newBuilder().setModelName(modelName).build()).toResult()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @GetMapping("/gpu-status/{modelName}")
    fun getGpuStatus(
        @PathVariable modelName: String
    ): ResponseEntity<String> =
        runBlocking {
            llmInferenceGrpcClient.getGpuStatus(GpuStatusRequest.newBuilder().setModelName(modelName).build()).statusJson.asJsonResponse()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @GetMapping("/gpu-status")
    fun getOverallGpuStatus(): ResponseEntity<String> =
        runBlocking {
            llmInferenceGrpcClient.getOverallGpuStatus().statusJson.asJsonResponse()
        }

    // ── Provider sync ────────────────────────────────────────────────────────

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @PostMapping("/providers/refresh")
    fun refreshProviderModels(): ResponseEntity<Map<String, Any>> =
        runBlocking {
            llmInferenceGrpcClient.refreshProviderModels().toResult()
        }

    @Suppress("RunBlocking") // Spring MVC thread — runBlocking is safe here
    @PostMapping("/fetch-provider-models")
    fun fetchProviderModels(
        @RequestBody(required = false) body: Map<String, String?>?
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            if (body != null &&
                !body["provider_type"].isNullOrBlank() &&
                (!body["api_key"].isNullOrBlank() || !body["provider_id"].isNullOrBlank())
            ) {
                previewProviderModels(body)
            } else {
                llmInferenceGrpcClient.fetchProviderModels().toResult()
            }
        }

    @Suppress("RunBlocking") // called from a Spring MVC thread directly or via fetchProviderModels — runBlocking is safe here
    @PostMapping("/providers/preview-models")
    fun previewProviderModels(
        @RequestBody body: Map<String, String?>
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            val providerType = body["provider_type"] ?: return@runBlocking ResponseEntity.badRequest().body(mapOf<String, Any>("success" to false, "message" to "provider_type is required"))
            var apiKey = body["api_key"]
            var apiBase = body["api_base"] ?: ""
            val providerId = body["provider_id"]

            // If provider_id is given, backfill the missing api_key / api_base from the Python DB
            if (!providerId.isNullOrBlank() && (apiKey.isNullOrBlank() || apiBase.isBlank())) {
                try {
                    DriverManager
                        .getConnection(
                            "jdbc:postgresql://pgvector:5432/scrapalot",
                            "scrapalot",
                            "scrapalot"
                        ).use { conn ->
                            conn.prepareStatement("SELECT api_key, api_base FROM model_providers WHERE id = ?::uuid").use { stmt ->
                                stmt.setString(1, providerId)
                                stmt.executeQuery().use { rs ->
                                    if (rs.next()) {
                                        if (apiKey.isNullOrBlank()) apiKey = rs.getString("api_key")
                                        if (apiBase.isBlank()) apiBase = rs.getString("api_base") ?: ""
                                    }
                                }
                            }
                        }
                } catch (_: Exception) {
                    // Lookup failed — will proceed with whatever the request provided
                }
            }

            try {
                when (providerType.lowercase()) {
                    "ollama" -> {
                        val endpoint = apiBase.ifBlank { "https://ollama.com" }
                        val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
                        val requestBuilder =
                            HttpRequest
                                .newBuilder()
                                .uri(URI.create("$endpoint/api/tags"))
                                .timeout(Duration.ofSeconds(15))
                                .GET()
                        if (!apiKey.isNullOrBlank() && endpoint.lowercase().contains("ollama.com")) {
                            requestBuilder.header("Authorization", "Bearer $apiKey")
                        }
                        val response = client.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
                        if (response.statusCode() != 200) {
                            return@runBlocking ResponseEntity.ok(mapOf("success" to false, "message" to "Ollama returned ${response.statusCode()}", "models" to emptyList<Any>(), "models_count" to 0))
                        }
                        val data = objectMapper.readTree(response.body())
                        val models =
                            (data["models"] ?: objectMapper.createArrayNode()).map { model ->
                                mapOf(
                                    "model_name" to (model["name"]?.asText() ?: model["model"]?.asText() ?: "unknown"),
                                    "model_type" to "NORMAL",
                                    "context_length" to 0,
                                    "input_cost" to 0,
                                    "output_cost" to 0,
                                    "supports_tools" to false,
                                )
                            }
                        ResponseEntity.ok(mapOf("success" to true, "message" to "Found ${models.size} models", "provider_type" to providerType, "models_count" to models.size, "models" to models))
                    }
                    "groq" -> {
                        // groq uses OpenAI-compatible API
                        val endpoint = apiBase.ifBlank { "https://api.groq.com/openai/v1" }
                        val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
                        val requestBuilder =
                            HttpRequest
                                .newBuilder()
                                .uri(URI.create("$endpoint/models"))
                                .timeout(Duration.ofSeconds(15))
                                .GET()
                        if (!apiKey.isNullOrBlank()) {
                            requestBuilder.header("Authorization", "Bearer $apiKey")
                        }
                        val response = client.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
                        if (response.statusCode() != 200) {
                            return@runBlocking ResponseEntity.ok(mapOf("success" to false, "message" to "groq returned ${response.statusCode()}", "models" to emptyList<Any>(), "models_count" to 0))
                        }
                        val data = objectMapper.readTree(response.body())
                        val models =
                            (data["data"] ?: objectMapper.createArrayNode()).map { model ->
                                mapOf(
                                    "model_name" to (model["id"]?.asText() ?: "unknown"),
                                    "model_type" to "NORMAL",
                                    "context_length" to (model["context_window"]?.asInt() ?: 0),
                                    "input_cost" to 0,
                                    "output_cost" to 0,
                                    "supports_tools" to false,
                                )
                            }
                        ResponseEntity.ok(mapOf("success" to true, "message" to "Found ${models.size} models", "provider_type" to providerType, "models_count" to models.size, "models" to models))
                    }
                    "anthropic" -> {
                        val endpoint = apiBase.ifBlank { "https://api.anthropic.com" }
                        val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
                        val requestBuilder =
                            HttpRequest
                                .newBuilder()
                                .uri(URI.create("$endpoint/v1/models?limit=1000"))
                                .timeout(Duration.ofSeconds(15))
                                .header("anthropic-version", "2023-06-01")
                                .GET()
                        if (!apiKey.isNullOrBlank()) {
                            requestBuilder.header("x-api-key", apiKey)
                        }
                        val response = client.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
                        if (response.statusCode() != 200) {
                            return@runBlocking ResponseEntity.ok(
                                mapOf(
                                    "success" to false,
                                    "message" to "anthropic returned ${response.statusCode()}: ${response.body().take(200)}",
                                    "models" to emptyList<Any>(),
                                    "models_count" to 0
                                )
                            )
                        }
                        val data = objectMapper.readTree(response.body())
                        val models =
                            (data["data"] ?: objectMapper.createArrayNode()).map { model ->
                                mapOf(
                                    "model_name" to (model["id"]?.asText() ?: "unknown"),
                                    "model_type" to "NORMAL",
                                    "context_length" to 0,
                                    "input_cost" to 0,
                                    "output_cost" to 0,
                                    "supports_tools" to true,
                                )
                            }
                        ResponseEntity.ok(mapOf("success" to true, "message" to "Found ${models.size} models", "provider_type" to providerType, "models_count" to models.size, "models" to models))
                    }
                    "openai" -> {
                        val endpoint = apiBase.ifBlank { "https://api.openai.com/v1" }
                        val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
                        val request =
                            HttpRequest
                                .newBuilder()
                                .uri(URI.create("$endpoint/models"))
                                .timeout(Duration.ofSeconds(15))
                                .apply { if (!apiKey.isNullOrBlank()) header("Authorization", "Bearer $apiKey") }
                                .GET()
                                .build()
                        val response = client.send(request, HttpResponse.BodyHandlers.ofString())
                        if (response.statusCode() != 200) {
                            return@runBlocking ResponseEntity.ok(
                                mapOf(
                                    "success" to false,
                                    "message" to "OpenAI returned ${response.statusCode()}: ${response.body().take(200)}",
                                    "models" to emptyList<Any>(),
                                    "models_count" to 0
                                )
                            )
                        }
                        val data = objectMapper.readTree(response.body())
                        val models =
                            (data["data"] ?: objectMapper.createArrayNode()).map { model ->
                                mapOf(
                                    "model_name" to (model["id"]?.asText() ?: "unknown"),
                                    "model_type" to "NORMAL",
                                    "context_length" to 0,
                                    "input_cost" to 0,
                                    "output_cost" to 0,
                                    "supports_tools" to true,
                                )
                            }
                        ResponseEntity.ok(mapOf("success" to true, "message" to "Found ${models.size} models", "provider_type" to providerType, "models_count" to models.size, "models" to models))
                    }
                    "deepseek" -> {
                        // DeepSeek exposes an OpenAI-compatible models endpoint.
                        val endpoint = apiBase.ifBlank { "https://api.deepseek.com" }
                        val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
                        val request =
                            HttpRequest
                                .newBuilder()
                                .uri(URI.create("$endpoint/models"))
                                .timeout(Duration.ofSeconds(15))
                                .apply { if (!apiKey.isNullOrBlank()) header("Authorization", "Bearer $apiKey") }
                                .GET()
                                .build()
                        val response = client.send(request, HttpResponse.BodyHandlers.ofString())
                        if (response.statusCode() != 200) {
                            return@runBlocking ResponseEntity.ok(
                                mapOf(
                                    "success" to false,
                                    "message" to "DeepSeek returned ${response.statusCode()}: ${response.body().take(200)}",
                                    "models" to emptyList<Any>(),
                                    "models_count" to 0
                                )
                            )
                        }
                        val data = objectMapper.readTree(response.body())
                        val models =
                            (data["data"] ?: objectMapper.createArrayNode()).map { model ->
                                mapOf(
                                    "model_name" to (model["id"]?.asText() ?: "unknown"),
                                    "model_type" to "NORMAL",
                                    "context_length" to 0,
                                    "input_cost" to 0,
                                    "output_cost" to 0,
                                    "supports_tools" to true,
                                )
                            }
                        ResponseEntity.ok(mapOf("success" to true, "message" to "Found ${models.size} models", "provider_type" to providerType, "models_count" to models.size, "models" to models))
                    }
                    "system" -> {
                        // The system provider is a thin tag over a concrete sub-provider
                        // (e.g. DeepSeek). Fetch the model catalogue straight from its
                        // configured api_base using the OpenAI-compatible /models endpoint.
                        if (apiBase.isBlank()) {
                            return@runBlocking ResponseEntity.ok(
                                mapOf("success" to false, "message" to "System provider has no API base configured", "models" to emptyList<Any>(), "models_count" to 0)
                            )
                        }
                        val endpoint = apiBase.trimEnd('/')
                        val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
                        val request =
                            HttpRequest
                                .newBuilder()
                                .uri(URI.create("$endpoint/models"))
                                .timeout(Duration.ofSeconds(15))
                                .apply { if (!apiKey.isNullOrBlank()) header("Authorization", "Bearer $apiKey") }
                                .GET()
                                .build()
                        val response = client.send(request, HttpResponse.BodyHandlers.ofString())
                        if (response.statusCode() != 200) {
                            return@runBlocking ResponseEntity.ok(
                                mapOf(
                                    "success" to false,
                                    "message" to "System provider returned ${response.statusCode()}: ${response.body().take(200)}",
                                    "models" to emptyList<Any>(),
                                    "models_count" to 0
                                )
                            )
                        }
                        val data = objectMapper.readTree(response.body())
                        val models =
                            (data["data"] ?: objectMapper.createArrayNode()).map { model ->
                                mapOf(
                                    "model_name" to (model["id"]?.asText() ?: "unknown"),
                                    "model_type" to "NORMAL",
                                    "context_length" to 0,
                                    "input_cost" to 0,
                                    "output_cost" to 0,
                                    "supports_tools" to true,
                                )
                            }
                        ResponseEntity.ok(mapOf("success" to true, "message" to "Found ${models.size} models", "provider_type" to providerType, "models_count" to models.size, "models" to models))
                    }
                    else -> {
                        // For other providers, fall back to gRPC sync
                        val grpcResult = llmInferenceGrpcClient.fetchProviderModels()
                        ResponseEntity.ok(mapOf<String, Any>("success" to grpcResult.success, "message" to grpcResult.message, "models" to emptyList<Any>(), "models_count" to 0))
                    }
                }
            } catch (e: Exception) {
                ResponseEntity.ok(mapOf("success" to false, "message" to (e.message ?: "Unknown error"), "models" to emptyList<Any>(), "models_count" to 0))
            }
        }

    // ── Download progress (SSE stream) ───────────────────────────────────────

    @GetMapping("/download-progress-stream/{modelName}", produces = [MediaType.TEXT_EVENT_STREAM_VALUE])
    fun getDownloadProgress(
        @PathVariable modelName: String
    ): Flux<String> {
        val flow =
            llmInferenceGrpcClient
                .getDownloadProgress(
                    DownloadProgressRequest.newBuilder().setModelName(modelName).build()
                ).map { objectMapper.writeValueAsString(mapOf("progress" to it.progress, "speed" to it.speed, "eta" to it.eta, "status" to it.status, "message" to it.message)) }
        return Flux.from(flow.asPublisher())
    }
}
