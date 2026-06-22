package com.scrapalot.backend.config

import io.grpc.*
import io.grpc.ForwardingClientCall.SimpleForwardingClientCall
import io.grpc.ForwardingClientCallListener.SimpleForwardingClientCallListener
import mu.KotlinLogging
import net.devh.boot.grpc.client.interceptor.GrpcGlobalClientInterceptor
import org.springframework.beans.factory.annotation.Value
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private val logger = KotlinLogging.logger {}

/**
 * gRPC client interceptor providing default deadlines and observability.
 *
 * Single-instance architecture: there is only one scrapalot-chat backend, so a
 * circuit breaker has no healthy instance to fail over to. Opening the circuit
 * converts a temporary slowdown (e.g., graph rebuild spike) into a total outage
 * for all users. Degraded service (slow responses) is strictly better than no
 * service (instant UNAVAILABLE).
 *
 * What this interceptor does instead:
 * - Applies a default deadline to unary calls so they cannot hang indefinitely.
 *   Streaming calls (RAG, deep research) are excluded — they use gRPC to keepalive.
 * - Logs consecutive failures for observability (Grafana alerting) without
 *   blocking traffic.
 */
@GrpcGlobalClientInterceptor
class GrpcResilienceInterceptor(
    @param:Value("\${grpc.resilience.unary-deadline-ms:30000}")
    private val unaryDeadlineMs: Long = 30_000
) : ClientInterceptor {
    private val consecutiveFailures = AtomicInteger(0)

    override fun <ReqT, RespT> interceptCall(
        method: MethodDescriptor<ReqT, RespT>,
        callOptions: CallOptions,
        next: Channel
    ): ClientCall<ReqT, RespT> {
        val methodName = method.bareMethodName ?: method.fullMethodName

        // Apply deadline for unary calls (not streaming) if no deadline is already set
        val isUnary = method.type == MethodDescriptor.MethodType.UNARY
        val options =
            if (isUnary && callOptions.deadline == null) {
                callOptions.withDeadlineAfter(unaryDeadlineMs, TimeUnit.MILLISECONDS)
            } else {
                callOptions
            }

        val delegate = next.newCall(method, options)

        return object : SimpleForwardingClientCall<ReqT, RespT>(delegate) {
            override fun start(
                responseListener: Listener<RespT>,
                headers: Metadata
            ) {
                val wrappedListener =
                    object : SimpleForwardingClientCallListener<RespT>(responseListener) {
                        override fun onClose(
                            status: Status,
                            trailers: Metadata
                        ) {
                            if (status.isOk) {
                                val prev = consecutiveFailures.getAndSet(0)
                                if (prev >= 3) {
                                    logger.info { "gRPC recovered after $prev consecutive failures ($methodName)" }
                                }
                            } else if (isTransientFailure(status)) {
                                val failures = consecutiveFailures.incrementAndGet()
                                if (failures == 3 || failures == 10 || failures % 50 == 0) {
                                    logger.warn { "gRPC $methodName: $failures consecutive failures (${status.code})" }
                                }
                            }
                            super.onClose(status, trailers)
                        }
                    }
                super.start(wrappedListener, headers)
            }
        }
    }

    private fun isTransientFailure(status: Status): Boolean =
        status.code == Status.Code.UNAVAILABLE ||
            status.code == Status.Code.DEADLINE_EXCEEDED ||
            status.code == Status.Code.RESOURCE_EXHAUSTED
}
