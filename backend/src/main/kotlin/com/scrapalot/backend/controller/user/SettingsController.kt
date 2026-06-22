package com.scrapalot.backend.controller.user

import com.scrapalot.backend.domain.settings.ServerSetting
import com.scrapalot.backend.domain.settings.UserSetting
import com.scrapalot.backend.dto.BatchSettingsRequest
import com.scrapalot.backend.dto.ServerSettingResponse
import com.scrapalot.backend.dto.UserSettingResponse
import com.scrapalot.backend.grpc.SettingsAIGrpcClient
import com.scrapalot.backend.grpc.settings.CreateProviderRequest
import com.scrapalot.backend.grpc.settings.DeleteProviderRequest
import com.scrapalot.backend.grpc.settings.EmbeddingConfigRequest
import com.scrapalot.backend.grpc.settings.ListModelsRequest
import com.scrapalot.backend.grpc.settings.ListProvidersRequest
import com.scrapalot.backend.grpc.settings.ServiceLogsRequest
import com.scrapalot.backend.grpc.settings.SetAdminDefaultSystemPromptRequest
import com.scrapalot.backend.grpc.settings.SetEmbeddingConfigRequest
import com.scrapalot.backend.grpc.settings.SetSelectedModelRequest
import com.scrapalot.backend.grpc.settings.SetSpeechConfigRequest
import com.scrapalot.backend.grpc.settings.SetSystemAgentConfigRequest
import com.scrapalot.backend.grpc.settings.UpdateProviderRequest
import com.scrapalot.backend.service.SettingsService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.*
import jakarta.validation.Valid
import kotlinx.coroutines.runBlocking
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import java.util.UUID

// Sentinel id for a user-setting response that has no persisted row yet
// (GET /user/{key} returns 200 with a null value instead of 404).
private val NIL_UUID: UUID = UUID(0L, 0L)

@RestController
@RequestMapping("/api/v1/settings")
class SettingsController(
    private val settingsService: SettingsService,
    private val userService: UserService,
    private val settingsAIGrpcClient: SettingsAIGrpcClient,
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    // User Settings

    @GetMapping("/user")
    fun getAllUserSettings(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<UserSettingResponse>> =
        resultOf {
            val userId = userDetails.userId()
            settingsService.getAllUserSettings(userId).map { it.toResponse() }
        }.toResponseEntity()

    @GetMapping("/user/{key}")
    fun getUserSetting(
        @PathVariable key: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<UserSettingResponse> =
        resultOf {
            val userId = userDetails.userId()
            // A missing optional setting is the normal "never customised" state,
            // not an error. Return 200 with a null value instead of 404 so callers
            // (and the browser console / Network tab) don't see first-time defaults
            // as failures — e.g. /settings/user/notes_editor_preferences fired a
            // 404 on every dashboard load for users who never touched the editor.
            settingsService.getUserSetting(userId, key)?.toResponse()
                ?: UserSettingResponse(
                    id = NIL_UUID,
                    userId = userId,
                    settingKey = key,
                    settingValue = null,
                    createdAt = "",
                    updatedAt = ""
                )
        }.toResponseEntity()

    @PutMapping("/user/{key}")
    fun setUserSetting(
        @PathVariable key: String,
        @RequestBody value: Map<String, Any>?,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<UserSettingResponse> =
        resultOf {
            val userId = userDetails.userId()
            settingsService.setUserSetting(userId, key, value).toResponse()
        }.toResponseEntity()

    @PostMapping("/user/batch")
    fun setUserSettingsBatch(
        @Valid @RequestBody request: BatchSettingsRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<UserSettingResponse>> =
        resultOf {
            val userId = userDetails.userId()
            request.settings
                .map { (key, value) ->
                    settingsService.setUserSetting(userId, key, value)
                }.map { it.toResponse() }
        }.toResponseEntity()

    @DeleteMapping("/user/{key}")
    fun deleteUserSetting(
        @PathVariable key: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            settingsService.deleteUserSetting(userId, key)
        }.toNoContentResponse()

    // Legacy alias: frontend calls GET /settings/ for user settings
    @GetMapping("/")
    fun getAllUserSettingsAlias(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<UserSettingResponse>> = getAllUserSettings(userDetails)

    // Helper Endpoints for Common Settings

    @GetMapping("/user/workspace/selected")
    fun getSelectedWorkspace(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, UUID?>> =
        resultOf {
            val userId = userDetails.userId()
            val workspaceId = settingsService.getSelectedWorkspace(userId)
            mapOf("workspaceId" to workspaceId)
        }.toResponseEntity()

    @PutMapping("/user/workspace/selected")
    fun setSelectedWorkspace(
        @RequestBody request: Map<String, String>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            val workspaceId = UUID.fromString(request["workspaceId"])
            settingsService.setSelectedWorkspace(userId, workspaceId)
        }.toNoContentResponse()

    @GetMapping("/user/general")
    fun getGeneralSettings(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> =
        resultOf {
            val userId = userDetails.userId()
            settingsService.getGeneralSettings(userId) ?: emptyMap()
        }.toResponseEntity()

    @PutMapping("/user/general")
    fun setGeneralSettings(
        @RequestBody settings: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            settingsService.setGeneralSettings(userId, settings)
        }.toNoContentResponse()

    // Legacy aliases: frontend calls /settings/settings_general
    @GetMapping("/settings_general")
    fun getGeneralSettingsAlias(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> = getGeneralSettings(userDetails)

    @PostMapping("/settings_general")
    fun setGeneralSettingsAlias(
        @RequestBody settings: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> {
        // Frontend sends {value: {...}}, extract the value
        @Suppress("UNCHECKED_CAST")
        val actualSettings = (settings["value"] as? Map<String, Any>) ?: settings
        return setGeneralSettings(actualSettings, userDetails)
    }

    @GetMapping("/user/document-processing")
    fun getDocumentProcessingSettings(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> =
        resultOf {
            val userId = userDetails.userId()
            settingsService.getDocumentProcessingSettings(userId) ?: emptyMap()
        }.toResponseEntity()

    @PutMapping("/user/document-processing")
    fun setDocumentProcessingSettings(
        @RequestBody settings: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            settingsService.setDocumentProcessingSettings(userId, settings)
        }.toNoContentResponse()

    // Server Settings (Admin Only)

    @GetMapping("/server")
    fun getAllServerSettings(): ResponseEntity<List<ServerSettingResponse>> =
        resultOf {
            settingsService.getAllServerSettings().map { it.toResponse() }
        }.toResponseEntity()

    @GetMapping("/server/{key}")
    fun getServerSetting(
        @PathVariable key: String
    ): ResponseEntity<ServerSettingResponse> =
        resultOf {
            settingsService
                .getServerSetting(key)
                .orNotFound("Server setting not found: $key")
                .toResponse()
        }.toResponseEntity()

    @PutMapping("/server/{key}")
    fun setServerSetting(
        @PathVariable key: String,
        @RequestBody value: Map<String, Any>?
    ): ResponseEntity<ServerSettingResponse> =
        resultOf {
            settingsService.setServerSetting(key, value).toResponse()
        }.toResponseEntity()

    @DeleteMapping("/server/{key}")
    fun deleteServerSetting(
        @PathVariable key: String
    ): ResponseEntity<Void> =
        resultOf {
            settingsService.deleteServerSetting(key)
        }.toNoContentResponse()

    // --- System Agent Config (Admin Only, via gRPC to Python) ---

    @GetMapping("/system-agent-config")
    fun getSystemAgentConfig(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Any> =
        runBlocking {
            val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
            if (!user.isAdmin()) {
                return@runBlocking ResponseEntity.status(403).body(mapOf("error" to "Admin access required") as Any)
            }
            val response = settingsAIGrpcClient.getSystemAgentConfig()
            ResponseEntity.ok(
                mapOf(
                    "provider_type" to response.providerType,
                    "model_name" to response.modelName,
                    "api_base" to response.apiBase,
                    "has_api_key" to response.hasApiKey,
                    "config_json" to response.configJson,
                ) as Any
            )
        }

    @PutMapping("/system-agent-config")
    fun setSystemAgentConfig(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Any> =
        runBlocking {
            val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
            if (!user.isAdmin()) {
                return@runBlocking ResponseEntity.status(403).body(mapOf("error" to "Admin access required") as Any)
            }

            val request =
                SetSystemAgentConfigRequest
                    .newBuilder()
                    .setProviderType(body["provider_type"]?.toString() ?: "")
                    .setModelName(body["model_name"]?.toString() ?: "")
                    .setApiKey(body["api_key"]?.toString() ?: "")
                    .setApiBase(body["api_base"]?.toString() ?: "")
                    .setConfigJson(body["config_json"]?.toString() ?: "")
                    .build()

            val response = settingsAIGrpcClient.setSystemAgentConfig(request)
            if (response.success) {
                grpcSuccessResponse(response.message)
            } else {
                grpcFailureResponse(response.message)
            }
        }

    // --- Admin Default System Prompt (Admin Only, via gRPC to Python) ---
    // Settings → Prompts → Default System Prompt textarea. The value is
    // saved into Python's server_settings(setting_key='admin_default_system_prompt')
    // and read by Layer 1 of the layered system-prompt builder on every chat.

    @GetMapping("/admin-default-system-prompt")
    fun getAdminDefaultSystemPrompt(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Any> =
        runBlocking {
            val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
            if (!user.isAdmin()) {
                return@runBlocking ResponseEntity.status(403).body(mapOf("error" to "Admin access required") as Any)
            }
            val response = settingsAIGrpcClient.getAdminDefaultSystemPrompt()
            ResponseEntity.ok(
                mapOf(
                    "prompt" to response.prompt,
                    "is_set" to response.isSet,
                ) as Any
            )
        }

    @PutMapping("/admin-default-system-prompt")
    fun setAdminDefaultSystemPrompt(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Any> =
        runBlocking {
            val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
            if (!user.isAdmin()) {
                return@runBlocking ResponseEntity.status(403).body(mapOf("error" to "Admin access required") as Any)
            }
            val request =
                SetAdminDefaultSystemPromptRequest
                    .newBuilder()
                    .setPrompt(body["prompt"]?.toString() ?: "")
                    .build()
            val response = settingsAIGrpcClient.setAdminDefaultSystemPrompt(request)
            if (response.success) {
                grpcSuccessResponse(response.message)
            } else {
                grpcFailureResponse(response.message)
            }
        }

    // --- Speech Config (Admin Only, via gRPC to Python) ---

    @GetMapping("/speech-config")
    fun getSpeechConfig(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Any> =
        runBlocking {
            val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
            if (!user.isAdmin()) {
                return@runBlocking ResponseEntity.status(403).body(mapOf("error" to "Admin access required") as Any)
            }
            val response = settingsAIGrpcClient.getSpeechConfig()
            ResponseEntity.ok(
                mapOf(
                    "stt_provider" to response.sttProvider,
                    "stt_model" to response.sttModel,
                    "tts_provider" to response.ttsProvider,
                    "tts_default_voice" to response.ttsDefaultVoice,
                    "has_stt_api_key" to response.hasSttApiKey,
                    "has_elevenlabs_key" to response.hasElevenlabsKey,
                    "config_json" to response.configJson,
                ) as Any
            )
        }

    @PutMapping("/speech-config")
    fun setSpeechConfig(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Any> =
        runBlocking {
            val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
            if (!user.isAdmin()) {
                return@runBlocking ResponseEntity.status(403).body(mapOf("error" to "Admin access required") as Any)
            }

            val request =
                SetSpeechConfigRequest
                    .newBuilder()
                    .setSttProvider(body["stt_provider"]?.toString() ?: "")
                    .setSttModel(body["stt_model"]?.toString() ?: "")
                    .setTtsProvider(body["tts_provider"]?.toString() ?: "")
                    .setTtsDefaultVoice(body["tts_default_voice"]?.toString() ?: "")
                    .setSttApiKey(body["stt_api_key"]?.toString() ?: "")
                    .setElevenlabsApiKey(body["elevenlabs_api_key"]?.toString() ?: "")
                    .setConfigJson(body["config_json"]?.toString() ?: "")
                    .build()

            val response = settingsAIGrpcClient.setSpeechConfig(request)
            if (response.success) {
                grpcSuccessResponse(response.message)
            } else {
                grpcFailureResponse(response.message)
            }
        }

    // --- AI Settings (via gRPC to Python) ---

    // Model Providers

    @GetMapping("/providers")
    fun listProviders(
        @RequestParam(required = false) providerId: String?,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Any> =
        runBlocking {
            val userId = userDetails.userId()
            val request =
                ListProvidersRequest
                    .newBuilder()
                    .setUserId(userId.toString())
                    .setProviderId(providerId ?: "")
                    .build()
            val response = settingsAIGrpcClient.listProviders(request)
            val providers =
                response.providersList.map { p ->
                    mapOf(
                        "id" to p.id,
                        "name" to p.name,
                        "api_base" to p.apiBase,
                        "provider_type" to p.providerType,
                        "status" to p.status,
                        "icon" to p.icon,
                        "is_enabled" to p.isEnabled,
                        "has_api_key" to p.hasApiKey,
                        "created_at" to p.createdAt,
                        "updated_at" to p.updatedAt,
                        "models" to
                            p.modelsList.map { m ->
                                mapOf(
                                    "id" to m.id,
                                    "provider_id" to m.providerId,
                                    "model_name" to m.modelName,
                                    "display_name" to m.displayName,
                                    "model_type" to m.modelType,
                                    "context_window" to m.contextWindow,
                                    "dimensions" to m.dimensions,
                                    "icon" to m.icon,
                                    "is_default" to m.isDefault
                                )
                            }
                    )
                }
            ResponseEntity.ok(providers)
        }

    @PostMapping("/providers")
    fun createProvider(
        @RequestBody body: Map<String, Any>
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            val request =
                CreateProviderRequest
                    .newBuilder()
                    .setName(body["name"]?.toString() ?: "")
                    .setApiKey(body["api_key"]?.toString() ?: "")
                    .setApiBase(body["api_base"]?.toString() ?: "")
                    .setProviderType(body["provider_type"]?.toString() ?: "")
                    .setAutoSync(body["auto_sync"] as? Boolean ?: false)
                    .build()
            val response = settingsAIGrpcClient.createProvider(request)
            if (response.success) {
                val provider = response.provider
                ResponseEntity.ok(
                    mapOf(
                        "success" to true,
                        "provider" to
                            mapOf(
                                "id" to provider.id,
                                "name" to provider.name,
                                "provider_type" to provider.providerType,
                                "status" to provider.status
                            )
                    )
                )
            } else {
                ResponseEntity.badRequest().body(mapOf("success" to false, "error" to (response.error ?: "Unknown error")))
            }
        }

    @PutMapping("/providers/{providerId}")
    fun updateProvider(
        @PathVariable providerId: String,
        @RequestBody body: Map<String, Any>
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            val builder =
                UpdateProviderRequest
                    .newBuilder()
                    .setProviderId(providerId)
                    .setName(body["name"]?.toString() ?: "")
                    .setApiKey(body["api_key"]?.toString() ?: "")
                    .setApiBase(body["api_base"]?.toString() ?: "")
                    .setProviderType(body["provider_type"]?.toString() ?: "")
                    .setAutoSync(body["auto_sync"] as? Boolean ?: false)

            // Extract selected model names from the model array
            @Suppress("UNCHECKED_CAST")
            val models = body["models"] as? List<Map<String, Any>>
            if (models != null) {
                val modelNames = models.mapNotNull { it["model_name"]?.toString() }
                builder.addAllSelectedModelNames(modelNames)
            }

            val request = builder.build()
            val response = settingsAIGrpcClient.updateProvider(request)
            if (response.success) {
                val provider = response.provider
                ResponseEntity.ok(
                    mapOf(
                        "success" to true,
                        "provider" to
                            mapOf(
                                "id" to provider.id,
                                "name" to provider.name,
                                "provider_type" to provider.providerType
                            )
                    )
                )
            } else {
                ResponseEntity.badRequest().body(mapOf("success" to false, "error" to (response.error ?: "Unknown error")))
            }
        }

    @DeleteMapping("/providers/{providerId}")
    fun deleteProvider(
        @PathVariable providerId: String
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            val request = DeleteProviderRequest.newBuilder().setProviderId(providerId).build()
            val response = settingsAIGrpcClient.deleteProvider(request)
            ResponseEntity.ok(mapOf("success" to response.success, "message" to response.message))
        }

    // Models

    @GetMapping("/models")
    fun listModels(): ResponseEntity<Any> =
        runBlocking {
            val request = ListModelsRequest.getDefaultInstance()
            val response = settingsAIGrpcClient.listModels(request)
            val models =
                response.modelsList.map { m ->
                    mapOf(
                        "id" to m.id,
                        "provider_id" to m.providerId,
                        "model_name" to m.modelName,
                        "display_name" to m.displayName,
                        "model_type" to m.modelType,
                        "context_window" to m.contextWindow,
                        "dimensions" to m.dimensions,
                        "icon" to m.icon
                    )
                }
            ResponseEntity.ok(models)
        }

    @PostMapping("/models/selected")
    fun setSelectedModel(
        @RequestBody body: Map<String, String>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            val userId = userDetails.userId()

            // Save to Kotlin DB (source of truth)
            settingsService.setUserSetting(
                userId,
                "selected_model",
                mapOf(
                    "model" to (body["model_id"] ?: ""),
                    "model_name" to (body["model_name"] ?: ""),
                    "provider_type" to (body["provider_type"] ?: "")
                )
            )

            // Also call Python gRPC SetSelectedModel for backward compatibility
            val request =
                SetSelectedModelRequest
                    .newBuilder()
                    .setUserId(userId.toString())
                    .setModelId(body["model_id"] ?: "")
                    .setModelName(body["model_name"] ?: "")
                    .setProviderType(body["provider_type"] ?: "")
                    .build()
            val response = settingsAIGrpcClient.setSelectedModel(request)
            if (response.success) {
                ResponseEntity.ok(
                    mapOf(
                        "success" to true,
                        "model_id" to response.modelId,
                        "display_name" to response.displayName,
                        "provider_type" to response.providerType
                    )
                )
            } else {
                ResponseEntity.badRequest().body(mapOf("success" to false, "error" to (response.error ?: "Unknown error")))
            }
        }

    // Embedding

    @GetMapping("/embedding")
    fun getEmbeddingConfig(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<String> =
        runBlocking {
            val userId = userDetails.userId()
            val request = EmbeddingConfigRequest.newBuilder().setUserId(userId.toString()).build()
            val response = settingsAIGrpcClient.getEmbeddingConfig(request)
            (response.settingsJson.ifEmpty { "{}" }).asJsonResponse()
        }

    @PutMapping("/embedding")
    fun setEmbeddingConfig(
        @RequestBody body: Map<String, String>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            val userId = userDetails.userId()

            // Save to Kotlin DB (source of truth)
            settingsService.setUserSetting(
                userId,
                "embedding",
                mapOf(
                    "embedding_model" to (body["embedding_model"] ?: "")
                )
            )

            // Also call Python gRPC SetEmbeddingConfig for backward compatibility
            val request =
                SetEmbeddingConfigRequest
                    .newBuilder()
                    .setUserId(userId.toString())
                    .setEmbeddingModel(body["embedding_model"] ?: "")
                    .build()
            val response = settingsAIGrpcClient.setEmbeddingConfig(request)
            ResponseEntity.ok(mapOf("success" to response.success, "message" to response.message))
        }

    @GetMapping("/embedding/models")
    fun listEmbeddingModels(): ResponseEntity<Any> =
        runBlocking {
            val response = settingsAIGrpcClient.listEmbeddingModels()
            val models =
                response.modelsList.map { m ->
                    mapOf(
                        "id" to m.id,
                        "provider_id" to m.providerId,
                        "model_name" to m.modelName,
                        "display_name" to m.displayName,
                        "model_type" to m.modelType,
                        "dimensions" to m.dimensions
                    )
                }
            ResponseEntity.ok(models)
        }

    // Model settings (temperature, top_p, max_tokens, etc.)
    @GetMapping("/model-settings")
    fun getModelSettings(
        @RequestParam(name = "chat_id", required = false) chatId: String?,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> {
        val userId = userDetails.userId()
        val key = if (!chatId.isNullOrBlank()) "model_settings_$chatId" else "model_settings"
        val setting = settingsService.getUserSetting(userId, key)
        return ResponseEntity.ok(setting?.settingValue ?: emptyMap())
    }

    @PostMapping("/model")
    fun setModelSettings(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()

            @Suppress("UNCHECKED_CAST")
            val value = (body["value"] as? Map<String, Any>) ?: body
            val chatId = body["chat_id"]?.toString()
            val key = if (!chatId.isNullOrBlank()) "model_settings_$chatId" else "model_settings"
            settingsService.setUserSetting(userId, key, value)
            Unit
        }.toNoContentResponse()

    // Legacy aliases: frontend calls /settings/selected_model
    @GetMapping("/selected_model")
    fun getSelectedModelAlias(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> {
        val userId = userDetails.userId()
        val setting = settingsService.getUserSetting(userId, "selected_model")
        return ResponseEntity.ok(setting?.settingValue ?: emptyMap())
    }

    @PostMapping("/selected_model")
    fun setSelectedModelAlias(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            settingsService.setUserSetting(userId, "selected_model", body)
            Unit
        }.toNoContentResponse()

    // Legacy alias: frontend calls /settings/document_processing (underscore)
    @GetMapping("/document_processing")
    fun getDocumentProcessingSettingsAlias(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> = getDocumentProcessingSettings(userDetails)

    @PostMapping("/document_processing")
    fun setDocumentProcessingSettingsAlias(
        @RequestBody settings: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> {
        @Suppress("UNCHECKED_CAST")
        val actualSettings = (settings["value"] as? Map<String, Any>) ?: settings
        return setDocumentProcessingSettings(actualSettings, userDetails)
    }

    // Legacy aliases: frontend calls /settings/prompts
    @GetMapping("/prompts")
    fun getPromptTemplates(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> =
        resultOf {
            val userId = userDetails.userId()
            settingsService.getUserSetting(userId, "prompts")?.settingValue ?: emptyMap()
        }.toResponseEntity()

    @PostMapping("/prompts")
    fun setPromptTemplates(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            settingsService.setUserSetting(userId, "prompts", body)
            Unit
        }.toNoContentResponse()

    // Legacy aliases: frontend calls /settings/selected_collections
    @GetMapping("/selected_collections")
    fun getSelectedCollections(
        @RequestParam(name = "session_id") sessionId: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> =
        resultOf {
            val userId = userDetails.userId()
            settingsService.getUserSetting(userId, "selected_collections_$sessionId")?.settingValue ?: emptyMap()
        }.toResponseEntity()

    @PostMapping("/selected_collections")
    fun setSelectedCollections(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            val sessionId = body["session_id"]?.toString() ?: ""
            settingsService.setUserSetting(userId, "selected_collections_$sessionId", body)
            Unit
        }.toNoContentResponse()

    // Legacy aliases: frontend calls /settings/rag-strategies (hyphen)
    @GetMapping("/rag-strategies")
    fun listRagStrategiesAlias(): ResponseEntity<String> = listRagStrategies()

    // Legacy aliases: frontend calls /settings/service-status and /settings/service-logs (hyphen)
    @GetMapping("/service-status")
    fun getServiceStatusAlias(): ResponseEntity<Map<String, Any>> = getServiceStatus()

    @GetMapping("/service-logs")
    fun getServiceLogsAlias(
        @RequestParam(defaultValue = "100") lines: Int,
        @RequestParam(required = false) level: String?,
        @RequestParam(required = false, name = "time_range") timeRange: String?
    ): ResponseEntity<String> = getServiceLogs(lines, level, timeRange)

    // Legacy aliases: frontend calls /settings/research_templates
    @GetMapping("/research_templates")
    fun getResearchTemplates(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> =
        resultOf {
            val userId = userDetails.userId()
            settingsService.getUserSetting(userId, "research_templates")?.settingValue ?: emptyMap()
        }.toResponseEntity()

    @PostMapping("/research_templates")
    fun setResearchTemplates(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            settingsService.setUserSetting(userId, "research_templates", body)
            Unit
        }.toNoContentResponse()

    // Legacy alias: frontend calls /settings/consent-texts
    @GetMapping("/consent-texts")
    @Suppress("UNCHECKED_CAST")
    fun getConsentTexts(): ResponseEntity<Map<String, Any>> =
        resultOf {
            (settingsService.getServerSetting("consent_texts")?.settingValue as? Map<String, Any>) ?: emptyMap()
        }.toResponseEntity()

    @PutMapping("/consent-texts")
    fun updateConsentTexts(
        @RequestBody body: Map<String, Any>
    ): ResponseEntity<Void> =
        resultOf {
            settingsService.setServerSetting("consent_texts", body)
            Unit
        }.toNoContentResponse()

    // RAG Strategies

    @GetMapping("/rag/strategies")
    fun listRagStrategies(): ResponseEntity<String> =
        runBlocking {
            val response = settingsAIGrpcClient.listRagStrategies()
            response.strategiesJson.asJsonResponse()
        }

    // Service Status

    @GetMapping("/service/status")
    fun getServiceStatus(): ResponseEntity<Map<String, Any>> =
        runBlocking {
            val response = settingsAIGrpcClient.getServiceStatus()
            ResponseEntity.ok(
                mapOf(
                    "service_name" to response.serviceName,
                    "version" to response.version,
                    "status" to response.status,
                    "host" to response.host,
                    "port" to response.port,
                    "uptime_seconds" to response.uptimeSeconds,
                    "memory_usage" to response.memoryUsage,
                    "cpu_percent" to response.cpuPercent
                )
            )
        }

    @GetMapping("/service/logs")
    fun getServiceLogs(
        @RequestParam(defaultValue = "100") lines: Int,
        @RequestParam(required = false) level: String?,
        @RequestParam(required = false) timeRange: String?
    ): ResponseEntity<String> =
        runBlocking {
            val request =
                ServiceLogsRequest
                    .newBuilder()
                    .setLines(lines)
                    .setLevel(level ?: "")
                    .setTimeRange(timeRange ?: "")
                    .build()
            val response = settingsAIGrpcClient.getServiceLogs(request)
            response.logsJson.asJsonResponse()
        }
}

private fun UserSetting.toResponse() =
    UserSettingResponse(
        id = id.orThrow("Entity"),
        userId = userId,
        settingKey = settingKey,
        settingValue = settingValue,
        createdAt = createdAt.toString(),
        updatedAt = updatedAt.toString()
    )

private fun ServerSetting.toResponse() =
    ServerSettingResponse(
        id = id.orThrow("Entity"),
        settingKey = settingKey,
        settingValue = settingValue,
        createdAt = createdAt.toString(),
        updatedAt = updatedAt.toString()
    )
