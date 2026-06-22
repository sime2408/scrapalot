package com.scrapalot.backend.dto

import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import java.util.UUID

/**
 * Chat request DTO received from the frontend.
 *
 * Kotlin ChatService uses these fields to route to the correct Python gRPC RPC
 * and build mode-specific gRPC request messages.
 */
data class ChatRequest(
    @field:NotBlank(message = "Prompt is required")
    @field:Size(max = 100_000, message = "Prompt cannot exceed 100,000 characters")
    val prompt: String,
    val sessionId: String? = null,
    val workspaceId: UUID? = null,
    val collectionIds: List<UUID> = emptyList(),
    val documentIds: List<UUID> = emptyList(),
    val savedSearchIds: List<UUID> = emptyList(),
    val modelId: String? = null,
    val modelName: String? = null,
    val providerType: String? = null,
    val language: String = "en",
    val webSearchEnabled: Boolean = false,
    val deepResearchEnabled: Boolean = false,
    // "Thinking" toggle → append a thinking-model own-knowledge reflection after the answer.
    val deepSynthesisEnabled: Boolean = false,
    val researchBreadth: Int = 4,
    val researchDepth: Int = 2,
    val userMessageId: UUID? = null,
    val similarityThreshold: Float? = 0.5f,
    val topK: Int? = 15,
    // Agentic RAG configuration
    val agenticRagEnabled: Boolean = false,
    // 7.8 v1 — AI Tutor Mode. Server prepends Socratic-tutor
    // instructions to the user prompt before calling the LLM (RAG
    // retrieval still uses the raw question).
    val tutorMode: Boolean = false,
    // 7.7 — Thought Partner Mode. Routes to DirectLLM with a
    // questions-only system prompt; the LLM probes the user's
    // reasoning instead of answering. Mutually exclusive with
    // tutorMode in the UI.
    val thoughtPartnerMode: Boolean = false,
    val sourcePreferences: Map<String, Float> =
        mapOf(
            "collections" to 0.6f,
            "web_search" to 0.3f,
            "direct_llm" to 0.1f
        ),
    val minConfidenceThreshold: Float = 0.6f,
    val maxSources: Int = 3,
    // File attachments (documents, images, YouTube)
    val attachments: List<ChatAttachmentDTO> = emptyList(),
    // Deep Research v1: Clarification answers
    val clarificationAnswers: List<ClarificationAnswerDTO> = emptyList(),
    val clarificationRequestId: String? = null,
    // Deep Research v1: Plan preview + templates
    val approvedPlanId: String? = null,
    val templateType: String? = null,
    // Council deliberation toggle
    val councilEnabled: Boolean? = null,
    // Agentic Council roster (user-defined members). Forwarded to Python as
    // gRPC metadata['council_members'] (JSON). >=2 members → multi-model
    // deliberation; empty → default 12-archetype council.
    val councilMembers: List<CouncilMemberDTO> = emptyList(),
    // Research run mode. "autonomous" dispatches a durable background job
    // (Python lifts the orchestrator off the gRPC stream); null/other = inline.
    // Forwarded to Python as gRPC metadata['research_mode'].
    val researchMode: String? = null,
    // Continue researching from previous plan
    val continueResearchPlanId: String? = null,
    val continuationContext: String? = null,
    // @-mentioned documents/collections (persisted in message metadata for history)
    val mentions: List<MentionDTO> = emptyList(),
    // Settings → Prompts → Custom Templates picker (chat toolbar popover).
    // Template name is forwarded to Python via gRPC metadata where Layer 6
    // of the system-prompt builder resolves the body from
    // user_settings.prompt_templates.
    val promptTemplateName: String? = null,
    // Annotation color filter (chat toolbar chip row). Hex codes only,
    // e.g. ["#ffd400", "#ff6666"]. Empty = no filter, no boost.
    val annotationColorFilter: List<String> = emptyList(),
)

data class MentionDTO(
    val type: String = "", // "collection" | "document"
    val id: String = "",
    val name: String = "",
    val collectionName: String? = null,
)

data class ClarificationAnswerDTO(
    val question: String = "",
    val answer: String = "",
)

// One user-defined Research Council member. Forwarded verbatim (as JSON) to
// Python, where AgentDefinition/parse_roster consumes name/role/model/stance.
data class CouncilMemberDTO(
    val name: String = "",
    val role: String? = null,
    val model: String? = null, // optional "provider:model" override; null = system model
    val stance: String? = null,
)

/**
 * 6.1 — Image generation request from the frontend "Generate Image" composer.
 * Routes to ChatGrpcClient.generateImage which streams ChatResponsePacket
 * (status + image_attached × n + stream_end) back as NDJSON.
 *
 * ``message_id`` is the assistant message UUID the UI created up-front so the
 * placeholder card can be replaced when image_attached packets arrive.
 */
data class GenerateImageRequest(
    @field:NotBlank(message = "Prompt is required")
    @field:Size(max = 4_000, message = "Prompt cannot exceed 4,000 characters")
    val prompt: String,
    val workspaceId: UUID? = null,
    val sessionId: String? = null,
    @field:NotBlank(message = "message_id is required")
    val messageId: String,
    val size: String = "1024x1024",
    val n: Int = 1,
    val quality: String = "standard",
    val modelOverride: String? = null,
)

data class ChatAttachmentDTO(
    val type: String = "",
    val filename: String = "",
    val content: String = "",
    val mimeType: String = ""
)

/**
 * Lightweight view of a persisted session attachment for the UI chip bar —
 * metadata only, never the full [SessionAttachment.content] (which can be
 * hundreds of KB). The chip only needs the filename, type and a size hint.
 */
data class SessionAttachmentDTO(
    val id: UUID,
    val type: String,
    val filename: String,
    val mimeType: String?,
    val charCount: Int?,
    val createdAt: java.time.LocalDateTime
)
