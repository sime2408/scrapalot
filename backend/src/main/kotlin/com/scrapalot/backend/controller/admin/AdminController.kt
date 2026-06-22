package com.scrapalot.backend.controller.admin

import com.scrapalot.backend.dto.AdminBroadcastRequest
import com.scrapalot.backend.dto.AdminBroadcastResult
import com.scrapalot.backend.dto.AdminMessageRequest
import com.scrapalot.backend.dto.DirectMessageResponse
import com.scrapalot.backend.dto.TokenResponse
import com.scrapalot.backend.grpc.AdminGrpcClient
import com.scrapalot.backend.grpc.admin.GetDebugLogsRequest
import com.scrapalot.backend.grpc.admin.RebuildCrossBookRequest
import com.scrapalot.backend.grpc.admin.RebuildGraphRequest
import com.scrapalot.backend.grpc.admin.TriggerAutofixRequest
import com.scrapalot.backend.service.AdminMessageService
import com.scrapalot.backend.service.AuthService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.service.WorkspaceService
import com.scrapalot.backend.utils.getAuthenticatedUser
import com.scrapalot.backend.utils.orThrow
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toResponseEntity
import kotlinx.coroutines.runBlocking
import mu.KotlinLogging
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import org.springframework.web.server.ResponseStatusException
import java.util.UUID

/** Minimal workspace shape for the admin user-details screen (Jackson → snake_case). */
data class AdminUserWorkspaceResponse(
    val id: UUID,
    val name: String,
    val isOwner: Boolean
)

private val logger = KotlinLogging.logger {}

@RestController
@RequestMapping("/api/v1/admin")
class AdminController(
    private val adminGrpcClient: AdminGrpcClient,
    private val userService: UserService,
    private val authService: AuthService,
    private val workspaceService: WorkspaceService,
    private val adminMessageService: AdminMessageService
) {
    /** Resolve the caller, enforce admin role, and return the admin's id. */
    private fun requireAdminId(userDetails: UserDetails): UUID {
        val admin = userDetails.getAuthenticatedUser(userService).getOrThrow()
        if (admin.role != "admin") {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "Admin access required")
        }
        return admin.id.orThrow("User")
    }

    /** Admin sends a (replyable) direct message to a specific user. */
    @PostMapping("/users/{userId}/messages")
    fun sendUserMessage(
        @PathVariable userId: UUID,
        @RequestBody request: AdminMessageRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<DirectMessageResponse> =
        resultOf {
            val adminId = requireAdminId(userDetails)
            adminMessageService.sendTargeted(adminId, userId, request.content)
        }.toResponseEntity()

    /** Admin broadcasts an announcement to every active user. */
    @PostMapping("/messages/broadcast")
    fun broadcastMessage(
        @RequestBody request: AdminBroadcastRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<AdminBroadcastResult> =
        resultOf {
            val adminId = requireAdminId(userDetails)
            AdminBroadcastResult(delivered = adminMessageService.broadcast(adminId, request.content))
        }.toResponseEntity()

    /**
     * Issue a fresh access/refresh token pair for the target user so
     * the admin can step into that user's session. Front-end stashes
     * the admin's own tokens in a separate localStorage key before
     * swapping in the impersonation tokens, then restores them on
     * "exit impersonation".
     *
     * Restrictions:
     *  - caller must be an admin
     *  - cannot impersonate yourself (no-op)
     *  - a regular admin cannot impersonate another admin (defence-in-depth —
     *    if an admin's session is compromised, this prevents pivoting to
     *    another admin's account)
     *  - only a superadmin may impersonate an admin-role user, and even a
     *    superadmin can never impersonate another superadmin
     */
    @PostMapping("/users/{userId}/impersonate")
    fun impersonateUser(
        @PathVariable userId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<TokenResponse> {
        val admin = userDetails.getAuthenticatedUser(userService).getOrThrow()
        val adminId = admin.id.orThrow("User")

        if (admin.role != "admin") {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "Admin access required")
        }
        if (adminId == userId) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot impersonate yourself")
        }

        val target =
            userService.findById(userId)
                ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "User not found")
        if (target.isSuperadmin) {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "Cannot impersonate a superadmin")
        }
        if (target.role == "admin" && !admin.isSuperadmin) {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "Cannot impersonate another admin")
        }

        return try {
            ResponseEntity.ok(authService.impersonate(userId, adminId))
        } catch (e: IllegalArgumentException) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, e.message ?: "Impersonation failed")
        } catch (e: Exception) {
            logger.error(e) { "Impersonation failed for target=$userId" }
            throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Impersonation failed")
        }
    }

    /**
     * List the workspaces a specific user can access (owned + shared). Used by
     * the admin Users → user-details edit screen, which previously called the
     * generic "my workspaces" endpoint and therefore showed the ADMIN's own
     * workspaces (0 relevant) instead of the edited user's. Admin-only.
     */
    @GetMapping("/users/{userId}/workspaces")
    fun getUserWorkspaces(
        @PathVariable userId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<AdminUserWorkspaceResponse>> =
        resultOf {
            val admin = userDetails.getAuthenticatedUser(userService).getOrThrow()
            if (admin.role != "admin") {
                throw ResponseStatusException(HttpStatus.FORBIDDEN, "Admin access required")
            }
            workspaceService.findAllAccessibleWorkspaces(userId).map { ws ->
                val wsId = ws.id.orThrow("Workspace")
                AdminUserWorkspaceResponse(
                    id = wsId,
                    name = ws.name,
                    isOwner = ws.userId == userId
                )
            }
        }.toResponseEntity()

    @PostMapping("/debug/trigger-autofix")
    fun triggerAutofix(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
        val userId = user.id.orThrow("User")

        // Admin-only check
        if (user.role != "admin") {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "Admin access required")
        }

        return try {
            val requestBuilder =
                TriggerAutofixRequest
                    .newBuilder()
                    .setUserId(userId.toString())
                    .setErrorLog(body["error_log"] as? String ?: "")
                    .setTargetRepo(body["target_repo"] as? String ?: "backend")

            (body["error_context"] as? String)?.let { requestBuilder.setErrorContext(it) }
            (body["pr_body"] as? String)?.let { requestBuilder.setPrBody(it) }

            val response =
                runBlocking {
                    adminGrpcClient.triggerAutofix(requestBuilder.build())
                }

            ResponseEntity.ok(
                mapOf(
                    "success" to response.success,
                    "message" to response.message,
                    "branch_name" to response.branchName,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            logger.error(e) { "Error triggering autofix" }
            throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to trigger autofix")
        }
    }

    @PostMapping("/rebuild-graph")
    fun rebuildGraph(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
        val userId = user.id.orThrow("User")

        if (user.role != "admin") {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "Admin access required")
        }

        return try {
            val requestBuilder =
                RebuildGraphRequest
                    .newBuilder()
                    .setUserId(userId.toString())

            (body["collectionId"] as? String)?.let { requestBuilder.setCollectionId(it) }
            // Optional batch-size cap. Chunks a big collection rebuild
            // (e.g. agriculture, 90 pending docs) into shorter calls
            // so Neo4j + the event loop don't get monopolised.
            (body["limit"] as? Number)?.toInt()?.takeIf { it > 0 }?.let { requestBuilder.setLimit(it) }

            val response =
                runBlocking {
                    adminGrpcClient.rebuildGraph(requestBuilder.build())
                }

            ResponseEntity.ok(
                mapOf(
                    "success" to response.success,
                    "message" to response.message,
                    "documents_processed" to response.documentsProcessed,
                    "entities_extracted" to response.entitiesExtracted,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            logger.error(e) { "Error rebuilding graph" }
            throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to rebuild graph")
        }
    }

    @PostMapping("/relink-document-cooccurrence")
    fun relinkDocumentCooccurrence(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
        val userId = user.id.orThrow("User")

        if (user.role != "admin") {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "Admin access required")
        }

        val collectionId =
            body["collectionId"] as? String
                ?: throw ResponseStatusException(HttpStatus.BAD_REQUEST, "collectionId is required")

        return try {
            val request =
                com.scrapalot.backend.grpc.admin.RelinkDocumentCooccurrenceRequest
                    .newBuilder()
                    .setUserId(userId.toString())
                    .setCollectionId(collectionId)
                    .apply {
                        (body["minCooccurrence"] as? Number)?.toInt()?.let { setMinCooccurrence(it) }
                    }.build()

            val response =
                runBlocking {
                    adminGrpcClient.relinkDocumentCooccurrence(request)
                }

            ResponseEntity.ok(
                mapOf(
                    "success" to response.success,
                    "message" to response.message,
                    "documents_processed" to response.documentsProcessed,
                    "cooccurrence_edges_created" to response.cooccurrenceEdgesCreated,
                    "chunk_entity_links_added" to response.chunkEntityLinksAdded,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            logger.error(e) { "Error relinking document cooccurrence" }
            throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to relink document cooccurrence")
        }
    }

    @PostMapping("/rebuild-cross-book-relationships")
    fun rebuildCrossBookRelationships(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
        val userId = user.id.orThrow("User")

        if (user.role != "admin") {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "Admin access required")
        }

        return try {
            val requestBuilder =
                RebuildCrossBookRequest
                    .newBuilder()
                    .setUserId(userId.toString())

            (body["collectionId"] as? String)?.let { requestBuilder.setCollectionId(it) }

            val response =
                runBlocking {
                    adminGrpcClient.rebuildCrossBookRelationships(requestBuilder.build())
                }

            ResponseEntity.ok(
                mapOf(
                    "success" to response.success,
                    "message" to response.message,
                    "relationships_created" to response.relationshipsCreated,
                    "books_processed" to response.booksProcessed,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            logger.error(e) { "Error rebuilding cross-book relationships" }
            throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to rebuild cross-book relationships")
        }
    }

    @GetMapping("/debug/logs")
    fun getDebugLogs(
        @RequestParam(required = false) containerName: String?,
        @RequestParam(required = false, defaultValue = "100") tailLines: Int,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
        val userId = user.id.orThrow("User")

        // Admin-only check
        if (user.role != "admin") {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "Admin access required")
        }

        return try {
            val requestBuilder =
                GetDebugLogsRequest
                    .newBuilder()
                    .setUserId(userId.toString())
                    .setTailLines(tailLines)

            containerName?.let { requestBuilder.setContainerName(it) }

            val response =
                runBlocking {
                    adminGrpcClient.getDebugLogs(requestBuilder.build())
                }

            ResponseEntity.ok(
                mapOf(
                    "success" to response.success,
                    "logs" to response.logs,
                    "error_context" to response.errorContext,
                    "warning_context" to response.warningContext,
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            logger.error(e) { "Error getting debug logs" }
            throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to get debug logs")
        }
    }
}
