package com.scrapalot.backend.service

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.scrapalot.backend.dto.ChatRequest
import com.scrapalot.backend.dto.openai.OpenAIChatCompletion
import com.scrapalot.backend.dto.openai.OpenAIChatCompletionChunk
import com.scrapalot.backend.dto.openai.OpenAIChatCompletionRequest
import com.scrapalot.backend.dto.openai.OpenAIChatMessage
import com.scrapalot.backend.dto.openai.OpenAIChunkChoice
import com.scrapalot.backend.dto.openai.OpenAICompletionChoice
import com.scrapalot.backend.dto.openai.OpenAIDelta
import com.scrapalot.backend.dto.openai.OpenAIModel
import com.scrapalot.backend.dto.openai.OpenAIModelsResponse
import com.scrapalot.backend.repository.CollectionRepository
import com.scrapalot.backend.repository.WorkspaceRepository
import mu.KotlinLogging
import org.springframework.stereotype.Service
import reactor.core.publisher.Flux
import java.time.Instant
import java.util.NoSuchElementException
import java.util.UUID

private val logger = KotlinLogging.logger {}

/**
 * OpenAI-compatible API surface.
 *
 * Translates an OpenAI-shaped request into the internal `ChatRequest` and
 * delegates to [ChatService.generateChat], then re-shapes the streamed
 * NDJSON packets into OpenAI `chat.completion.chunk` events.
 *
 * The `model` field carries Scrapalot routing slugs:
 *   - `scrapalot:<workspace-slug>`             → RAG over the whole workspace
 *   - `scrapalot:<workspace-slug>:<col-slug>`  → RAG over one collection
 *   - everything else                          → DirectLLM in the user's
 *                                                default workspace (no slug
 *                                                lookup performed)
 */
@Service
class OpenAICompatibleService(
    private val chatService: ChatService,
    private val workspaceRepository: WorkspaceRepository,
    private val workspaceService: WorkspaceService,
    private val collectionRepository: CollectionRepository,
    private val modelProviderService: ModelProviderService,
    private val objectMapper: ObjectMapper,
) {
    private val slugPattern = Regex("^scrapalot:([a-z0-9-]+)(?::([a-z0-9-]+))?$")

    // ── /v1/models ──────────────────────────────────────────────────────────

    fun listModels(userId: UUID): OpenAIModelsResponse {
        val workspaces = workspaceRepository.findAllAccessibleWorkspaces(userId)
        val now = Instant.now().epochSecond
        val entries = mutableListOf<OpenAIModel>()
        for (ws in workspaces) {
            entries += OpenAIModel(id = "scrapalot:${ws.slug}", created = ws.createdAt.epochSecond)
            val cols = collectionRepository.findByWorkspaceId(ws.id!!)
            for (col in cols) {
                entries +=
                    OpenAIModel(
                        id = "scrapalot:${ws.slug}:${col.slug}",
                        created = col.createdAt.epochSecond,
                    )
            }
        }
        return OpenAIModelsResponse(data = entries.ifEmpty { listOf(OpenAIModel(id = "scrapalot:default", created = now)) })
    }

    fun getModel(
        userId: UUID,
        modelId: String
    ): OpenAIModel {
        val resolved = resolveModelSlug(modelId, userId)
        return OpenAIModel(
            id = modelId,
            created = (resolved.collection?.createdAt ?: resolved.workspace.createdAt).epochSecond,
        )
    }

    // ── /v1/chat/completions (streaming) ────────────────────────────────────

    /**
     * Stream `chat.completion.chunk` events as already-rendered SSE lines
     * (`data: {...}\n\n`). The terminal `data: [DONE]\n\n` sentinel is
     * appended by the controller after the flux completes.
     *
     * Uses [ChatService.generateChat] under the hood so session creation,
     * message persistence, conversation history, citation handling, title
     * generation, and quota enforcement all reuse the existing pipeline.
     */
    fun streamChatCompletion(
        userId: UUID,
        request: OpenAIChatCompletionRequest,
        sessionId: String?,
    ): Flux<String> {
        val (chatRequest, completionId) = buildChatRequest(userId, request, sessionId)
        val ndjsonFlux = chatService.generateChat(chatRequest, userId)
        val created = Instant.now().epochSecond
        var emittedRole = false

        // Each NDJSON line ({ind, obj:{type, …}}) becomes ONE
        // chat.completion.chunk event. Token packets land in delta.content;
        // every other packet (citation_info, research_report, chart_data,
        // plan_preview, clarification_questions, strategy_transparency,
        // image_attached, peer_review, …) lands in delta.scrapalot so the
        // Scrapalot UI can rebuild its rich rendering. Vanilla OpenAI
        // clients ignore unknown fields and see only the token stream.
        return ndjsonFlux
            .flatMap<String> { line ->
                val obj = extractObj(line) ?: return@flatMap Flux.empty<String>()
                val deltaContent =
                    (obj["type"] as? String)
                        ?.takeIf { it == "message_delta" || it == "bot_answer" }
                        ?.let { obj["content"] as? String }

                val out = mutableListOf<String>()
                if (!emittedRole) {
                    emittedRole = true
                    out += renderChunk(chunk(completionId, created, request.model, OpenAIDelta(role = "assistant")))
                }
                if (!deltaContent.isNullOrEmpty()) {
                    out += renderChunk(chunk(completionId, created, request.model, OpenAIDelta(content = deltaContent)))
                } else {
                    // Non-content packet — relay verbatim under delta.scrapalot.
                    out += renderChunk(chunk(completionId, created, request.model, OpenAIDelta(scrapalot = obj)))
                }
                Flux.fromIterable(out)
            }.concatWith(
                Flux.just(
                    renderChunk(
                        OpenAIChatCompletionChunk(
                            id = completionId,
                            created = created,
                            model = request.model,
                            choices =
                                listOf(
                                    OpenAIChunkChoice(
                                        delta = OpenAIDelta(),
                                        finishReason = "stop",
                                    )
                                ),
                        )
                    )
                )
            )
    }

    private fun chunk(
        id: String,
        created: Long,
        model: String,
        delta: OpenAIDelta
    ): OpenAIChatCompletionChunk =
        OpenAIChatCompletionChunk(
            id = id,
            created = created,
            model = model,
            choices = listOf(OpenAIChunkChoice(delta = delta)),
        )

    // ── /v1/chat/completions (non-streaming) ────────────────────────────────

    fun nonStreamChatCompletion(
        userId: UUID,
        request: OpenAIChatCompletionRequest,
        sessionId: String?,
    ): OpenAIChatCompletion {
        val (chatRequest, completionId) = buildChatRequest(userId, request, sessionId)
        val accumulated = StringBuilder()
        chatService
            .generateChat(chatRequest, userId)
            .toIterable()
            .forEach { line -> extractMessageDelta(line)?.let(accumulated::append) }

        return OpenAIChatCompletion(
            id = completionId,
            created = Instant.now().epochSecond,
            model = request.model,
            choices =
                listOf(
                    OpenAICompletionChoice(
                        message = OpenAIChatMessage(role = "assistant", content = accumulated.toString()),
                    )
                ),
        )
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private fun buildChatRequest(
        userId: UUID,
        request: OpenAIChatCompletionRequest,
        sessionId: String?,
    ): Pair<ChatRequest, String> {
        require(request.messages.isNotEmpty()) { "messages cannot be empty" }
        val lastUser = request.messages.last { it.role == "user" }
        val resolved = resolveModelSlug(request.model, userId)
        val extras =
            request.scrapalot ?: com.scrapalot.backend.dto.openai
                .ScrapalotExtras()

        // Pin the system provider for the OpenAI shim. The OpenAI `model`
        // field is consumed for routing (workspace/collection slug), so
        // there is no caller-supplied LLM. Falling back to the user's
        // default chat model via ModelProviderService.resolveModelForRequest
        // would fail when the user's default is incomplete (e.g. lmstudio
        // configured but model_name missing) — and "system" always works.
        //
        // `extras.mode` opts into the full native chat feature surface
        // (deep research, agentic, web search, tutor, ...); absent or
        // "rag" / "direct" yields the default (RAG with workspace /
        // collection from the slug + DirectLLM if no collection survives).
        val mode = extras.mode?.lowercase()
        val collectionIds = extras.collectionIds ?: listOfNotNull(resolved.collection?.id)
        val chatRequest =
            ChatRequest(
                prompt = lastUser.content,
                // Prefer the `Conversation-Id` header (external OpenAI clients); fall
                // back to scrapalot.session_id in the body (native web UI). Without
                // the fallback the web UI's session id never reached ChatService and
                // every message spawned a new session — the "session split" bug.
                sessionId = sessionId ?: extras.sessionId,
                workspaceId = extras.workspaceId ?: resolved.workspace.id,
                collectionIds = collectionIds,
                documentIds = extras.documentIds ?: emptyList(),
                savedSearchIds = extras.savedSearchIds ?: emptyList(),
                // Never hardcode the system model. Resolve it from the single source
                // of truth (the synced "Scrapalot AI" provider card); Python's
                // LLMManager also re-resolves "system" from system_agent_config, so a
                // null here is corrected server-side rather than pinned to a model.
                modelName = modelProviderService.getSystemProviderModelName() ?: "system-default",
                providerType = "system",
                language = extras.language ?: "en",
                webSearchEnabled = mode == "web_search",
                deepResearchEnabled = mode == "deep_research",
                deepSynthesisEnabled = extras.deepSynthesisEnabled ?: false,
                researchBreadth = extras.researchBreadth ?: 4,
                researchDepth = extras.researchDepth ?: 2,
                userMessageId = extras.userMessageId,
                similarityThreshold = extras.similarityThreshold ?: 0.5f,
                topK = extras.topK ?: 15,
                agenticRagEnabled = mode == "agentic",
                tutorMode = mode == "tutor",
                thoughtPartnerMode = mode == "thought_partner",
                sourcePreferences =
                    extras.sourcePreferences ?: mapOf(
                        "collections" to 0.6f,
                        "web_search" to 0.3f,
                        "direct_llm" to 0.1f,
                    ),
                minConfidenceThreshold = extras.minConfidenceThreshold ?: 0.6f,
                maxSources = extras.maxSources ?: 3,
                attachments = extras.attachments ?: emptyList(),
                clarificationAnswers = extras.clarificationAnswers ?: emptyList(),
                clarificationRequestId = extras.clarificationRequestId,
                approvedPlanId = extras.approvedPlanId,
                templateType = extras.templateType,
                councilEnabled = extras.councilEnabled,
                councilMembers = extras.councilMembers ?: emptyList(),
                researchMode = extras.researchMode,
                continueResearchPlanId = extras.continueResearchPlanId,
                continuationContext = extras.continuationContext,
                mentions = extras.mentions ?: emptyList(),
                promptTemplateName = extras.promptTemplateName,
                annotationColorFilter = extras.annotationColorFilter ?: emptyList(),
            )
        val completionId =
            "chatcmpl-" +
                UUID
                    .randomUUID()
                    .toString()
                    .replace("-", "")
                    .take(24)
        return chatRequest to completionId
    }

    /**
     * Parse a Scrapalot model slug. Accepts:
     *   - `scrapalot:<workspace-slug>`             → workspace, no collection
     *   - `scrapalot:<workspace-slug>:<col-slug>`  → workspace + collection
     *   - anything else                            → user's default workspace,
     *                                                no collection (DirectLLM)
     *
     * Throws NoSuchElementException (→ 404) when the slug is well-formed but
     * the workspace or collection is not visible to the user. Returns the
     * default workspace for unrecognised model strings (so OpenAI-tooling
     * defaults like `gpt-4o-mini` still route somewhere sensible).
     */
    fun resolveModelSlug(
        model: String,
        userId: UUID
    ): ResolvedSlug {
        val match =
            slugPattern.matchEntire(model.trim())
                ?: return ResolvedSlug(workspace = workspaceService.getDefaultWorkspace(userId), collection = null)

        val (wsSlug, colSlug) = match.destructured

        // `scrapalot:default` is the Scrapalot UI's placeholder — it does NOT
        // mean "workspace with slug='default'", it means "user's default
        // workspace". Resolve via WorkspaceService so users without a
        // literal slug=default workspace (the common case) still route.
        val workspace =
            if (wsSlug == "default") {
                workspaceService.getDefaultWorkspace(userId)
            } else {
                workspaceRepository.findBySlugAndUserId(wsSlug, userId)
                    ?: throw NoSuchElementException("Workspace '$wsSlug' not found or not accessible")
            }
        if (colSlug.isEmpty()) return ResolvedSlug(workspace = workspace, collection = null)

        val collection =
            collectionRepository.findBySlugAndWorkspaceId(colSlug, workspace.id!!)
                ?: throw NoSuchElementException("Collection '$colSlug' not found in workspace '$wsSlug'")
        return ResolvedSlug(workspace = workspace, collection = collection)
    }

    private fun extractMessageDelta(ndjsonLine: String): String? {
        val obj = extractObj(ndjsonLine) ?: return null
        return when (obj["type"]) {
            "message_delta", "bot_answer" -> obj["content"] as? String
            else -> null
        }
    }

    /** Pull the inner `obj` map out of an NDJSON line `{ind, obj}`. */
    private fun extractObj(ndjsonLine: String): Map<String, Any>? {
        val trimmed = ndjsonLine.trim()
        if (trimmed.isEmpty()) return null
        return runCatching {
            val wrapper = objectMapper.readValue<Map<String, Any>>(trimmed)
            @Suppress("UNCHECKED_CAST")
            wrapper["obj"] as? Map<String, Any>
        }.getOrNull()
    }

    private fun renderChunk(chunk: OpenAIChatCompletionChunk): String = "data: ${objectMapper.writeValueAsString(chunk)}\n\n"

    data class ResolvedSlug(
        val workspace: com.scrapalot.backend.domain.workspace.Workspace,
        val collection: com.scrapalot.backend.domain.collection.Collection?,
    )
}
