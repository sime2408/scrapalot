package com.scrapalot.backend.controller.knowledge

import com.scrapalot.backend.grpc.DocumentExtrasGrpcClient
import com.scrapalot.backend.grpc.document.TagInfo
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.authenticatedUserId
import io.grpc.Status
import io.grpc.StatusRuntimeException
import kotlinx.coroutines.runBlocking
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1")
class TagController(
    private val userService: UserService,
    private val documentExtrasGrpcClient: DocumentExtrasGrpcClient,
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    // ── Workspace tags ───────────────────────────────────────────────────────

    @GetMapping("/tags")
    fun listTags(
        @RequestParam("workspace_id") workspaceId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<List<Map<String, Any?>>> =
        runBlocking {
            val userId = userDetails.userId()
            val response = documentExtrasGrpcClient.listTags(userId.toString(), workspaceId.toString())
            ResponseEntity.ok(response.tagsList.map { it.toMap() })
        }

    // ── Document tags ────────────────────────────────────────────────────────

    @GetMapping("/documents/{documentId}/tags")
    fun getDocumentTags(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<List<Map<String, Any?>>> =
        runBlocking {
            userDetails.userId()
            val response = documentExtrasGrpcClient.getDocumentTags(documentId.toString())
            ResponseEntity.ok(response.tagsList.map { it.toMap() })
        }

    @PostMapping("/documents/{documentId}/tags")
    fun tagDocument(
        @PathVariable documentId: UUID,
        @RequestBody body: Map<String, String>,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            val userId = userDetails.userId()
            val tagId = body["tag_id"] ?: throw IllegalArgumentException("tag_id is required")
            try {
                documentExtrasGrpcClient.tagDocument(documentId.toString(), tagId, userId.toString())
                ResponseEntity.ok(mapOf("success" to true))
            } catch (e: StatusRuntimeException) {
                if (e.status.code == Status.Code.PERMISSION_DENIED) {
                    ResponseEntity.status(HttpStatus.FORBIDDEN).body(mapOf("success" to false, "message" to (e.status.description ?: "Access denied")))
                } else {
                    throw e
                }
            }
        }

    @DeleteMapping("/documents/{documentId}/tags/{tagId}")
    fun untagDocument(
        @PathVariable documentId: UUID,
        @PathVariable tagId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            val userId = userDetails.userId()
            try {
                documentExtrasGrpcClient.untagDocument(documentId.toString(), tagId.toString(), userId.toString())
                ResponseEntity.ok(mapOf("success" to true))
            } catch (e: StatusRuntimeException) {
                if (e.status.code == Status.Code.PERMISSION_DENIED || e.status.code == Status.Code.NOT_FOUND) {
                    ResponseEntity.status(HttpStatus.FORBIDDEN).body(mapOf("success" to false, "message" to (e.status.description ?: "Access denied")))
                } else {
                    throw e
                }
            }
        }
}

// ── Extensions ───────────────────────────────────────────────────────────────

private fun TagInfo.toMap(): Map<String, Any?> =
    mapOf(
        "id" to id,
        "name" to name,
        "color" to color,
        "position" to position,
        "doc_count" to docCount,
    )
