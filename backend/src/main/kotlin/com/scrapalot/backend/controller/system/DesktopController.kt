package com.scrapalot.backend.controller.system

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.grpc.DesktopGrpcClient
import com.scrapalot.backend.grpc.desktop.*
import com.scrapalot.backend.utils.toJsonResponse
import kotlinx.coroutines.runBlocking
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/v1/desktop")
class DesktopController(
    private val desktopGrpcClient: DesktopGrpcClient,
    private val objectMapper: ObjectMapper,
) {
    private fun buildAuthResult(
        accessToken: String,
        refreshToken: String,
        tokenType: String,
        userJson: String
    ) = buildMap<String, Any?> {
        put("access_token", accessToken)
        put("refresh_token", refreshToken)
        put("token_type", tokenType)
        if (userJson.isNotEmpty()) put("user", objectMapper.readValue(userJson, Map::class.java))
    }

    @PostMapping("/auth/initialize")
    fun initializeAuth(
        @RequestBody body: Map<String, String>
    ): ResponseEntity<String> =
        runBlocking {
            val r = desktopGrpcClient.initializeAuth(DesktopInitRequest.newBuilder().setApiKey(body["api_key"] ?: "").build())
            buildAuthResult(r.accessToken, r.refreshToken, r.tokenType, r.userJson).toJsonResponse(objectMapper)
        }

    @GetMapping("/auth/verify")
    @Suppress("UastIncorrectHttpHeaderInspection")
    fun verifyAuth(
        @RequestHeader("X-Desktop-Api-Key") apiKey: String
    ): ResponseEntity<String> =
        runBlocking {
            val r = desktopGrpcClient.verifyAuth(VerifyAuthRequest.newBuilder().setApiKey(apiKey).build())
            buildMap<String, Any?> {
                put("authenticated", r.authenticated)
                if (r.userJson.isNotEmpty()) put("user", objectMapper.readValue(r.userJson, Map::class.java))
            }.toJsonResponse(objectMapper)
        }

    @GetMapping("/health")
    fun health(): ResponseEntity<String> =
        runBlocking {
            val r = desktopGrpcClient.health()
            mapOf("status" to r.status, "desktop_mode" to r.desktopMode, "data_directory" to r.dataDirectory, "database_path" to r.databasePath)
                .toJsonResponse(objectMapper)
        }

    @PostMapping("/auth/cloud-initialize")
    fun cloudInitialize(
        @RequestBody body: Map<String, String>
    ): ResponseEntity<String> =
        runBlocking {
            val r =
                desktopGrpcClient.cloudInitialize(
                    CloudDesktopInitRequest
                        .newBuilder()
                        .setApiKey(body["api_key"] ?: "")
                        .setMachineId(body["machine_id"] ?: "")
                        .setMachineName(body["machine_name"] ?: "")
                        .build()
                )
            buildAuthResult(r.accessToken, r.refreshToken, r.tokenType, r.userJson).toJsonResponse(objectMapper)
        }
}
