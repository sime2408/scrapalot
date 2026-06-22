package com.scrapalot.backend.service

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.scrapalot.backend.domain.chat.Message
import com.scrapalot.backend.domain.chat.Session
import com.scrapalot.backend.dto.ChatAttachmentDTO
import com.scrapalot.backend.dto.ChatRequest
import com.scrapalot.backend.dto.ResolvedModel
import com.scrapalot.backend.grpc.ChatGrpcClient
import com.scrapalot.backend.grpc.DocumentExtrasGrpcClient
import com.scrapalot.backend.grpc.ResearchGrpcClient
import com.scrapalot.backend.grpc.chat.*
import com.scrapalot.backend.grpc.research.DeleteByMessageIdsRequest
import com.scrapalot.backend.repository.CollectionRepository
import com.scrapalot.backend.repository.MessageRepository
import com.scrapalot.backend.repository.SessionRepository
import com.scrapalot.backend.websocket.NotificationService
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.reactor.asFlux
import mu.KotlinLogging
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import reactor.core.publisher.Flux
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.util.NoSuchElementException
import java.util.UUID

private val logger = KotlinLogging.logger {}

/**
 * Chat orchestration service.
 *
 * Owns the full request lifecycle:
 * 1. Resolve model/provider via ModelProviderService
 * 2. Manage sessions (get or create)
 * 3. Manage messages (user and empty assistant)
 * 4. Handle message repeat/deletion
 * 5. Route to the correct Python gRPC RPC
 * 6. Accumulate the streamed response
 * 7. Update the assistant message with the final content
 * 8. Trigger background title generation
 */
@Service
class ChatService(
    private val chatGrpcClient: ChatGrpcClient,
    private val researchGrpcClient: ResearchGrpcClient,
    private val modelProviderService: ModelProviderService,
    private val subscriptionService: SubscriptionService,
    private val notificationService: NotificationService,
    private val sessionRepository: SessionRepository,
    private val messageRepository: MessageRepository,
    private val collectionRepository: CollectionRepository,
    private val documentExtrasGrpcClient: DocumentExtrasGrpcClient,
    private val sessionAttachmentService: SessionAttachmentService,
    private val objectMapper: ObjectMapper
) {
    private val titleScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /**
     * Generate a streaming chat response.
     *
     * This is the main entry point called by ChatController. It performs all
     *  orchestrations (model resolution, session/message management, routing)
     * and returns an NDJSON Flux for streaming to the client.
     *
     * The blocking calls in this function (JPA, subscriptions) run in a Spring MVC
     * thread (not a reactive scheduler), so the BlockingMethodInNonBlockingContext
     * and SpringTransactionalMethodCallsInspection warnings are false positives here.
     */
    @Suppress("BlockingMethodInNonBlockingContext", "SpringTransactionalMethodCallsInspection")
    fun generateChat(
        request: ChatRequest,
        userId: UUID
    ): Flux<String> {
        // 1. Resolve model and provider
        val resolved =
            modelProviderService.resolveModelForRequest(
                userId = userId,
                providerType = request.providerType,
                modelId = request.modelId,
                modelName = request.modelName
            ) ?: run {
                logger.error { "No model/provider resolved for user $userId" }
                return Flux.just(buildErrorPacket("No AI model configured. Please set up a model provider in settings."))
            }

        logger.info { "Resolved model: ${resolved.modelName} (provider: ${resolved.providerType})" }

        // 2. Get subscription tier
        val subscriptionTier = getSubscriptionTier(userId)

        // 2b. Pre-flight token quota check (system provider only)
        if (resolved.isSystemProvider) {
            val quotaCheck = subscriptionService.checkUsageLimit(userId, UsageType.TOKENS, 0)
            if (!quotaCheck.allowed) {
                return Flux.just(buildQuotaExceededPacket(quotaCheck))
            }
        }

        // 2c. Deep research requires a paid plan with the deep_research feature
        if (request.deepResearchEnabled && !subscriptionService.hasFeatureOrAdmin(userId, "deep_research")) {
            return Flux.just(buildFeatureNotAvailablePacket("deep_research", subscriptionTier))
        }

        // 3. Get or create a session
        val session = getOrCreateSession(userId, request.sessionId, request.collectionIds.firstOrNull())

        // 4. Handle message repeat (delete stale messages after the repeated one)
        if (request.userMessageId != null) {
            handleMessageRepeat(session.id, request.userMessageId)
        }

        // 5. Clean up incomplete assistant messages
        cleanupIncompleteAssistantMessages(session.id)

        // 6. Create a user message (with @mention metadata if present) and empty assistant message
        val userMetadata =
            if (request.mentions.isNotEmpty()) {
                mapOf("mentions" to request.mentions.map { mapOf("type" to it.type, "id" to it.id, "name" to it.name, "collectionName" to it.collectionName) })
            } else {
                null
            }
        createMessage(session.id, "user", request.prompt, request.userMessageId, userMetadata)
        val assistantMessage = createMessage(session.id, "assistant", "")

        // 7. Update session metadata (always set updatedAt to ensure dirty-check triggers SQL UPDATE)
        session.lastModelUsed = resolved.modelName
        session.updatedAt = LocalDateTime.now()
        sessionRepository.save(session)

        // 8. Start background title generation
        startTitleGeneration(session, request, resolved, userId, subscriptionTier)

        // 9. Build the session namespace for Python in-memory history
        val sessionNamespace = "$userId:${session.id}"

        // 10. Fetch recent conversation history to pass to Python (max 20 messages = 10 Q&A pairs)
        val isRepeat = request.userMessageId != null
        val conversationHistory = buildConversationHistory(session.id, limit = 20)

        // 10b. Persist any newly-attached documents to the session and load the
        // full sticky set, so attachments survive across messages (the client
        // sends a new attachment's text once; later turns reuse the stored copy).
        val effectiveAttachments = sessionAttachmentService.persistAndLoad(session.id, request.attachments, subscriptionTier)
        val effectiveRequest =
            if (effectiveAttachments.size != request.attachments.size) {
                request.copy(attachments = effectiveAttachments)
            } else {
                request
            }

        // 11. Route to the correct gRPC RPC and stream the response
        val packets =
            routeToGrpc(
                effectiveRequest,
                resolved,
                userId,
                sessionNamespace,
                assistantMessage.id.toString(),
                subscriptionTier,
                session.id.toString(),
                conversationHistory,
                isRepeat,
                session.collection?.workspaceId
            )

        // 11. Convert to NDJSON Flux with response accumulation
        return convertToNdjsonFlux(packets, assistantMessage.id, session.id)
    }

    /**
     * Route the chat request to the appropriate Python gRPC RPC based on request flags.
     *
     * Priority order (matches Python chat.py routing):
     * 1. Deep research (deep_research_enabled)
     * 2. Agentic RAG (agentic_rag_enabled)
     * 3. Web search (web_search_enabled)
     * 4. Document QA (single unprocessed document)
     * 5. Traditional RAG (collection_ids or document_ids present)
     * 6. Direct LLM (no collections, no special mode)
     */
    private fun buildRagRequest(
        request: ChatRequest,
        resolved: ResolvedModel,
        userId: UUID,
        sessionNamespace: String,
        subscriptionTier: String,
        conversationHistory: List<ConversationMessage>,
        isRepeat: Boolean,
    ): RAGRequest {
        val builder =
            RAGRequest
                .newBuilder()
                .setPrompt(request.prompt)
                .setUserId(userId.toString())
                .setModelName(resolved.modelName)
                .setProviderType(resolved.providerType)
                .addAllCollectionIds(request.collectionIds.map { it.toString() })
                .addAllDocumentIds(request.documentIds.map { it.toString() })
                .addAllSavedSearchIds(request.savedSearchIds.map { it.toString() })
                .setLanguage(request.language)
                .setSubscriptionTier(subscriptionTier)
                .setSimilarityThreshold(request.similarityThreshold ?: 0.5f)
                .setTopK(request.topK ?: 15)
                .setSessionNamespace(sessionNamespace)
                .addAllConversationHistory(conversationHistory)
                .setIsRepeat(isRepeat)
                .addAllAttachments(toProtoAttachments(request.attachments))
                .setTutorMode(request.tutorMode)
        request.promptTemplateName?.takeIf { it.isNotBlank() }?.let {
            builder.putMetadata("prompt_template_name", it)
        }
        if (request.deepSynthesisEnabled) builder.putMetadata("deep_synthesis_enabled", "true")
        request.annotationColorFilter
            .filter { it.isNotBlank() }
            .takeIf { it.isNotEmpty() }
            ?.let { builder.addAllAnnotationColorFilter(it) }
        return builder.build()
    }

    private fun routeToGrpc(
        request: ChatRequest,
        resolved: ResolvedModel,
        userId: UUID,
        sessionNamespace: String,
        assistantMessageId: String,
        subscriptionTier: String,
        sessionId: String,
        conversationHistory: List<ConversationMessage>,
        isRepeat: Boolean,
        sessionWorkspaceId: UUID? = null,
    ): Flow<ChatResponsePacket> =
        when {
            // 7.8 v3 — AI Tutor curriculum mode. When tutor_mode is
            // on AND exactly ONE collection is selected, route to the
            // dedicated GenerateChatTutor RPC which walks the user
            // through Leiden communities one lesson at a time.
            // Tutor + 0 collections → fall through to DirectLLM with
            // Socratic prepend (v1 behaviour). Tutor + 2+ collections
            // → fall through to RAG with Socratic prepend; multi-
            // collection curricula are a v4 stretch.
            request.tutorMode && request.collectionIds.size == 1 -> {
                logger.info { "Routing to TutorChat (curriculum mode, collection=${request.collectionIds[0]})" }
                chatGrpcClient.generateChatTutor(
                    TutorChatRequest
                        .newBuilder()
                        .setPrompt(request.prompt)
                        .setUserId(userId.toString())
                        .setModelName(resolved.modelName)
                        .setProviderType(resolved.providerType)
                        .setCollectionId(request.collectionIds[0].toString())
                        .setLanguage(request.language)
                        .setSubscriptionTier(subscriptionTier)
                        .setSessionNamespace(sessionNamespace)
                        .setAssistantMessageId(assistantMessageId)
                        .addAllConversationHistory(conversationHistory)
                        .setIsRepeat(isRepeat)
                        .build()
                )
            }

            // 7.7 — Thought Partner: pure questions-only mode. Force
            // DirectLLM regardless of collections / agentic toggle —
            // retrieval is intentionally skipped ("thought
            // partner is intentionally context-light").
            request.thoughtPartnerMode -> {
                logger.info { "Routing to Thought Partner (DirectLLM, no retrieval)" }
                chatGrpcClient.generateDirectLLM(
                    DirectLLMRequest
                        .newBuilder()
                        .setPrompt(request.prompt)
                        .setUserId(userId.toString())
                        .setModelName(resolved.modelName)
                        .setProviderType(resolved.providerType)
                        .setLanguage(request.language)
                        .setSubscriptionTier(subscriptionTier)
                        .setSessionNamespace(sessionNamespace)
                        .addAllConversationHistory(conversationHistory)
                        .setIsRepeat(isRepeat)
                        .addAllAttachments(toProtoAttachments(request.attachments))
                        .setThoughtPartnerMode(true)
                        .build()
                )
            }

            request.deepResearchEnabled -> {
                logger.info { "Routing to DeepResearch (breadth=${request.researchBreadth}, depth=${request.researchDepth})" }
                val builder =
                    DeepResearchRequest
                        .newBuilder()
                        .setPrompt(request.prompt)
                        .setUserId(userId.toString())
                        .setModelName(resolved.modelName)
                        .setProviderType(resolved.providerType)
                        .addAllCollectionIds(request.collectionIds.map { it.toString() })
                        .addAllDocumentIds(request.documentIds.map { it.toString() })
                        .addAllSavedSearchIds(request.savedSearchIds.map { it.toString() })
                        .setLanguage(request.language)
                        .setSubscriptionTier(subscriptionTier)
                        .setResearchBreadth(request.researchBreadth)
                        .setResearchDepth(request.researchDepth)
                        .setSessionNamespace(sessionNamespace)
                        .setAssistantMessageId(assistantMessageId)
                        .setSessionId(sessionId)
                        .addAllConversationHistory(conversationHistory)
                        .setIsRepeat(isRepeat)
                        .addAllAttachments(toProtoAttachments(request.attachments))
                // Pass clarification answers as metadata
                if (request.clarificationAnswers.isNotEmpty()) {
                    val answersJson =
                        com.fasterxml.jackson.module.kotlin
                            .jacksonObjectMapper()
                            .writeValueAsString(request.clarificationAnswers)
                    builder.putMetadata("clarification_answers", answersJson)
                    request.clarificationRequestId?.let { builder.putMetadata("clarification_request_id", it) }
                    logger.info { "Forwarding ${request.clarificationAnswers.size} clarification answers to Python" }
                }
                // Plan preview approval and research template
                request.approvedPlanId?.let { builder.putMetadata("approved_plan_id", it) }
                request.templateType?.let { builder.putMetadata("template_type", it) }
                // Council deliberation toggle
                if (request.councilEnabled == true) builder.putMetadata("council_enabled", "true")
                // Agentic Council roster (user-defined members) → Python parse_roster.
                if (request.councilMembers.isNotEmpty()) {
                    builder.putMetadata("council_members", objectMapper.writeValueAsString(request.councilMembers))
                    logger.info { "Forwarding ${request.councilMembers.size} custom council members to Python" }
                }
                // Research run mode → autonomous dispatches a durable background job in Python.
                request.researchMode?.takeIf { it.isNotBlank() }?.let { builder.putMetadata("research_mode", it) }
                // Continue researching from previous plan
                request.continueResearchPlanId?.let { builder.putMetadata("continue_research_plan_id", it) }
                request.continuationContext?.let { builder.putMetadata("continuation_context", it) }
                chatGrpcClient.generateDeepResearch(builder.build())
            }

            request.agenticRagEnabled -> {
                // Agentic RAG: auto-discovers collections when none specified (needs workspace_id)
                // Derive workspaceId from first collection, or use default workspace
                val workspaceId =
                    request.workspaceId
                        ?: request.collectionIds.firstOrNull()?.let { colId ->
                            collectionRepository.findById(colId).orElse(null)?.workspaceId
                        }
                        ?: sessionWorkspaceId
                logger.info { "Routing to AgenticRAG (maxSources=${request.maxSources}, workspaceId=$workspaceId)" }
                val agenticBuilder =
                    AgenticRAGRequest
                        .newBuilder()
                        .setPrompt(request.prompt)
                        .setUserId(userId.toString())
                        .setModelName(resolved.modelName)
                        .setProviderType(resolved.providerType)
                        .apply { workspaceId?.let { setWorkspaceId(it.toString()) } }
                        .addAllCollectionIds(request.collectionIds.map { it.toString() })
                        .addAllDocumentIds(request.documentIds.map { it.toString() })
                        .addAllSavedSearchIds(request.savedSearchIds.map { it.toString() })
                        .setLanguage(request.language)
                        .setSubscriptionTier(subscriptionTier)
                        .putAllSourcePreferences(request.sourcePreferences)
                        .setMinConfidenceThreshold(request.minConfidenceThreshold)
                        .setMaxSources(request.maxSources)
                        .setSessionNamespace(sessionNamespace)
                        .setAssistantMessageId(assistantMessageId)
                        .addAllConversationHistory(conversationHistory)
                        .setIsRepeat(isRepeat)
                        .addAllAttachments(toProtoAttachments(request.attachments))
                        .setTutorMode(request.tutorMode)
                request.promptTemplateName?.takeIf { it.isNotBlank() }?.let {
                    agenticBuilder.putMetadata("prompt_template_name", it)
                }
                if (request.deepSynthesisEnabled) agenticBuilder.putMetadata("deep_synthesis_enabled", "true")
                chatGrpcClient.generateAgenticRAG(agenticBuilder.build())
            }

            request.webSearchEnabled && request.collectionIds.isNotEmpty() -> {
                // Web search + collections: route to RAG, let Python decide hybrid mode
                logger.info { "Routing to RAG (hybrid web+collections, collections=${request.collectionIds.size})" }
                chatGrpcClient.generateRAG(buildRagRequest(request, resolved, userId, sessionNamespace, subscriptionTier, conversationHistory, isRepeat))
            }

            request.webSearchEnabled -> {
                // Web search only (no collections): pure web search
                logger.info { "Routing to WebSearch" }
                chatGrpcClient.generateWebSearch(
                    WebSearchRequest
                        .newBuilder()
                        .setPrompt(request.prompt)
                        .setUserId(userId.toString())
                        .setModelName(resolved.modelName)
                        .setProviderType(resolved.providerType)
                        .setLanguage(request.language)
                        .setSubscriptionTier(subscriptionTier)
                        .setSessionNamespace(sessionNamespace)
                        .setAssistantMessageId(assistantMessageId)
                        .addAllConversationHistory(conversationHistory)
                        .setIsRepeat(isRepeat)
                        .addAllAttachments(toProtoAttachments(request.attachments))
                        .setTutorMode(request.tutorMode)
                        .build()
                )
            }

            hasUnprocessedDocument(request) -> {
                val docId = request.documentIds.first().toString()
                logger.info { "Routing to DocumentQA (documentId=$docId)" }
                chatGrpcClient.generateDocumentQA(
                    DocumentQARequest
                        .newBuilder()
                        .setPrompt(request.prompt)
                        .setUserId(userId.toString())
                        .setModelName(resolved.modelName)
                        .setProviderType(resolved.providerType)
                        .setDocumentId(docId)
                        .setLanguage(request.language)
                        .setSubscriptionTier(subscriptionTier)
                        .setSessionNamespace(sessionNamespace)
                        .setAssistantMessageId(assistantMessageId)
                        .addAllAttachments(toProtoAttachments(request.attachments))
                        .build()
                )
            }

            request.collectionIds.isNotEmpty() || request.documentIds.isNotEmpty() || request.savedSearchIds.isNotEmpty() -> {
                logger.info { "Routing to RAG (collections=${request.collectionIds.size}, documents=${request.documentIds.size})" }
                chatGrpcClient.generateRAG(buildRagRequest(request, resolved, userId, sessionNamespace, subscriptionTier, conversationHistory, isRepeat))
            }

            else -> {
                logger.info { "Routing to DirectLLM" }
                // Pass the active workspace (request wins; falls back to the
                // session's collection workspace) so the no-collection direct
                // path can resolve the user's library and search it on demand.
                // A no-collection session has no workspace of its own, so the
                // request's active workspace is the reliable source.
                val directWorkspaceId = request.workspaceId ?: sessionWorkspaceId
                val directBuilder =
                    DirectLLMRequest
                        .newBuilder()
                        .setPrompt(request.prompt)
                        .setUserId(userId.toString())
                        .setModelName(resolved.modelName)
                        .setProviderType(resolved.providerType)
                        .setLanguage(request.language)
                        .setSubscriptionTier(subscriptionTier)
                        .setSessionNamespace(sessionNamespace)
                        .addAllConversationHistory(conversationHistory)
                        .setIsRepeat(isRepeat)
                        .addAllAttachments(toProtoAttachments(request.attachments))
                        .setTutorMode(request.tutorMode)
                        .setThoughtPartnerMode(request.thoughtPartnerMode)
                directWorkspaceId?.let { directBuilder.setWorkspaceId(it.toString()) }
                chatGrpcClient.generateDirectLLM(directBuilder.build())
            }
        }

    /**
     * Convert gRPC Flow<ChatResponsePacket> to Flux<String> (NDJSON).
     *
     * Accumulates the full response from content packets (message_delta, bot_answer)
     * and updates the assistant message in the database when the stream completes.
     * The blocking JPA calls here run via Reactor's doOnComplete/doOnError callbacks on IO threads.
     */
    @Suppress("BlockingMethodInNonBlockingContext", "SpringTransactionalMethodCallsInspection")
    private fun convertToNdjsonFlux(
        packets: Flow<ChatResponsePacket>,
        assistantMessageId: UUID,
        sessionId: UUID
    ): Flux<String> {
        val responseBuilder = StringBuilder()
        val citations = mutableListOf<Map<String, Any>>()
        val tokenMetrics = mutableMapOf<String, Any>()
        var researchReportData: Map<String, Any>? = null
        var chartData: Map<String, Any>? = null
        var searchStrategy: Map<String, Any>? = null
        var streamEndReason: String? = null
        // Accumulate the reasoning ("thinking") narration so the collapsible
        // thinking panel survives a page reload. Without this the content only
        // lived in frontend memory for the live session and vanished from
        // history. thinking_time_ms is wall-clock from the first reasoning beat
        // to stream end — the panel shows "Calculating..." forever if it's
        // absent, so it must be persisted alongside the content.
        val reasoningBuilder = StringBuilder()
        var reasoningStartMs: Long? = null
        val modelInsightBuilder = StringBuilder()

        return packets
            .map { packet ->
                // Accumulate content from content-bearing packets
                val packetType = packet.type
                if (packetType == "message_delta" || packetType == "bot_answer") {
                    extractContentDelta(packet.data)?.let { responseBuilder.append(it) }
                }

                // Accumulate reasoning narration for persistent thinking panel.
                if (packetType == "reasoning_delta") {
                    extractReasoning(packet.data)?.let {
                        if (reasoningStartMs == null) reasoningStartMs = System.currentTimeMillis()
                        // Concatenate verbatim — the Python emitter already bakes the
                        // separator into the payload (a trailing newline for narration
                        // beats, nothing for streamed=True sub-word tokens). Appending
                        // our own '\n' after every packet re-split DeepSeek reasoning
                        // tokens on reload ("gd je" instead of "gdje"); the live panel
                        // (frontend verbatim concat) was already correct.
                        reasoningBuilder.append(it)
                    }
                }

                // Accumulate the model-knowledge insight (own-knowledge reflection)
                // so the distinct "model insight" block survives on reloaded messages.
                if (packetType == "model_insight_delta") {
                    extractContentDelta(packet.data)?.let { modelInsightBuilder.append(it) }
                }

                // Collect citation data from citation packets.
                // Smart Citations: the backend re-emits each citation after
                // stance classification — merge by citation_num instead of
                // appending, otherwise the DB ends up with two rows per cite
                // (first without stance, second with).
                if (packetType == "citation_info") {
                    extractCitationInfo(packet.data)?.let { incoming ->
                        val num = incoming["citation_num"]
                        val existingIdx = citations.indexOfFirst { it["citation_num"] == num }
                        if (existingIdx == -1) {
                            citations.add(incoming)
                        } else {
                            // Merge: keep existing fields, overlay non-null from incoming
                            val merged = citations[existingIdx].toMutableMap()
                            for ((k, v) in incoming) merged[k] = v
                            citations[existingIdx] = merged
                        }
                    }
                } else if (packetType == "citation_delta") {
                    extractCitationDelta(packet.data)?.let { citations.addAll(it) }
                }

                // Extract token metrics from stream_end packet
                if (packetType == "stream_end") {
                    extractTokenMetrics(packet.data)?.let { tokenMetrics.putAll(it) }
                    extractStreamEndReason(packet.data)?.let { streamEndReason = it }
                }

                // Capture research_report for message metadata persistence
                if (packetType == "research_report") {
                    extractResearchReport(packet.data)?.let { report ->
                        researchReportData = report
                    }
                }

                // Capture chart_data for message metadata persistence
                if (packetType == "chart_data") {
                    extractChartData(packet.data)?.let { chartData = it }
                }

                // Capture strategy_transparency packet (sub-queries, filters,
                // sources, strategy name + rationale) so reloaded messages
                // still render the collapsible Search Strategy panel.
                // The name is distinct from the existing deep-research
                // `search_strategy` packet (different shape) to avoid clash.
                if (packetType == "strategy_transparency") {
                    extractSearchStrategy(packet.data)?.let { searchStrategy = it }
                }

                // Convert to NDJSON line (matching Python PacketEmitter format)
                buildNdjsonLine(packet)
            }.asFlux()
            .doOnComplete {
                val fullResponse = stripTrailingReferences(responseBuilder.toString())
                if (fullResponse.isNotBlank()) {
                    val metadataMap = mutableMapOf<String, Any>()
                    if (citations.isNotEmpty()) {
                        metadataMap["citations"] = citations
                        metadataMap["retrieval_results"] = citations.size
                    }
                    if (tokenMetrics.isNotEmpty()) {
                        metadataMap["token_metrics"] = tokenMetrics
                    }
                    researchReportData?.let { metadataMap["research_report"] = it }
                    chartData?.let { metadataMap["chart_data"] = it }
                    searchStrategy?.let { metadataMap["search_strategy"] = it }
                    if (reasoningBuilder.isNotBlank()) {
                        metadataMap["thinking_content"] = reasoningBuilder.toString()
                        reasoningStartMs?.let { metadataMap["thinking_time_ms"] = System.currentTimeMillis() - it }
                    }
                    if (modelInsightBuilder.isNotBlank()) {
                        metadataMap["model_insight_content"] = modelInsightBuilder.toString()
                    }
                    updateAssistantMessage(assistantMessageId, fullResponse, metadataMap.ifEmpty { null })
                } else {
                    // Empty content with a clean stream_end means the assistant produced a
                    // non-text artifact (plan preview, clarification questions, research setup)
                    // OR the stream was cancelled / errored before any message_delta arrived.
                    // Persist a status code so (a) cleanupIncompleteAssistantMessages doesn't
                    // delete the row on the next user turn, leaving two user rows back-to-back
                    // in history, and (b) the UI shows a localized line via status-message-parser
                    // when the user revisits the session.
                    val statusCode =
                        when (streamEndReason) {
                            "cancelled" -> "researchCancelled"
                            "clarification_needed" -> "clarificationPending"
                            "plan_preview_ready" -> "researchPlanReady"
                            // "error" AND any unrecognized reason with empty content is a
                            // failed / empty generation (e.g. a transient LLM error that still
                            // closed the stream cleanly). Persist a generic error status so the
                            // row is never left blank — otherwise it renders as an empty bubble,
                            // or cleanupIncompleteAssistantMessages (len < 10) deletes it on the
                            // next turn, leaving two user rows back-to-back in history.
                            else -> "streamingError"
                        }
                    updateAssistantMessageWithError(assistantMessageId, statusCode)
                }
                logger.debug { "Stream completed for session $sessionId (response length: ${fullResponse.length}, citations: ${citations.size}, reason: $streamEndReason)" }
            }.doOnError { error ->
                logger.error(error) { "Stream error for session $sessionId: ${error.message}" }
                // Persist a status code, not English. The frontend status-message-parser
                // resolves chat.status.streamingError → localized text in en/hr/mk.
                updateAssistantMessageWithError(assistantMessageId, "streamingError")
            }
    }

    // =========================================================================
    // Session management
    // =========================================================================

    /**
     * Get an existing session or create a new one.
     *
     * If sessionId is provided and belongs to the user, returns that session.
     * Otherwise, creates a new session with a temporary name.
     */
    @Transactional
    fun getOrCreateSession(
        userId: UUID,
        sessionId: String?,
        collectionId: UUID?
    ): Session {
        // Try to find existing session
        var clientProvidedId: UUID? = null
        if (!sessionId.isNullOrBlank()) {
            try {
                clientProvidedId = UUID.fromString(sessionId)
                val existing = sessionRepository.findByIdAndUserId(clientProvidedId, userId)
                if (existing.isPresent) {
                    logger.debug { "Using existing session: $clientProvidedId" }
                    return existing.get()
                }
                logger.debug { "Session $sessionId not found for user $userId, creating with client ID" }
            } catch (_: IllegalArgumentException) {
                logger.warn { "Invalid session ID format: $sessionId, creating new one" }
            }
        }

        // Create new session, preserving the client-provided ID if valid
        // Ensure the temporary name is unique per user (unique constraint on user_id + conversation_name)
        val baseName = "New Conversation..."
        val uniqueName =
            run {
                sessionRepository.findByUserIdAndConversationName(userId, baseName) ?: return@run baseName
                var counter = 2
                while (true) {
                    val candidate = "New Conversation... ($counter)"
                    if (sessionRepository.findByUserIdAndConversationName(userId, candidate) == null) return@run candidate
                    counter++
                }
                @Suppress("UNREACHABLE_CODE")
                baseName // unreachable, satisfies compiler
            }

        val session =
            Session(
                id = clientProvidedId ?: UUID.randomUUID(),
                userId = userId,
                collectionId = collectionId,
                conversationName = uniqueName
            )
        val saved = sessionRepository.save(session)
        logger.info { "Created new session: ${saved.id} for user $userId" }
        return saved
    }

    // =========================================================================
    // Message management
    // =========================================================================

    /**
     * Create a message in the database.
     *
     * If messageId is provided (repeat scenario), reuses that ID.
     */
    @Transactional
    fun createMessage(
        sessionId: UUID,
        role: String,
        content: String,
        messageId: UUID? = null,
        metadata: Map<String, Any>? = null
    ): Message {
        val message =
            Message(
                id = messageId ?: UUID.randomUUID(),
                sessionId = sessionId,
                sender = if (role == "user") "user" else "assistant",
                role = role,
                content = content,
                metadata = metadata,
            )

        // If this is a repeat (messageId provided), check if the message already exists
        if (messageId != null && messageRepository.existsById(messageId)) {
            val existing = messageRepository.findById(messageId).get()
            // Update content if it changed (user edited the message before repeating)
            if (existing.content != content && content.isNotBlank()) {
                val updated = existing.copy(content = content)
                messageRepository.save(updated)
                logger.info { "Updated content of repeated message $messageId" }
                return updated
            }
            logger.debug { "Message $messageId already exists, reusing for repeat" }
            return existing
        }

        // Duplicate detection: skip if an identical message was created within the last 5 seconds
        if (content.isNotBlank()) {
            val recentCutoff = LocalDateTime.now().minusSeconds(5)
            val recentMessages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId)
            val duplicate =
                recentMessages.lastOrNull {
                    it.role == role && it.content == content && it.createdAt.isAfter(recentCutoff)
                }
            if (duplicate != null) {
                logger.warn { "Duplicate message detected in session $sessionId, returning existing" }
                return duplicate
            }
        }

        val saved = messageRepository.save(message)
        logger.debug { "Created $role message: ${saved.id} in session $sessionId" }
        return saved
    }

    /**
     * Handle message repeat: delete all messages after the repeated user message.
     *
     * When a user repeats a message (clicks "regenerate"), we delete the old
     * assistant response and any later messages so the new response replaces them.
     */
    @Transactional
    fun handleMessageRepeat(
        sessionId: UUID,
        userMessageId: UUID
    ) {
        val messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId)
        val userMsgIndex = messages.indexOfFirst { it.id == userMessageId }

        if (userMsgIndex < 0 || userMsgIndex >= messages.size - 1) return

        val messagesToDelete = messages.subList(userMsgIndex + 1, messages.size)
        logger.info { "Repeating message — deleting ${messagesToDelete.size} messages after index $userMsgIndex" }

        // Clean up research plans linked to the messages being deleted (best-effort)
        val messageIds = messagesToDelete.map { it.id.toString() }
        if (messageIds.isNotEmpty()) {
            titleScope.launch {
                try {
                    val request =
                        DeleteByMessageIdsRequest
                            .newBuilder()
                            .addAllMessageIds(messageIds)
                            .build()
                    val response = researchGrpcClient.deleteByMessageIds(request)
                    if (response.deletedCount > 0) {
                        logger.info { "Cleaned up ${response.deletedCount} research plans for repeated messages" }
                    }
                } catch (e: Exception) {
                    logger.warn(e) { "Failed to clean up research plans on message repeat (non-critical)" }
                }
            }
        }

        messagesToDelete.forEach { messageRepository.delete(it) }
    }

    /**
     * Remove the last message in a session if it is an incomplete assistant response.
     *
     * This catches leftover empty assistant messages from previous failed generations.
     */
    @Transactional
    fun cleanupIncompleteAssistantMessages(sessionId: UUID) {
        val latest = messageRepository.findFirstBySessionIdOrderByCreatedAtDesc(sessionId)
        if (latest.isEmpty) return

        val lastMsg = latest.get()
        if (lastMsg.role == "assistant" && lastMsg.content.trim().length < 10) {
            logger.warn { "Found incomplete assistant message (length: ${lastMsg.content.length}), deleting it" }
            messageRepository.delete(lastMsg)
        }
    }

    /**
     * Update the assistant message with the full accumulated response and optional metadata.
     */
    @Transactional
    fun updateAssistantMessage(
        messageId: UUID,
        content: String,
        metadata: Map<String, Any>? = null
    ) {
        val message =
            messageRepository.findById(messageId).orElse(null) ?: run {
                logger.error { "Assistant message $messageId not found for update" }
                return
            }

        val updated = message.copy(content = content, metadata = metadata)
        messageRepository.save(updated)
        logger.info { "Updated assistant message $messageId (${content.length} chars, citations: ${(metadata?.get("retrieval_results") ?: 0)})" }
    }

    /**
     * Update the assistant message with an error placeholder.
     */
    @Transactional
    fun updateAssistantMessageWithError(
        messageId: UUID,
        errorMessage: String
    ) {
        val message = messageRepository.findById(messageId).orElse(null) ?: return
        val updated = message.copy(content = errorMessage)
        messageRepository.save(updated)
    }

    // =========================================================================
    // Title generation
    // =========================================================================

    /**
     * Ensure a conversation name is unique for the given user.
     * Appends "(2)", "(3)", etc. if the base title already exists.
     */
    private fun makeUniqueConversationName(
        baseTitle: String,
        userId: UUID
    ): String {
        if (sessionRepository.findByUserIdAndConversationName(userId, baseTitle) == null) return baseTitle
        var counter = 2
        while (counter <= 100) {
            val candidate = "$baseTitle ($counter)"
            if (sessionRepository.findByUserIdAndConversationName(userId, candidate) == null) return candidate
            counter++
        }
        // Extreme fallback — append timestamp
        return "$baseTitle (${System.currentTimeMillis()})"
    }

    /**
     * Start background title generation for the session.
     *
     * Only generates a title if:
     * - The session has no title or has a temporary title
     * - OR the first message was repeated with new content
     */
    private fun startTitleGeneration(
        session: Session,
        request: ChatRequest,
        resolved: ResolvedModel,
        userId: UUID,
        subscriptionTier: String
    ) {
        if (request.prompt.isBlank()) return

        val currentTitle = session.conversationName
        val isTemporaryTitle =
            currentTitle.isNullOrBlank() ||
                currentTitle.startsWith("New Conversation") ||
                currentTitle.endsWith("...")

        // Check if the first message was repeated with new content
        val isFirstMessageRepeat =
            request.userMessageId != null &&
                run {
                    val messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(session.id)
                    messages.isNotEmpty() && messages.first().id == request.userMessageId && messages.first().content != request.prompt
                }

        if (!isTemporaryTitle && !isFirstMessageRepeat) {
            logger.debug { "Session ${session.id} already has title '$currentTitle', skipping generation" }
            return
        }

        val sessionId = session.id
        titleScope.launch {
            try {
                val titleRequest =
                    TitleRequest
                        .newBuilder()
                        .setUserMessage(request.prompt)
                        .setModelName(resolved.modelName)
                        .setProviderType(resolved.providerType)
                        .setUserId(userId.toString())
                        .setSubscriptionTier(subscriptionTier)
                        .setLanguage(request.language)
                        .build()

                val response = chatGrpcClient.generateTitle(titleRequest)

                if (response.success && response.title.isNotBlank()) {
                    // Re-fetch session to avoid stale detached entity (HHH000502 warnings)
                    val freshSession = sessionRepository.findById(sessionId).orElse(null) ?: return@launch

                    // Deduplicate title if another session already has the same name for this user
                    val uniqueTitle = makeUniqueConversationName(response.title, userId)
                    freshSession.conversationName = uniqueTitle
                    sessionRepository.save(freshSession)
                    logger.info { "Generated title for session $sessionId: '$uniqueTitle'" }

                    // Notify frontend via WebSocket so it updates the sidebar title in real-time
                    val workspaceId =
                        freshSession.collectionId?.let { colId ->
                            collectionRepository.findById(colId).orElse(null)?.workspaceId
                        }
                    if (workspaceId != null) {
                        notificationService.sendEntityUpdate(
                            workspaceId = workspaceId,
                            entityType = "session",
                            entityId = sessionId,
                            action = "title_updated",
                            userId = userId,
                            data = mapOf("title" to uniqueTitle)
                        )
                    }
                } else {
                    logger.warn { "Title generation failed: ${response.error}" }
                }
            } catch (e: Exception) {
                logger.error(e) { "Background title generation failed for session $sessionId" }
            }
        }
    }

    // =========================================================================
    // Collection/document permission checks
    // =========================================================================

    /**
     * Verify the user has access to the requested collections.
     *
     * Each collection belongs to a workspace. The user must have access
     * to the workspace that owns each collection.
     */

    /**
     * 6.1 — image generation. Streams ChatResponsePacket from the Python
     * orchestrator through to the client as NDJSON without the heavy
     * session/message accumulation logic of generateChat — image artifacts are
     * already persisted on disk by the orchestrator and the
     * chat_message_attachments INSERT lands in M5 alongside cost tracking.
     */
    fun generateImage(
        request: com.scrapalot.backend.dto.GenerateImageRequest,
        userId: UUID
    ): Flux<String> {
        // Image generation burns paid image-model credits — Pro and above.
        // Same packet contract as the deep_research gate so the chat UI shows
        // the upgrade prompt instead of a broken stream.
        if (!subscriptionService.hasFeatureOrAdmin(userId, "image_generation")) {
            return Flux.just(buildFeatureNotAvailablePacket("image_generation", getSubscriptionTier(userId)))
        }
        val grpcRequest =
            GenerateImageRequest
                .newBuilder()
                .setUserId(userId.toString())
                .setPrompt(request.prompt)
                .setSize(request.size)
                .setN(request.n)
                .setQuality(request.quality)
                .setMessageId(request.messageId)
                .apply {
                    request.workspaceId?.let { setWorkspaceId(it.toString()) }
                    request.sessionId?.let { setSessionId(it) }
                    request.modelOverride?.let { setModelOverride(it) }
                }.build()

        logger.info { "generateImage: user=$userId, prompt=${request.prompt.take(80)}, size=${request.size}, n=${request.n}" }

        var packetIndex = 0
        return chatGrpcClient
            .generateImage(grpcRequest)
            .map { packet ->
                val payload = packet.data.ifEmpty { "{}" }
                val line = """{"ind":$packetIndex,"obj":$payload}""" + "\n"
                packetIndex += 1
                line
            }.asFlux()
    }

    fun checkCollectionPermissions(
        collectionIds: List<UUID>,
        @Suppress("UNUSED_PARAMETER") userId: UUID
    ) {
        for (collectionId in collectionIds) {
            // Access control is handled at the workspace level — the controller
            // layer should validate workspace access before calling this service.
            // For now, we just verify the collection exists.
            collectionRepository.findById(collectionId).orElse(null)
                ?: throw NoSuchElementException("Collection $collectionId not found")
        }
    }

    /**
     * Check if the request targets a single unprocessed document (for Document QA routing).
     */
    private fun hasUnprocessedDocument(request: ChatRequest): Boolean {
        if (request.documentIds.size != 1 || request.collectionIds.isNotEmpty()) return false

        val docId = request.documentIds.first()
        val response =
            runBlocking {
                documentExtrasGrpcClient.getDocument(docId.toString())
            }
        if (!response.found) return false
        return response.processingStatus in listOf("pending", "uploading", "failed")
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private fun toProtoAttachments(attachments: List<ChatAttachmentDTO>): List<ChatAttachment> =
        attachments.map { att ->
            ChatAttachment
                .newBuilder()
                .setType(att.type)
                .setFilename(att.filename)
                .setContent(att.content)
                .setMimeType(att.mimeType)
                .build()
        }

    private fun getSubscriptionTier(userId: UUID): String {
        val sub = subscriptionService.getUserSubscriptionWithPlan(userId)
        return sub?.second?.name ?: "free"
    }

    /**
     * Remove a trailing "References" / "Sources" / "Bibliography" section
     * (or its translated equivalent) that the LLM occasionally appends despite
     * prompt instructions. The UI renders citations in a dedicated list below
     * the message, so duplicating them inside the body — often as fake
     * `"[Various Sources]"` entries — is redundant and confusing.
     *
     * Matches a heading line followed by one or more bullet/quoted entries,
     * scoped to the END of the response only so in-text occurrences of these
     * words are preserved.
     */
    private val trailingReferenceSection =
        Regex(
            """(?i)\n+\s*(?:[-*_]{3,}\s*\n+\s*)?(?:#{1,6}\s*)?(?:\*\*)?\s*(?:References?|Sources?|Bibliography|Works\s+Cited|Citations|Referencije|Izvori|Referenser|Referencias|Bibliographie|参考文献|참고문헌)\s*[:：]?\s*(?:\*\*)?\s*\n[\s\S]*$"""
        )

    // Bare trailing horizontal rule (no heading after). LLM sometimes obeys
    // the "no References section" rule yet still emits a lone `---` as a
    // visual bottom separator — strip it so the Citation section below has no
    // duplicate divider above it.
    private val trailingHorizontalRule = Regex("""\n+\s*[-*_]{3,}\s*$""")

    private fun stripTrailingReferences(text: String): String {
        if (text.isBlank()) return text
        val afterRefs = trailingReferenceSection.replace(text, "")
        val stripped = trailingHorizontalRule.replace(afterRefs, "").trimEnd()
        // Safety: if the stripped version is less than 10% of the original,
        // we probably matched too aggressively — return original.
        return if (stripped.length < text.length * 0.1) text else stripped
    }

    /**
     * Extract content delta from a packet data JSON string.
     *
     * PacketEmitter format: {"type": "message_delta", "content": "token text"}
     */
    private fun extractContentDelta(data: String): String? =
        try {
            val parsed = objectMapper.readValue<Map<String, Any>>(data)
            parsed["content"] as? String
        } catch (_: Exception) {
            null
        }

    /**
     * Extract citation info from a citation_info packet.
     *
     * Persists the full citation payload — text/excerpt, stance (Scite Smart
     * Citations), URL, authors, year, formatted_citation — so the UI can
     * render citation content and stance badges after a reload, not just during
     * the live stream.
     */
    private fun extractCitationInfo(data: String): Map<String, Any>? =
        runCatching {
            val parsed = objectMapper.readValue<Map<String, Any>>(data)
            val fields =
                listOf(
                    "citation_num",
                    "document_id",
                    "document_title",
                    "page",
                    "url",
                    "score",
                    "text",
                    "chunk_index",
                    "file_type",
                    "authors",
                    "year",
                    "formatted_citation",
                    // Smart Citations (Scite integration) — nullable, only present
                    // on the second emitting after stance classification completes.
                    "stance",
                    "stance_confidence",
                    "stance_rationale",
                    // chunk_position_json carries {page, char_offset_start,
                    // char_offset_end, bbox} so a click on a citation chip after
                    // page reload can still scroll-and-pulse to the exact passage.
                    // Without persisting this field, the transient highlight only
                    // fires during the live stream.
                    "chunk_position_json"
                )
            buildMap {
                for (f in fields) parsed[f]?.let { put(f, it) }
            }
        }.getOrNull()

    /**
     * Extract citations from a citation_delta packet (batch).
     *
     * PacketEmitter format: {"type": "citation_delta", "citations": [{...}, ...]}
     */
    @Suppress("UNCHECKED_CAST")
    private fun extractCitationDelta(data: String): List<Map<String, Any>>? =
        try {
            val parsed = objectMapper.readValue<Map<String, Any>>(data)
            parsed["citations"] as? List<Map<String, Any>>
        } catch (_: Exception) {
            null
        }

    /**
     * Extract token metrics from a stream_end packet.
     *
     * PacketEmitter format: {"type": "stream_end", "input_tokens": 100, "output_tokens": 50, ...}
     */

    /**
     * Extract the header fields of a research_report packet so the chat
     * message UI can render the "View full report" chip immediately on
     * reload (title, quality, sources, word count, plan id, executive
     * summary). The full markdown body is deliberately NOT persisted into
     * message metadata — it can be 10-100 KB of markdown that makes the
     * `/sessions/{id}/messages` response bloat and slow down mobile reloads.
     * The UI lazy-fetches the full body via
     * `GET /api/v1/research/by-plan/{planId}` → `synthesis.main_content`
     * when the user actually opens the viewer.
     */
    private fun extractResearchReport(data: String): Map<String, Any>? =
        try {
            val parsed = objectMapper.readValue<Map<String, Any>>(data)
            buildMap {
                parsed["title"]?.let { put("title", it) }
                parsed["plan_id"]?.let { put("plan_id", it) }
                parsed["quality_score"]?.let { put("quality_score", it) }
                parsed["total_sources"]?.let { put("total_sources", it) }
                parsed["word_count"]?.let { put("word_count", it) }
                parsed["executive_summary"]?.let { put("executive_summary", it) }
            }.ifEmpty { null }
        } catch (_: Exception) {
            null
        }

    private fun extractStreamEndReason(data: String): String? =
        try {
            val parsed = objectMapper.readValue<Map<String, Any>>(data)
            parsed["reason"]?.toString()
        } catch (_: Exception) {
            null
        }

    /**
     * Extract reasoning text from a reasoning_delta packet. Python emits the
     * thinking narration in the `reasoning` field (see ReasoningDeltaPacket).
     */
    private fun extractReasoning(data: String): String? =
        try {
            val parsed = objectMapper.readValue<Map<String, Any>>(data)
            (parsed["reasoning"] as? String)?.takeIf { it.isNotBlank() }
        } catch (_: Exception) {
            null
        }

    private fun extractTokenMetrics(data: String): Map<String, Any>? =
        try {
            val parsed = objectMapper.readValue<Map<String, Any>>(data)
            buildMap {
                parsed["input_tokens"]?.let { put("input_tokens", it) }
                parsed["output_tokens"]?.let { put("output_tokens", it) }
                parsed["total_tokens"]?.let { put("total_tokens", it) }
                parsed["tokens_per_second"]?.let { put("tokens_per_second", it) }
                parsed["cost_usd"]?.let { put("cost_usd", it) }
                parsed["latency_ms"]?.let { put("latency_ms", it) }
                parsed["provider"]?.let { put("provider", it) }
                parsed["model"]?.let { put("model", it) }
            }.ifEmpty { null }
        } catch (_: Exception) {
            null
        }

    private fun extractChartData(data: String): Map<String, Any>? =
        try {
            val parsed = objectMapper.readValue<Map<String, Any>>(data)
            buildMap {
                parsed["chart_type"]?.let { put("chart_type", it) }
                parsed["title"]?.let { put("title", it) }
                parsed["labels"]?.let { put("labels", it) }
                parsed["datasets"]?.let { put("datasets", it) }
                parsed["x_label"]?.let { put("x_label", it) }
                parsed["y_label"]?.let { put("y_label", it) }
            }.ifEmpty { null }
        } catch (_: Exception) {
            null
        }

    private fun extractSearchStrategy(data: String): Map<String, Any>? =
        try {
            val parsed = objectMapper.readValue<Map<String, Any>>(data)
            buildMap {
                parsed["sub_queries"]?.let { put("sub_queries", it) }
                parsed["filters_applied"]?.let { put("filters_applied", it) }
                parsed["sources_queried"]?.let { put("sources_queried", it) }
                parsed["strategy_name"]?.let { put("strategy_name", it) }
                parsed["rationale"]?.let { put("rationale", it) }
            }.ifEmpty { null }
        } catch (_: Exception) {
            null
        }

    /**
     * Build an NDJSON line from a ChatResponsePacket.
     *
     * Output format: {"ind": <index>, "obj": {"type": "<type>", ...data}}
     */
    private fun buildNdjsonLine(packet: ChatResponsePacket): String =
        try {
            val dataObj = objectMapper.readValue<Map<String, Any>>(packet.data)
            val wrapper =
                mapOf(
                    "ind" to packet.index,
                    "obj" to dataObj
                )
            objectMapper.writeValueAsString(wrapper) + "\n"
        } catch (_: Exception) {
            val wrapper =
                mapOf(
                    "ind" to packet.index,
                    "obj" to mapOf("type" to packet.type, "content" to packet.data)
                )
            objectMapper.writeValueAsString(wrapper) + "\n"
        }

    /**
     * Build an error packet in NDJSON format.
     */
    @Suppress("SameParameterValue")
    private fun buildErrorPacket(message: String): String {
        val wrapper =
            mapOf(
                "ind" to 0,
                "obj" to mapOf("type" to "error", "content" to message)
            )
        return objectMapper.writeValueAsString(wrapper) + "\n"
    }

    /**
     * Build a quota exceeded error packet with error_code for frontend i18n.
     */
    private fun buildQuotaExceededPacket(quotaCheck: UsageLimitResult): String {
        val obj =
            mutableMapOf<String, Any>(
                "type" to "error",
                "error_code" to "tokenQuotaExceeded",
                "content" to (quotaCheck.message ?: "Token quota exceeded")
            )
        val quotaInfo =
            mutableMapOf<String, Any>(
                "current_usage" to quotaCheck.currentUsage,
                "limit" to quotaCheck.limit
            )
        quotaCheck.suggestedPlan?.let { quotaInfo["suggested_plan"] = it }
        obj["quota_info"] = quotaInfo

        val wrapper = mapOf("ind" to 0, "obj" to obj)
        return objectMapper.writeValueAsString(wrapper) + "\n"
    }

    /**
     * Build a feature-not-available error packet with error_code for frontend i18n.
     *
     * Returned when a user tries to use a feature (e.g., deep research) that their
     * subscription plan does not include.
     */
    @Suppress("SameParameterValue")
    private fun buildFeatureNotAvailablePacket(
        featureName: String,
        currentPlan: String
    ): String {
        val obj =
            mapOf(
                "type" to "error",
                "error_code" to "featureNotAvailable",
                "content" to "The $featureName feature is not available on your current plan ($currentPlan). Please upgrade to access this feature.",
                "feature" to featureName,
                "current_plan" to currentPlan,
                "suggested_plan" to "pro"
            )
        val wrapper = mapOf("ind" to 0, "obj" to obj)
        return objectMapper.writeValueAsString(wrapper) + "\n"
    }

    /**
     * Fetch the most recent messages for a session and convert them to gRPC ConversationMessage format.
     *
     * Only non-empty messages are included (skips placeholder empty assistant messages).
     * The new (empty) assistant message has already been created but not yet saved with content,
     * so the history correctly ends with the user's new prompt being excluded from the history list —
     * Kotlin creates the user message before calling this, so it IS included as the last entry.
     */
    @Suppress("SameParameterValue")
    private fun buildConversationHistory(
        sessionId: UUID,
        limit: Int = 20
    ): List<ConversationMessage> {
        val messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId)
        return messages
            .filter { it.content.isNotBlank() }
            .takeLast(limit)
            .map { msg ->
                ConversationMessage
                    .newBuilder()
                    .setRole(msg.role)
                    .setContent(msg.content)
                    .setCreatedAtEpoch(msg.createdAt.toEpochSecond(ZoneOffset.UTC))
                    .build()
            }
    }
}
