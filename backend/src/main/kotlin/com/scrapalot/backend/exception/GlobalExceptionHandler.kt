package com.scrapalot.backend.exception

import io.grpc.Status
import io.grpc.StatusException
import io.grpc.StatusRuntimeException
import mu.KotlinLogging
import org.apache.catalina.connector.ClientAbortException
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.security.access.AccessDeniedException
import org.springframework.security.authentication.BadCredentialsException
import org.springframework.security.core.AuthenticationException
import org.springframework.web.bind.MethodArgumentNotValidException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.context.request.WebRequest
import org.springframework.web.context.request.async.AsyncRequestNotUsableException
import org.springframework.web.multipart.MaxUploadSizeExceededException
import org.springframework.web.server.ResponseStatusException
import org.springframework.web.servlet.NoHandlerFoundException
import org.springframework.web.servlet.resource.NoResourceFoundException
import java.io.IOException
import java.time.Instant

private val logger = KotlinLogging.logger {}

@RestControllerAdvice
class GlobalExceptionHandler {
    // ── Helpers ──────────────────────────────────────────────────────────────

    private fun WebRequest.path(): String = getDescription(false).removePrefix("uri=")

    private fun errorResponse(
        status: HttpStatus,
        message: String,
        request: WebRequest,
        fieldErrors: List<FieldError> = emptyList(),
    ) = ResponseEntity.status(status).body(
        ErrorResponse(
            status = status.value(),
            error = status.reasonPhrase,
            message = message,
            path = request.path(),
            timestamp = Instant.now(),
            fieldErrors = fieldErrors,
        )
    )

    // ── Validation ───────────────────────────────────────────────────────────

    @ExceptionHandler(MethodArgumentNotValidException::class)
    fun handleValidation(
        ex: MethodArgumentNotValidException,
        req: WebRequest
    ): ResponseEntity<ErrorResponse> {
        val fields = ex.bindingResult.fieldErrors.map { FieldError(it.field, it.defaultMessage ?: "Invalid value", it.rejectedValue?.toString()) }
        logger.warn { "Validation error: ${fields.size} field errors" }
        return errorResponse(HttpStatus.BAD_REQUEST, "Request validation failed", req, fields)
    }

    // ── Mapped exceptions (single generic handler per HTTP status) ────────

    @ExceptionHandler(NotFoundException::class, NoSuchElementException::class)
    fun handleNotFound(
        ex: RuntimeException,
        req: WebRequest
    ) = errorResponse(HttpStatus.NOT_FOUND, ex.message ?: "Resource not found", req)
        .also { logger.debug { "Resource not found: ${ex.message}" } }

    @ExceptionHandler(IllegalArgumentException::class, HttpMessageNotReadableException::class)
    fun handleBadRequest(
        ex: Exception,
        req: WebRequest
    ) = errorResponse(
        HttpStatus.BAD_REQUEST,
        if (ex is HttpMessageNotReadableException) "Invalid request body format" else ex.message ?: "Invalid request",
        req,
    ).also { logger.warn { "Bad request: ${ex.message?.substringBefore("at")?.trim()}" } }

    @ExceptionHandler(IllegalStateException::class)
    fun handleConflict(
        ex: IllegalStateException,
        req: WebRequest
    ) = errorResponse(HttpStatus.CONFLICT, ex.message ?: "Operation not allowed in current state", req)
        .also { logger.warn { "Illegal state: ${ex.message}" } }

    @ExceptionHandler(AccessDeniedException::class)
    fun handleForbidden(
        ex: AccessDeniedException,
        req: WebRequest
    ) = errorResponse(HttpStatus.FORBIDDEN, ex.message ?: "Access denied", req)
        .also { logger.warn { "Access denied: ${ex.message}" } }

    // SecurityException is the project-wide signal for "authenticated but not
    // allowed" (plan feature gates, admin-role gates). resultOf-based
    // endpoints map it themselves; this covers controllers that return from
    // bare runBlocking blocks (e.g. llm-inference) so they 403 instead of 500.
    @ExceptionHandler(SecurityException::class)
    fun handleSecurity(
        ex: SecurityException,
        req: WebRequest
    ) = errorResponse(HttpStatus.FORBIDDEN, ex.message ?: "Access denied", req)
        .also { logger.warn { "Security gate: ${ex.message}" } }

    @ExceptionHandler(AuthenticationException::class, BadCredentialsException::class)
    fun handleUnauthorized(
        ex: Exception,
        req: WebRequest
    ) = errorResponse(HttpStatus.UNAUTHORIZED, if (ex is BadCredentialsException) "Invalid credentials" else ex.message ?: "Authentication failed", req)
        .also { logger.warn { "Auth failed: ${ex::class.simpleName}" } }

    @ExceptionHandler(NoHandlerFoundException::class)
    fun handleNoHandler(
        ex: NoHandlerFoundException,
        req: WebRequest
    ) = errorResponse(HttpStatus.NOT_FOUND, "Endpoint not found: ${ex.httpMethod} ${ex.requestURL}", req)

    @ExceptionHandler(NoResourceFoundException::class)
    fun handleNoResource(
        ex: NoResourceFoundException,
        req: WebRequest
    ) = errorResponse(HttpStatus.NOT_FOUND, "Resource not found: ${ex.resourcePath}", req)
        .also { logger.debug { "Static resource not found: ${ex.resourcePath}" } }

    // ── Spring ResponseStatusException ───────────────────────────────────────

    @ExceptionHandler(ResponseStatusException::class)
    fun handleResponseStatus(
        ex: ResponseStatusException,
        req: WebRequest
    ) = (HttpStatus.resolve(ex.statusCode.value()) ?: HttpStatus.INTERNAL_SERVER_ERROR).let { status ->
        errorResponse(status, ex.reason ?: status.reasonPhrase, req)
            .also { logger.debug { "ResponseStatusException: ${status.value()} - ${ex.reason}" } }
    }

    // ── gRPC status → HTTP status mapping ────────────────────────────────────

    @ExceptionHandler(StatusException::class, StatusRuntimeException::class)
    fun handleGrpc(
        ex: Exception,
        req: WebRequest
    ): ResponseEntity<ErrorResponse> {
        val grpcStatus =
            when (ex) {
                is StatusException -> ex.status
                is StatusRuntimeException -> ex.status
                else -> Status.INTERNAL
            }
        val (httpStatus, message) = grpcStatus.code.toHttpMapping(grpcStatus.description)
        logger.warn { "gRPC error: ${grpcStatus.code} - ${grpcStatus.description}" }
        return errorResponse(httpStatus, message, req)
    }

    // ── Upload size ──────────────────────────────────────────────────────────

    @ExceptionHandler(MaxUploadSizeExceededException::class)
    fun handleMaxUploadSize(
        ex: MaxUploadSizeExceededException,
        req: WebRequest
    ): ResponseEntity<ErrorResponse> {
        val maxSize = ex.maxUploadSize
        val sizeLabel = if (maxSize > 0) "${maxSize / (1024 * 1024)}MB" else "500MB"
        logger.warn { "File too large: ${ex.message}" }
        return errorResponse(HttpStatus.PAYLOAD_TOO_LARGE, "File is too large. Maximum upload size is $sizeLabel.", req)
    }

    // ── Client disconnect ────────────────────────────────────────────────────

    // The client closed the connection mid-response (broken pipe), e.g. a browser
    // cancelling an in-flight image/file download from StaticFileController. The
    // response is already committed and no longer writable, so falling through to
    // the catch-all — which tries to serialize an ErrorResponse body — only raises
    // HttpMessageNotWritableException ("No converter ... with preset Content-Type
    // 'image/png'"). Return void so Spring writes nothing back.
    @ExceptionHandler(AsyncRequestNotUsableException::class, ClientAbortException::class)
    fun handleClientDisconnect(ex: Exception) {
        logger.debug { "Client disconnected mid-response: ${ex::class.simpleName}" }
    }

    // A mid-stream client disconnect can also surface as a bare java.io.IOException
    // ("Broken pipe" / "Connection reset by peer") that escapes the committed
    // StreamingResponseBody (e.g. /v1/chat/completions SSE) rather than the more
    // specific ClientAbortException. The response Content-Type is already pinned to
    // text/event-stream, so letting it fall through to handleGeneric only triggers
    // HttpMessageNotWritableException. Swallow disconnect-style IOExceptions; re-throw
    // any genuine server-side I/O error so it still maps to a 500.
    @ExceptionHandler(IOException::class)
    fun handleIoException(ex: IOException) {
        if (!ex.isClientDisconnect()) throw ex
        logger.debug { "Client disconnected mid-response: IOException - ${ex.message}" }
    }

    // ── Catch-all ────────────────────────────────────────────────────────────

    @ExceptionHandler(Exception::class)
    fun handleGeneric(
        ex: Exception,
        req: WebRequest
    ): ResponseEntity<ErrorResponse> {
        logger.error { "Unexpected error: ${ex::class.simpleName} - ${ex.message}" }
        return errorResponse(HttpStatus.INTERNAL_SERVER_ERROR, "An unexpected error occurred", req)
    }
}

// ── Client-disconnect detection ──────────────────────────────────────────────

// A broken-pipe / connection-reset / EOF IOException means the peer closed the
// socket mid-response — not a server fault. The JDK/Tomcat report these as plain
// IOExceptions with locale-independent ASCII messages, so a substring check on the
// message (and its cause chain) is the reliable cross-platform signal.
private fun IOException.isClientDisconnect(): Boolean {
    var cause: Throwable? = this
    while (cause != null) {
        val msg = cause.message?.lowercase()
        if (msg != null &&
            (
                msg.contains("broken pipe") ||
                    msg.contains("connection reset") ||
                    msg.contains("connection was aborted") ||
                    msg.contains("an established connection was aborted")
            )
        ) {
            return true
        }
        if (cause is java.io.EOFException) return true
        cause = cause.cause.takeIf { it !== cause }
    }
    return false
}

// ── gRPC → HTTP mapping extension ────────────────────────────────────────────

private fun Status.Code.toHttpMapping(description: String?) =
    when (this) {
        Status.Code.UNAVAILABLE -> HttpStatus.SERVICE_UNAVAILABLE to "AI service is temporarily unavailable. Please try again."
        Status.Code.DEADLINE_EXCEEDED -> HttpStatus.GATEWAY_TIMEOUT to "AI service request timed out"
        Status.Code.NOT_FOUND -> HttpStatus.NOT_FOUND to (description ?: "Resource not found")
        Status.Code.UNAUTHENTICATED -> HttpStatus.UNAUTHORIZED to "Authentication required"
        Status.Code.PERMISSION_DENIED -> HttpStatus.FORBIDDEN to "Permission denied"
        Status.Code.INVALID_ARGUMENT -> HttpStatus.BAD_REQUEST to (description ?: "Invalid request")
        Status.Code.RESOURCE_EXHAUSTED -> HttpStatus.TOO_MANY_REQUESTS to "AI service is overloaded. Please try again later."
        Status.Code.UNIMPLEMENTED -> HttpStatus.NOT_IMPLEMENTED to "Operation not supported by AI service"
        else -> HttpStatus.INTERNAL_SERVER_ERROR to "AI service error"
    }

// ── Response DTOs ────────────────────────────────────────────────────────────

data class ErrorResponse(
    val status: Int,
    val error: String,
    val message: String,
    val path: String,
    val timestamp: Instant,
    val fieldErrors: List<FieldError> = emptyList(),
)

data class FieldError(
    val field: String,
    val message: String,
    val rejectedValue: String? = null,
)
