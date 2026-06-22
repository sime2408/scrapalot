package com.scrapalot.backend.utils

import com.scrapalot.backend.exception.NotFoundException
import mu.KotlinLogging
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity

private val logger = KotlinLogging.logger {}

/**
 * Modern Result-based error handling extensions for Spring controllers.
 * Replaces try-catch blocks with a functional Result pattern.
 */

/**
 * Execute a block and return Result, automatically catching exceptions.
 * Use this instead of manual try-catch blocks.
 */
inline fun <T> resultOf(block: () -> T): Result<T> = runCatching(block)

/**
 * Convert Result to ResponseEntity with proper status codes.
 * Success → 200 OK
 * Failure → Appropriate error status based on exception type
 */
fun <T> Result<T>.toResponseEntity(): ResponseEntity<T> =
    fold(
        onSuccess = { ResponseEntity.ok(it) },
        onFailure = ::mapFailure
    )

/**
 * Convert Result to ResponseEntity with a custom success status code.
 * Useful for POST (201 CREATED) or PUT (204 NO CONTENT) operations.
 */
@Suppress("SameParameterValue") // public extension function — callers may pass any HttpStatus, not just CREATED
fun <T> Result<T>.toResponseEntity(successStatus: HttpStatus): ResponseEntity<T> =
    fold(
        onSuccess = { ResponseEntity.status(successStatus).body(it) },
        onFailure = ::mapFailure
    )

/**
 * Convert Result<Void> to ResponseEntity<Void> with NO CONTENT on success.
 * Useful for DELETE operations.
 */
fun Result<Unit>.toNoContentResponse(): ResponseEntity<Void> =
    fold(
        onSuccess = { ResponseEntity.noContent().build() },
        onFailure = ::mapFailure
    )

private fun <T> mapFailure(exception: Throwable): ResponseEntity<T> {
    logger.error(exception) { "Request failed: ${exception.message}" }
    return when (exception) {
        is NotFoundException -> ResponseEntity.notFound().build()
        is NoSuchElementException -> ResponseEntity.notFound().build()
        is IllegalArgumentException -> ResponseEntity.badRequest().build()
        is IllegalStateException -> ResponseEntity.badRequest().build()
        is SecurityException -> ResponseEntity.status(HttpStatus.FORBIDDEN).build()
        else -> ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build()
    }
}

/**
 * Execute side effect on success without changing the result.
 * Useful for logging or publishing events.
 */
inline fun <T> Result<T>.onSuccessLog(crossinline message: (T) -> String): Result<T> =
    onSuccess { value ->
        KotlinLogging.logger {}.info { message(value) }
    }

/**
 * Execute side effect on failure without changing the result.
 * Useful for custom error logging.
 */
inline fun <T> Result<T>.onFailureLog(crossinline message: (Throwable) -> String): Result<T> =
    onFailure { error ->
        KotlinLogging.logger {}.error(error) { message(error) }
    }

/**
 * Recover from specific exception types with a default value.
 */
inline fun <T, reified E : Exception> Result<T>.recoverWith(recovery: (E) -> T): Result<T> =
    recoverCatching { exception ->
        if (exception is E) recovery(exception) else throw exception
    }

/**
 * Convert nullable value to Result.
 * null → Failure with NoSuchElementException
 * non-null → Success
 */
fun <T> T?.toResult(errorMessage: String = "Value not found"): Result<T> = this?.let { Result.success(it) } ?: Result.failure(NoSuchElementException(errorMessage))

/**
 * Check authorization and return the Result.
 * true → Success(Unit)
 * false → Failure(SecurityException)
 */
fun Boolean.toAuthResult(errorMessage: String = "Access denied"): Result<Unit> = if (this) Result.success(Unit) else Result.failure(SecurityException(errorMessage))

// ── gRPC error handling ──────────────────────────────────────────────────────

/**
 * Wrap a gRPC service method body with standard exception-to-Status mapping.
 * Eliminates repetitive try-catch blocks across all gRPC service implementations.
 *
 * Usage:
 *   override suspend fun getWorkspace(request: ...) = grpcCall { ... }
 */
inline fun <T> grpcCall(block: () -> T): T =
    try {
        block()
    } catch (e: io.grpc.StatusRuntimeException) {
        throw e
    } catch (e: io.grpc.StatusException) {
        throw e
    } catch (e: NotFoundException) {
        throw io.grpc.StatusRuntimeException(
            io.grpc.Status.NOT_FOUND
                .withDescription(e.message)
        )
    } catch (e: NoSuchElementException) {
        throw io.grpc.StatusRuntimeException(
            io.grpc.Status.NOT_FOUND
                .withDescription(e.message)
        )
    } catch (e: IllegalArgumentException) {
        throw io.grpc.StatusRuntimeException(
            io.grpc.Status.INVALID_ARGUMENT
                .withDescription(e.message)
        )
    } catch (e: SecurityException) {
        throw io.grpc.StatusRuntimeException(
            io.grpc.Status.PERMISSION_DENIED
                .withDescription(e.message)
        )
    } catch (e: Exception) {
        KotlinLogging.logger {}.error(e) { "gRPC error: ${e.message}" }
        throw io.grpc.StatusRuntimeException(
            io.grpc.Status.INTERNAL
                .withDescription(e.message)
        )
    }

// ── JSON response helpers ────────────────────────────────────────────────────

/**
 * Convert any object to a JSON ResponseEntity. Eliminates repeated
 * ResponseEntity.ok().contentType(APPLICATION_JSON).body(objectMapper.writeValueAsString(...))
 */
fun Any.toJsonResponse(objectMapper: com.fasterxml.jackson.databind.ObjectMapper): ResponseEntity<String> =
    ResponseEntity
        .ok()
        .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
        .body(objectMapper.writeValueAsString(this))

/**
 * Wrap a raw JSON string in a ResponseEntity with APPLICATION_JSON content type.
 */
fun String.asJsonResponse(): ResponseEntity<String> =
    ResponseEntity
        .ok()
        .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
        .body(this)
