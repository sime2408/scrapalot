package com.scrapalot.backend.controller.ai

import com.scrapalot.backend.config.PromptsProperties
import com.scrapalot.backend.dto.AiGenerateRequest
import com.scrapalot.backend.service.AiGenerationService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.*
import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.security.SecurityRequirement
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import mu.KotlinLogging
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicLong

private val logger = KotlinLogging.logger {}

/**
 * REST controller for lightweight AI generation tasks powered by Spring AI.
 *
 * These endpoints call OpenAI directly from Kotlin (via a system provider API key)
 * without routing through Python gRPC. Use for simple generative tasks:
 * descriptions, suggestions, summaries, translations, "ask AI" features.
 */
@RestController
@RequestMapping("/api/v1/ai")
@Tag(name = "AI Generation", description = "Lightweight AI generation (Spring AI)")
@SecurityRequirement(name = "bearerAuth")
class AiGenerationController(
    private val userService: UserService,
    private val aiGenerationService: AiGenerationService,
    private val prompts: PromptsProperties,
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    /**
     * Generate AI response (non-streaming or streaming based on request.stream flag).
     */
    @PostMapping("/generate", produces = [MediaType.APPLICATION_JSON_VALUE, MediaType.APPLICATION_NDJSON_VALUE])
    @Operation(summary = "Generate AI response", description = "Generate text using Spring AI (non-streaming or streaming)")
    fun generate(
        @AuthenticationPrincipal userDetails: UserDetails,
        @Valid @RequestBody request: AiGenerateRequest
    ): ResponseEntity<*> {
        val userId = userDetails.userId()
        logger.info { "POST /ai/generate - userId: $userId, stream: ${request.stream}" }

        if (request.stream) {
            return streamResponse(request, userId)
        }

        return resultOf {
            aiGenerationService.generate(
                prompt = request.prompt,
                systemPrompt = request.systemPrompt,
                userId = userId,
                modelName = request.modelName,
                temperature = request.temperature,
                maxTokens = request.maxTokens
            )
        }.toResponseEntity()
    }

    /**
     * Generate a description for given content.
     */
    @PostMapping("/describe")
    @Operation(summary = "Generate description", description = "Generate a concise description for the given content")
    fun describe(
        @AuthenticationPrincipal userDetails: UserDetails,
        @RequestBody body: Map<String, String>
    ): ResponseEntity<Any> =
        resultOf {
            val userId = userDetails.userId()
            val content = requireNotNull(body["content"]) { "content is required" }
            val context = body["context"] ?: ""
            val language = body["language"] ?: "en"

            val template = prompts.generation.describe
            aiGenerationService.generate(
                prompt = template.user("language" to language, "context" to context, "content" to content),
                systemPrompt = template.system,
                userId = userId,
                maxTokens = 300
            )
        }.toResponseEntity()

    /**
     * Suggest improvements for given content.
     */
    @PostMapping("/suggest")
    @Operation(summary = "Suggest improvements", description = "Suggest improvements for the given content")
    fun suggest(
        @AuthenticationPrincipal userDetails: UserDetails,
        @RequestBody body: Map<String, String>
    ): ResponseEntity<Any> =
        resultOf {
            val userId = userDetails.userId()
            val content = requireNotNull(body["content"]) { "content is required" }
            val type = body["type"] ?: "general"
            val language = body["language"] ?: "en"

            val template = prompts.generation.suggest
            aiGenerationService.generate(
                prompt = template.user("type" to type, "language" to language, "content" to content),
                systemPrompt = template.system,
                userId = userId,
                maxTokens = 500
            )
        }.toResponseEntity()

    /**
     * Summarize given content.
     */
    @PostMapping("/summarize")
    @Operation(summary = "Summarize content", description = "Generate a summary of the given content")
    fun summarize(
        @AuthenticationPrincipal userDetails: UserDetails,
        @RequestBody body: Map<String, String>
    ): ResponseEntity<Any> =
        resultOf {
            val userId = userDetails.userId()
            val content = requireNotNull(body["content"]) { "content is required" }
            val length = body["length"] ?: "medium"
            val language = body["language"] ?: "en"

            val lengthInstruction =
                when (length) {
                    "short" -> "1-2 sentences"
                    "long" -> "3-5 paragraphs"
                    else -> "1 paragraph"
                }

            val template = prompts.generation.summarize
            aiGenerationService.generate(
                prompt = template.user("length_instruction" to lengthInstruction, "language" to language, "content" to content),
                systemPrompt = template.system,
                userId = userId,
                maxTokens = if (length == "long") 800 else 300
            )
        }.toResponseEntity()

    // ── Streaming helper ────────────────────────────────────────────────────────

    @Suppress("UastIncorrectHttpHeaderInspection")
    private fun streamResponse(
        request: AiGenerateRequest,
        userId: UUID
    ): ResponseEntity<StreamingResponseBody> {
        val streamCtx =
            aiGenerationService.generateStream(
                prompt = request.prompt,
                systemPrompt = request.systemPrompt,
                userId = userId,
                modelName = request.modelName,
                temperature = request.temperature,
                maxTokens = request.maxTokens
            )

        val body =
            StreamingResponseBody { outputStream ->
                val latch = CountDownLatch(1)
                val totalInput = AtomicLong(0)
                val totalOutput = AtomicLong(0)

                streamCtx.flux.subscribe(
                    { chatResponse ->
                        runCatching {
                            val text = chatResponse.result?.output?.text ?: ""
                            val usage = chatResponse.metadata?.usage
                            if (usage != null) {
                                totalInput.addAndGet(usage.promptTokens?.toLong() ?: 0L)
                                totalOutput.addAndGet(usage.completionTokens?.toLong() ?: 0L)
                            }
                            if (text.isNotEmpty()) {
                                val json = """{"type":"delta","content":"${text.escapeJson()}","model":"${streamCtx.model}"}""" + "\n"
                                outputStream.write(json.toByteArray(Charsets.UTF_8))
                                outputStream.flush()
                            }
                        }
                    },
                    { error ->
                        logger.error(error) { "AI stream error: ${error.message}" }
                        runCatching {
                            val json = """{"type":"error","content":"${(error.message ?: "Unknown error").escapeJson()}"}""" + "\n"
                            outputStream.write(json.toByteArray(Charsets.UTF_8))
                            outputStream.flush()
                        }
                        latch.countDown()
                    },
                    {
                        runCatching {
                            val json = """{"type":"done","model":"${streamCtx.model}","input_tokens":${totalInput.get()},"output_tokens":${totalOutput.get()}}""" + "\n"
                            outputStream.write(json.toByteArray(Charsets.UTF_8))
                            outputStream.flush()
                        }
                        aiGenerationService.trackTokenUsage(userId, totalInput.get(), totalOutput.get())
                        latch.countDown()
                    }
                )

                latch.await()
            }

        return ResponseEntity
            .ok()
            .contentType(MediaType("application", "x-ndjson"))
            .header("X-Accel-Buffering", "no")
            .header("Cache-Control", "no-cache, no-transform")
            .body(body)
    }
}
