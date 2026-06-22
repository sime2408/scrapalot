package com.scrapalot.backend.controller.openai

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.dto.openai.OpenAIChatCompletionRequest
import com.scrapalot.backend.dto.openai.OpenAIError
import com.scrapalot.backend.dto.openai.OpenAIErrorEnvelope
import com.scrapalot.backend.dto.openai.OpenAIModelsResponse
import com.scrapalot.backend.service.OpenAICompatibleService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.authenticatedUserId
import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.security.SecurityRequirement
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import mu.KotlinLogging
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody
import reactor.core.publisher.BaseSubscriber
import java.io.IOException
import java.util.NoSuchElementException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean

private val logger = KotlinLogging.logger {}

@Suppress("UastIncorrectHttpHeaderInspection")
private const val HEADER_X_ACCEL_BUFFERING = "X-Accel-Buffering"
private const val HEADER_CONVERSATION_ID = "Conversation-Id"
private const val SSE_DONE = "data: [DONE]\n\n"

/**
 * OpenAI-compatible REST surface.
 *
 * Lets any OpenAI-SDK client (Python, JS, LangChain, Zapier, n8n, third-party
 * IDEs) target Scrapalot as if it were OpenAI:
 *
 *     from openai import OpenAI
 *     client = OpenAI(base_url="https://scrapalot.app/api/v1", api_key="scp-...")
 *     client.chat.completions.create(model="scrapalot:my-workspace", ...)
 *
 * Authentication is via `Authorization: Bearer scp-...` (handled by
 * [com.scrapalot.backend.security.ApiKeyAuthenticationFilter]). Conversation
 * continuity across requests is opt-in via the `Conversation-Id` header — when
 * absent a fresh chat session is created per request.
 */
@RestController
@RequestMapping("/api/v1")
@Tag(name = "OpenAI-Compatible API", description = "OpenAI-shaped /v1/chat/completions and /v1/models")
@SecurityRequirement(name = "bearerAuth")
class OpenAICompatibleController(
    private val openAICompatibleService: OpenAICompatibleService,
    private val userService: UserService,
    private val objectMapper: ObjectMapper,
) {
    /**
     * Single endpoint for both stream=true (SSE) and stream=false (JSON).
     * Always returns `ResponseEntity<StreamingResponseBody>` so Spring's
     * `StreamingResponseBodyReturnValueHandler` kicks in — a `ResponseEntity<*>`
     * return type would be erased and routed through HttpEntityMethodProcessor,
     * which has no converter for `StreamingResponseBody` and 500s on
     * `text/event-stream` content negotiation.
     */
    @PostMapping(
        "/chat/completions",
        consumes = [MediaType.APPLICATION_JSON_VALUE],
    )
    @Operation(
        summary = "OpenAI-compatible chat completions",
        description = "Streams `chat.completion.chunk` SSE when stream=true, otherwise returns a `chat.completion` JSON.",
    )
    fun chatCompletions(
        @AuthenticationPrincipal userDetails: UserDetails,
        @Valid @RequestBody request: OpenAIChatCompletionRequest,
        @RequestHeader(name = HEADER_CONVERSATION_ID, required = false) conversationId: String?,
    ): ResponseEntity<StreamingResponseBody> {
        val userId = userDetails.authenticatedUserId(userService)
        logger.info { "POST /v1/chat/completions - user=$userId model=${request.model} stream=${request.stream}" }

        return runCatching {
            if (request.stream) {
                streamingResponse(openAICompatibleService.streamChatCompletion(userId, request, conversationId))
            } else {
                jsonResponse(openAICompatibleService.nonStreamChatCompletion(userId, request, conversationId))
            }
        }.getOrElse { ex -> errorAsStreamingResponse(ex) }
    }

    @GetMapping("/models", produces = [MediaType.APPLICATION_JSON_VALUE])
    @Operation(summary = "List Scrapalot models (workspaces + collections)")
    fun listModels(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<OpenAIModelsResponse> {
        val userId = userDetails.authenticatedUserId(userService)
        return ResponseEntity.ok(openAICompatibleService.listModels(userId))
    }

    @GetMapping("/models/{id}", produces = [MediaType.APPLICATION_JSON_VALUE])
    @Operation(summary = "Get a single Scrapalot model by id")
    fun getModel(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable id: String,
    ): ResponseEntity<Any> {
        val userId = userDetails.authenticatedUserId(userService)
        return runCatching {
            ResponseEntity.ok<Any>(openAICompatibleService.getModel(userId, id))
        }.getOrElse { ex ->
            val (status, type) = errorStatusAndType(ex)
            ResponseEntity.status(status).body(
                OpenAIErrorEnvelope(error = OpenAIError(message = ex.message ?: "Unknown error", type = type))
            )
        }
    }

    // ── SSE plumbing ────────────────────────────────────────────────────────

    /**
     * Same write-and-flush bridge used by [com.scrapalot.backend.controller.chat.ChatController]
     * for NDJSON, but with `text/event-stream` content type and a trailing
     * `data: [DONE]` sentinel (OpenAI clients require it to close the stream
     * cleanly; without it the openai-python SDK hangs until socket timeout).
     */
    private fun streamingResponse(flux: reactor.core.publisher.Flux<String>): ResponseEntity<StreamingResponseBody> {
        val body =
            StreamingResponseBody { outputStream ->
                val latch = CountDownLatch(1)
                val clientDisconnected = AtomicBoolean(false)
                val subscriber =
                    object : BaseSubscriber<String>() {
                        override fun hookOnNext(value: String) {
                            try {
                                outputStream.write(value.toByteArray(Charsets.UTF_8))
                                outputStream.flush()
                            } catch (e: IOException) {
                                if (clientDisconnected.compareAndSet(false, true)) {
                                    logger.warn { "Client disconnected during /v1/chat/completions stream: ${e.message}" }
                                }
                                cancel()
                                latch.countDown()
                            }
                        }

                        override fun hookOnComplete() {
                            latch.countDown()
                        }

                        override fun hookOnError(throwable: Throwable) {
                            logger.error(throwable) { "OpenAI shim stream error: ${throwable.message}" }
                            latch.countDown()
                        }

                        override fun hookOnCancel() {
                            latch.countDown()
                        }
                    }
                flux.subscribe(subscriber)
                try {
                    latch.await()
                } finally {
                    if (!subscriber.isDisposed) subscriber.cancel()
                }
                if (!clientDisconnected.get()) {
                    runCatching {
                        outputStream.write(SSE_DONE.toByteArray(Charsets.UTF_8))
                        outputStream.flush()
                    }
                }
            }
        return ResponseEntity
            .ok()
            .contentType(MediaType.TEXT_EVENT_STREAM)
            .header(HEADER_X_ACCEL_BUFFERING, "no")
            .header(HttpHeaders.CACHE_CONTROL, "no-cache, no-transform")
            .body(body)
    }

    // ── JSON-as-streaming-body helper (non-stream branch) ───────────────────

    /**
     * Wrap a serializable value in a one-shot `StreamingResponseBody` so the
     * non-stream branch can share the controller return type with the SSE
     * branch. Spring serializes the value via the configured ObjectMapper.
     */
    private fun jsonResponse(value: Any): ResponseEntity<StreamingResponseBody> {
        val bytes = objectMapper.writeValueAsBytes(value)
        val body =
            StreamingResponseBody { os ->
                os.write(bytes)
                os.flush()
            }
        return ResponseEntity
            .ok()
            .contentType(MediaType.APPLICATION_JSON)
            .body(body)
    }

    // ── Error mapping ───────────────────────────────────────────────────────

    private fun errorStatusAndType(ex: Throwable): Pair<HttpStatus, String> =
        when (ex) {
            is NoSuchElementException -> HttpStatus.NOT_FOUND to "not_found"
            is IllegalArgumentException -> HttpStatus.BAD_REQUEST to "invalid_request"
            is SecurityException -> HttpStatus.FORBIDDEN to "permission_denied"
            else -> {
                logger.error(ex) { "OpenAI shim unhandled error: ${ex.message}" }
                HttpStatus.INTERNAL_SERVER_ERROR to "server_error"
            }
        }

    /**
     * Render an error from the `chat/completions` flow as a one-shot
     * StreamingResponseBody so the controller's return type stays uniform.
     */
    private fun errorAsStreamingResponse(ex: Throwable): ResponseEntity<StreamingResponseBody> {
        val (status, type) = errorStatusAndType(ex)
        val envelope = OpenAIErrorEnvelope(error = OpenAIError(message = ex.message ?: "Unknown error", type = type))
        val bytes = objectMapper.writeValueAsBytes(envelope)
        val body =
            StreamingResponseBody { os ->
                os.write(bytes)
                os.flush()
            }
        return ResponseEntity
            .status(status)
            .contentType(MediaType.APPLICATION_JSON)
            .body(body)
    }
}
