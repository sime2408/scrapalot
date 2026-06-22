package com.scrapalot.backend.controller.chat

import com.scrapalot.backend.dto.GenerateImageRequest
import com.scrapalot.backend.grpc.ChatGrpcClient
import com.scrapalot.backend.grpc.chat.GetTutorProgressRequest
import com.scrapalot.backend.service.ChatService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.*
import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.security.SecurityRequirement
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import kotlinx.coroutines.runBlocking
import mu.KotlinLogging
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody
import reactor.core.publisher.BaseSubscriber
import reactor.core.publisher.Flux
import java.io.IOException
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean

private val logger = KotlinLogging.logger {}

@Suppress("UastIncorrectHttpHeaderInspection")
private const val HEADER_X_ACCEL_BUFFERING = "X-Accel-Buffering"

/**
 * REST controller for chat generation.
 *
 * Uses StreamingResponseBody for proper chunked transfer encoding termination.
 * Each NDJSON line is written and flushed immediately for real-time streaming.
 */
@RestController
@RequestMapping("/api/v1/chat")
@Tag(name = "Chat", description = "Chat generation and RAG processing")
@SecurityRequirement(name = "bearerAuth")
class ChatController(
    private val userService: UserService,
    private val chatService: ChatService,
    private val chatGrpcClient: ChatGrpcClient
) {
    /**
     * Generate one or more images for a prompt and stream
     * ``image_attached`` packets back as NDJSON. The Python orchestrator
     * persists the bytes under ``scrapalot_data/generated/images/{user_id}/``;
     * this endpoint just bridges the gRPC stream to the browser.
     */
    @PostMapping("/generate/image", produces = [MediaType.APPLICATION_NDJSON_VALUE])
    @Operation(
        summary = "Generate image(s) for a prompt",
        description = "Streams image_attached packets as artifacts are persisted on disk."
    )
    fun generateImage(
        @AuthenticationPrincipal userDetails: UserDetails,
        @Valid @RequestBody request: GenerateImageRequest
    ): ResponseEntity<StreamingResponseBody> {
        val userId = userDetails.authenticatedUserId(userService)
        logger.info { "POST /chat/generate/image - userId: $userId, prompt: ${request.prompt.take(80)}, n: ${request.n}" }

        val responseFlux = chatService.generateImage(request, userId)

        val body =
            StreamingResponseBody { outputStream ->
                streamFluxToClient(
                    flux = responseFlux,
                    outputStream = outputStream,
                    contextLabel = "image generation (user=$userId)"
                )
            }

        return ResponseEntity
            .ok()
            .contentType(MediaType("application", "x-ndjson"))
            .header(HEADER_X_ACCEL_BUFFERING, "no")
            .header(HttpHeaders.CACHE_CONTROL, "no-cache, no-transform")
            .body(body)
    }

    /**
     * Bridge a `Flux<String>` (NDJSON lines from the gRPC pipeline) to the client's
     * `OutputStream`. On client disconnect the write throws `IOException` and we
     * cancel the subscription — cancellation propagates up through `Flow.asFlux()`,
     * the grpc-kotlin coroutine stub, and the gRPC call to Python, so the LLM
     * stops generating tokens instead of running to natural completion.
     */
    private fun streamFluxToClient(
        flux: Flux<String>,
        outputStream: OutputStream,
        contextLabel: String,
    ) {
        val latch = CountDownLatch(1)
        val errorRef = arrayOfNulls<Throwable>(1)
        val clientDisconnected = AtomicBoolean(false)

        val subscriber =
            object : BaseSubscriber<String>() {
                override fun hookOnNext(value: String) {
                    try {
                        outputStream.write(value.toByteArray(Charsets.UTF_8))
                        outputStream.flush()
                    } catch (e: IOException) {
                        if (clientDisconnected.compareAndSet(false, true)) {
                            logger.warn { "Client disconnected during $contextLabel: ${e.message}" }
                        }
                        cancel()
                        latch.countDown()
                    }
                }

                override fun hookOnComplete() {
                    logger.debug { "Stream completed for $contextLabel" }
                    latch.countDown()
                }

                override fun hookOnError(throwable: Throwable) {
                    logger.error(throwable) { "Stream error for $contextLabel: ${throwable.message}" }
                    errorRef[0] = throwable
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
            errorRef[0]?.let { error ->
                val errorJson = """{"ind":0,"obj":{"type":"error","content":"${error.message?.replace("\"", "\\\"") ?: "Unknown error"}"}}""" + "\n"
                runCatching {
                    outputStream.write(errorJson.toByteArray(Charsets.UTF_8))
                    outputStream.flush()
                }
            }
        }
    }

    /**
     * 7.8 v3 — read tutor progress for a collection. Returns the
     * curriculum status, lesson list, and the user's current
     * lesson_ord + state. Used by the chat sidebar progress badge.
     */
    @GetMapping("/tutor/progress")
    @Operation(
        summary = "Get tutor curriculum progress for a collection",
        description = "Returns lesson list + completion state for the user's active tutor session on a collection."
    )
    fun getTutorProgress(
        @AuthenticationPrincipal userDetails: UserDetails,
        @RequestParam("collection_id") collectionId: UUID,
    ): ResponseEntity<Any> {
        val userId = userDetails.authenticatedUserId(userService)
        val resp =
            runBlocking {
                chatGrpcClient.getTutorProgress(
                    GetTutorProgressRequest
                        .newBuilder()
                        .setUserId(userId.toString())
                        .setCollectionId(collectionId.toString())
                        .build()
                )
            }
        return ResponseEntity.ok(
            mapOf(
                "curriculum_ready" to resp.curriculumReady,
                "curriculum_status" to resp.curriculumStatus,
                "current_lesson_ord" to resp.currentLessonOrd,
                "current_state" to resp.currentState,
                "lesson_count" to resp.lessonCount,
                "lessons" to
                    resp.lessonsList.map {
                        mapOf(
                            "lesson_ord" to it.lessonOrd,
                            "title" to it.title,
                            "summary" to it.summary,
                            "level" to it.level,
                            "completed" to it.completed,
                        )
                    },
                "error" to resp.error,
            )
        )
    }
}
