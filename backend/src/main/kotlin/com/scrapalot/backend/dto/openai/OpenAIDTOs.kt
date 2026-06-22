package com.scrapalot.backend.dto.openai

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonProperty

/**
 * Wire shapes for the OpenAI-compatible API surface.
 *
 * Matches OpenAI API "v1" as of 2024-01-25: `chat.completions`, `chat.completion`,
 * `chat.completion.chunk`, `model`, `list`. Stable for ~2 years; pinned in
 * docs/README_OPENAI_COMPAT.md so changes here are intentional.
 *
 * Field naming: this project's Jackson is globally `PropertyNamingStrategies.
 * SNAKE_CASE`, so camelCase Kotlin properties serialize as snake_case JSON
 * (matching OpenAI's wire format). Where the OpenAI spec name diverges from
 * what camelCase→snake_case would produce, an explicit @JsonProperty pins it.
 */

// ── Request ─────────────────────────────────────────────────────────────────

/**
 * Inbound request body for `POST /v1/chat/completions`. Mirrors the OpenAI
 * Python SDK's `chat.completions.create()` payload.
 *
 * `model` carries the Scrapalot routing slug:
 *   - `scrapalot:<workspace-slug>`               → RAG over the whole workspace
 *   - `scrapalot:<workspace-slug>:<col-slug>`    → RAG over one collection
 *   - bare model names (`gpt-4o-mini`, etc.)     → DirectLLM via the user's
 *                                                  default workspace
 */
data class OpenAIChatCompletionRequest(
    val model: String,
    val messages: List<OpenAIChatMessage>,
    val stream: Boolean = false,
    val temperature: Double? = null,
    val topP: Double? = null,
    val n: Int? = null,
    val maxTokens: Int? = null,
    val stop: Any? = null,
    val user: String? = null,
    // Scrapalot extension. The openai-python SDK lets callers pass arbitrary
    // top-level fields via `extra_body={"scrapalot": {...}}`; openai-js
    // accepts the same JSON. Vanilla OpenAI clients omit this and get
    // basic RAG / DirectLLM. Setting `scrapalot.mode` opts into the full
    // native chat feature surface (deep research, agentic, web search,
    // tutor, document QA, attachments, mentions, …).
    val scrapalot: ScrapalotExtras? = null,
)

/**
 * Top-level extension block for OpenAI-compatible requests. Mirrors the
 * native [com.scrapalot.backend.dto.ChatRequest] field-for-field; everything
 * here is optional so omitting the block is equivalent to `mode = "rag"`
 * with default tuning.
 *
 * Mode → routing matrix (matches [com.scrapalot.backend.service.ChatService]
 * `routeToGrpc` priority order):
 *   - `deep_research`   → DeepResearchRequest (5-phase planner pipeline)
 *   - `agentic`         → AgenticRAGRequest   (multi-source orchestration)
 *   - `web_search`      → WebSearchRequest    (or RAG if collections set)
 *   - `tutor`           → ChatTutorRequest    (curriculum walk; 1 collection)
 *   - `thought_partner` → DirectLLMRequest    (probing-questions persona)
 *   - `document_qa`     → DocumentQARequest   (single unprocessed doc)
 *   - `rag` / null      → RAGRequest          (default — collections / docs / saved searches)
 *   - `direct`          → DirectLLMRequest    (no retrieval)
 */
data class ScrapalotExtras(
    val mode: String? = null,
    // Conversation continuity for the native web UI, which sends the session id
    // in the body (scrapalot.session_id) rather than the `Conversation-Id`
    // header used by external OpenAI clients. Without this the session id was
    // silently dropped on deserialization and ChatService minted a brand-new
    // session for EVERY message — splitting every follow-up into its own
    // conversation and losing history. buildChatRequest falls back to this when
    // the header is absent.
    val sessionId: String? = null,
    val collectionIds: List<java.util.UUID>? = null,
    val documentIds: List<java.util.UUID>? = null,
    val savedSearchIds: List<java.util.UUID>? = null,
    val workspaceId: java.util.UUID? = null,
    val researchBreadth: Int? = null,
    val researchDepth: Int? = null,
    val approvedPlanId: String? = null,
    val templateType: String? = null,
    val councilEnabled: Boolean? = null,
    // Agentic Council roster (user-defined members) from the web UI's
    // scrapalot extras. Without this field the roster was silently dropped on
    // deserialization, so a custom multi-model council never reached Python and
    // always fell back to the default archetypes.
    val councilMembers: List<com.scrapalot.backend.dto.CouncilMemberDTO>? = null,
    // Research run mode ("autonomous" → durable background job in Python).
    val researchMode: String? = null,
    val continueResearchPlanId: String? = null,
    val continuationContext: String? = null,
    val clarificationAnswers: List<com.scrapalot.backend.dto.ClarificationAnswerDTO>? = null,
    val clarificationRequestId: String? = null,
    val sourcePreferences: Map<String, Float>? = null,
    val minConfidenceThreshold: Float? = null,
    val maxSources: Int? = null,
    val attachments: List<com.scrapalot.backend.dto.ChatAttachmentDTO>? = null,
    val mentions: List<com.scrapalot.backend.dto.MentionDTO>? = null,
    val similarityThreshold: Float? = null,
    val topK: Int? = null,
    val annotationColorFilter: List<String>? = null,
    val promptTemplateName: String? = null,
    val language: String? = null,
    val userMessageId: java.util.UUID? = null,
    // "Thinking" toggle: append a thinking-model own-knowledge reflection
    // (reasoning panel + a distinct "model insight" block) after the answer.
    val deepSynthesisEnabled: Boolean? = null,
)

data class OpenAIChatMessage(
    val role: String, // "system" | "user" | "assistant" | "tool"
    val content: String, // we only support plain string content in v1
    val name: String? = null,
)

// ── Streaming response (chat.completion.chunk) ──────────────────────────────

@JsonInclude(JsonInclude.Include.NON_NULL)
data class OpenAIChatCompletionChunk(
    val id: String,
    @get:JsonProperty("object") val objectType: String = "chat.completion.chunk",
    val created: Long,
    val model: String,
    val choices: List<OpenAIChunkChoice>,
)

@JsonInclude(JsonInclude.Include.NON_NULL)
data class OpenAIChunkChoice(
    val index: Int = 0,
    val delta: OpenAIDelta,
    val finishReason: String? = null, // "stop" | "length" | null
)

@JsonInclude(JsonInclude.Include.NON_NULL)
data class OpenAIDelta(
    val role: String? = null,
    val content: String? = null,
    // Scrapalot extension carrying any non-token packet (citation_info,
    // research_report, chart_data, plan_preview, clarification_questions,
    // strategy_transparency, image_attached, peer_review, …). Vanilla
    // OpenAI clients ignore unknown fields per the spec, so this is
    // safe to emit on every chunk that carries non-content payload.
    // Shape mirrors the native NDJSON `obj` (PacketEmitter output).
    val scrapalot: Map<String, Any>? = null,
)

// ── Non-streaming response (chat.completion) ────────────────────────────────

@JsonInclude(JsonInclude.Include.NON_NULL)
data class OpenAIChatCompletion(
    val id: String,
    @get:JsonProperty("object") val objectType: String = "chat.completion",
    val created: Long,
    val model: String,
    val choices: List<OpenAICompletionChoice>,
    val usage: OpenAIUsage? = null,
)

@JsonInclude(JsonInclude.Include.NON_NULL)
data class OpenAICompletionChoice(
    val index: Int = 0,
    val message: OpenAIChatMessage,
    val finishReason: String = "stop",
)

@JsonInclude(JsonInclude.Include.NON_NULL)
data class OpenAIUsage(
    val promptTokens: Int = 0,
    val completionTokens: Int = 0,
    val totalTokens: Int = 0,
)

// ── /v1/models ──────────────────────────────────────────────────────────────

@JsonInclude(JsonInclude.Include.NON_NULL)
data class OpenAIModel(
    val id: String,
    @get:JsonProperty("object") val objectType: String = "model",
    val created: Long,
    val ownedBy: String = "scrapalot",
)

@JsonInclude(JsonInclude.Include.NON_NULL)
data class OpenAIModelsResponse(
    @get:JsonProperty("object") val objectType: String = "list",
    val data: List<OpenAIModel>,
)

// ── Errors (OpenAI-shaped error envelope) ───────────────────────────────────

@JsonInclude(JsonInclude.Include.NON_NULL)
data class OpenAIErrorEnvelope(
    val error: OpenAIError
)

@JsonInclude(JsonInclude.Include.NON_NULL)
data class OpenAIError(
    val message: String,
    val type: String,
    val code: String? = null,
    val param: String? = null,
)
