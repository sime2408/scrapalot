package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.common.Empty
import com.scrapalot.backend.grpc.tts.*
import io.grpc.Deadline
import mu.KotlinLogging
import org.springframework.stereotype.Service
import java.util.concurrent.TimeUnit

private val logger = KotlinLogging.logger {}

/**
 * gRPC client for Python TtsService.
 *
 * Text-to-speech operations using Microsoft Edge TTS run in Python container.
 * Synthesize uses a 120-second deadline (overrides the global 15s unary deadline)
 * because edge-tts synthesis with retry logic can take significantly longer.
 */
@Service
class TtsGrpcClient(
    private val stub: TtsServiceGrpcKt.TtsServiceCoroutineStub
) {
    suspend fun synthesize(request: SynthesizeRequest): SynthesizeResponse {
        logger.info { "gRPC Synthesize: voice=${request.voice}, text_length=${request.text.length}" }
        return stub
            .withDeadline(Deadline.after(120, TimeUnit.SECONDS))
            .synthesize(request)
    }

    suspend fun listVoices(): ListVoicesResponse {
        logger.info { "gRPC ListVoices" }
        return stub.listVoices(Empty.getDefaultInstance())
    }
}
