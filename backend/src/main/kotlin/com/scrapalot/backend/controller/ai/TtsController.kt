package com.scrapalot.backend.controller.ai

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.grpc.TtsGrpcClient
import com.scrapalot.backend.grpc.tts.SynthesizeRequest
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.authenticatedUserId
import kotlinx.coroutines.runBlocking
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import java.util.Base64

@RestController
@RequestMapping("/api/v1/tts")
class TtsController(
    private val ttsGrpcClient: TtsGrpcClient,
    private val userService: UserService,
    private val objectMapper: ObjectMapper
) {
    data class TtsRequest(
        val text: String = "",
        val voice: String = "en-US-AriaNeural",
        val rate: String = "+0%",
        val pitch: String = "+0Hz"
    )

    @PostMapping("/synthesize")
    fun synthesize(
        @RequestBody request: TtsRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<String> {
        userDetails.authenticatedUserId(userService)

        val grpcRequest =
            SynthesizeRequest
                .newBuilder()
                .setText(request.text)
                .setVoice(request.voice)
                .setRate(request.rate)
                .setPitch(request.pitch)
                .build()

        val response = runBlocking { ttsGrpcClient.synthesize(grpcRequest) }

        // Convert gRPC response to JSON matching Python format
        val wordBoundaries =
            response.wordBoundariesList.map { wb ->
                mapOf(
                    "text" to wb.text,
                    "offset" to wb.offset,
                    "duration" to wb.duration
                )
            }

        val result =
            mapOf(
                "audio" to Base64.getEncoder().encodeToString(response.audio.toByteArray()),
                "word_boundaries" to wordBoundaries,
                "duration_ms" to response.durationMs
            )

        return ResponseEntity.ok(objectMapper.writeValueAsString(result))
    }

    @GetMapping("/voices")
    fun listVoices(): ResponseEntity<String> {
        val response = runBlocking { ttsGrpcClient.listVoices() }

        val voices =
            response.voicesList.map { v ->
                mapOf(
                    "name" to v.name,
                    "display_name" to v.displayName,
                    "locale" to v.locale,
                    "gender" to v.gender,
                    "language" to v.language
                )
            }

        val result = mapOf("voices" to voices)
        return ResponseEntity.ok(ObjectMapper().writeValueAsString(result))
    }
}
