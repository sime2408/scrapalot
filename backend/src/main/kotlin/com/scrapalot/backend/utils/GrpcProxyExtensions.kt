package com.scrapalot.backend.utils

import com.scrapalot.backend.grpc.jobs.JobInfo
import com.scrapalot.backend.grpc.jobs.JobStatusResponse
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.reactive.asPublisher
import kotlinx.coroutines.runBlocking
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody
import reactor.core.publisher.Flux
import java.util.concurrent.CountDownLatch

/**
 * Extensions for controllers that proxy gRPC calls to the Python AI backend.
 * Eliminates repetitive runBlocking + ResponseEntity + JSON patterns.
 */

// ── JSON escaping ────────────────────────────────────────────────────────────

/**
 * Escape a string for safe embedding inside a JSON string literal.
 * Used for NDJSON streaming where we build JSON manually for performance.
 */
fun String.escapeJson(): String =
    this
        .replace("\\", "\\\\")
        .replace("\"", "\\\"")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")

// ── NDJSON streaming ─────────────────────────────────────────────────────────

/**
 * Convert a gRPC streaming Flow into an NDJSON StreamingResponseBody.
 *
 * Usage:
 * ```kotlin
 * grpcClient.streamSomething(request).toNdjsonStream { packet ->
 *     """{"type":"${packet.type}","content":"${packet.content.escapeJson()}"}"""
 * }
 * ```
 */
@Suppress("UastIncorrectHttpHeaderInspection")
fun <T : Any> Flow<T>.toNdjsonStream(toJson: (T) -> String): ResponseEntity<StreamingResponseBody> {
    val publisher = this.asPublisher()
    val body =
        StreamingResponseBody { outputStream ->
            val latch = CountDownLatch(1)
            Flux.from(publisher).subscribe(
                { item: T ->
                    runCatching {
                        outputStream.write((toJson(item) + "\n").toByteArray(Charsets.UTF_8))
                        outputStream.flush()
                    }
                },
                { latch.countDown() },
                { latch.countDown() },
            )
            latch.await()
        }
    return ResponseEntity
        .ok()
        .contentType(MediaType("application", "x-ndjson"))
        .header("X-Accel-Buffering", "no")
        .header(HttpHeaders.CACHE_CONTROL, "no-cache, no-transform")
        .body(body)
}

// ── Blocking gRPC proxy ──────────────────────────────────────────────────────

/**
 * Execute a suspend gRPC call in a blocking context and return the result.
 * Wraps runBlocking to make the call site cleaner.
 *
 * Usage:
 * ```kotlin
 * fun getDocument(...) = grpcProxy { documentClient.getDocument(id) }.toResponseEntity()
 * ```
 */
@Suppress("unused")
inline fun <T> grpcProxy(crossinline block: suspend () -> T): Result<T> =
    runCatching {
        runBlocking { block() }
    }

// ── Success / failure response helpers ───────────────────────────────────────

/**
 * Returns a 200 OK with `{"success": true, "message": msg}` body.
 * Eliminates the repeated if/else success-check pattern across gRPC proxy controllers.
 */
fun grpcSuccessResponse(message: String): ResponseEntity<Any> = ResponseEntity.ok(mapOf("success" to true, "message" to message) as Any)

/**
 * Returns a 500 Internal Server Error with `{"success": false, "error": error}` body.
 */
fun grpcFailureResponse(error: String): ResponseEntity<Any> = ResponseEntity.status(500).body(mapOf("success" to false, "error" to error) as Any)

// ── Job status helpers ───────────────────────────────────────────────────────

/** Maps a JobStatusResponse to the standard REST job-status map. */
fun JobStatusResponse.toJobStatusMap(): Map<String, Any?> =
    mapOf(
        "job_id" to jobId,
        "document_id" to documentId,
        "filename" to filename,
        "collection_id" to collectionId,
        "collection_name" to collectionName,
        "status" to status,
        "progress" to progress,
        "message" to message,
        "last_update_time" to lastUpdateTime,
        "estimated_completion_time" to estimatedCompletionTime,
    )

/** Maps a JobInfo entry to the standard per-job map used in the active-jobs list. */
fun JobInfo.toActiveJobMap(): Map<String, Any?> =
    mapOf(
        "job_id" to jobId,
        "document_id" to documentId,
        "collection_id" to collectionId,
        "status" to status,
        "progress" to progress,
        "message" to message,
        "filename" to filename,
        "collection_name" to collectionName,
    )
