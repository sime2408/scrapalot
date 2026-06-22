package com.scrapalot.backend.controller.collection

import com.scrapalot.backend.grpc.DocumentExtrasGrpcClient
import com.scrapalot.backend.service.CollectionService
import com.scrapalot.backend.service.SubscriptionService
import com.scrapalot.backend.service.UsageType
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.service.WorkspaceService
import com.scrapalot.backend.utils.BYTES_PER_GB
import com.scrapalot.backend.utils.getAuthenticatedUser
import com.scrapalot.backend.utils.orThrow
import kotlinx.coroutines.runBlocking
import mu.KotlinLogging
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import org.springframework.web.server.ResponseStatusException
import java.math.RoundingMode
import java.util.UUID

private val logger = KotlinLogging.logger {}

@RestController
@RequestMapping("/api/v1/storage")
class StorageController(
    private val subscriptionService: SubscriptionService,
    private val documentExtrasGrpcClient: DocumentExtrasGrpcClient,
    private val collectionService: CollectionService,
    private val workspaceService: WorkspaceService,
    private val userService: UserService
) {
    @GetMapping("/quota")
    fun getStorageQuota(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
        val userId = user.id.orThrow("User")

        return try {
            val summary = subscriptionService.getUsageSummary(userId)
            val usageGb = summary.storageUsedBytes / BYTES_PER_GB
            val limitBytes = if (summary.storageLimitBytes == Long.MAX_VALUE) null else summary.storageLimitBytes
            val limitGb = limitBytes?.let { it / BYTES_PER_GB }
            val percentageUsed =
                if (limitBytes != null && limitBytes > 0) {
                    (summary.storageUsedBytes.toDouble() / limitBytes * 100).toBigDecimal().setScale(1, RoundingMode.HALF_UP).toDouble()
                } else {
                    null
                }

            logger.info {
                "Storage quota for user $userId: ${usageGb.toBigDecimal().setScale(2, RoundingMode.HALF_UP)}GB" +
                    if (limitGb != null) " / ${limitGb.toBigDecimal().setScale(2, RoundingMode.HALF_UP)}GB" else " (unlimited)"
            }

            ResponseEntity.ok(
                mapOf(
                    "current_usage_bytes" to summary.storageUsedBytes,
                    "current_usage_gb" to usageGb.toBigDecimal().setScale(6, RoundingMode.HALF_UP).toDouble(),
                    "limit_bytes" to limitBytes,
                    "limit_gb" to limitGb?.toBigDecimal()?.setScale(2, RoundingMode.HALF_UP)?.toDouble(),
                    "tier" to summary.planName,
                    "percentage_used" to percentageUsed,
                    "unlimited" to (limitBytes == null),
                    "breakdown" to
                        mapOf(
                            "disk_bytes" to summary.diskBytes,
                            "db_content_bytes" to summary.dbContentBytes,
                            "thumbnail_bytes" to summary.thumbnailBytes,
                        )
                )
            )
        } catch (e: Exception) {
            logger.error(e) { "Error getting storage quota for user $userId" }
            throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to get storage quota information")
        }
    }

    @GetMapping("/workspace/{workspaceId}")
    fun getWorkspaceStorage(
        @PathVariable workspaceId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
        val userId = user.id.orThrow("User")

        return try {
            val permission = workspaceService.getUserPermission(workspaceId, userId)
            if (permission == null) {
                logger.warn { "User $userId attempted to access workspace $workspaceId without permission" }
                throw ResponseStatusException(HttpStatus.NOT_FOUND, "Workspace not found or you don't have access")
            }

            val workspace =
                workspaceService.findById(workspaceId)
                    ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "Workspace not found")

            val collections = collectionService.findByWorkspaceId(workspaceId)
            val collectionIds = collections.mapNotNull { it.id?.toString() }

            val usage =
                if (collectionIds.isNotEmpty()) {
                    runBlocking { documentExtrasGrpcClient.getStorageUsage(collectionIds) }
                } else {
                    null
                }

            val totalBytes = usage?.totalSizeBytes ?: 0L
            val storageGb = (totalBytes / BYTES_PER_GB).toBigDecimal().setScale(6, RoundingMode.HALF_UP).toDouble()

            logger.info { "User $userId ($permission) accessed workspace $workspaceId storage: ${storageGb}GB, ${usage?.documentCount ?: 0} docs" }

            ResponseEntity.ok(
                mapOf(
                    "workspace_id" to workspaceId.toString(),
                    "storage_bytes" to totalBytes,
                    "storage_gb" to storageGb,
                    "document_count_monthly" to (usage?.documentCount ?: 0),
                    "document_count_total" to (usage?.documentCount ?: 0),
                    "owner_id" to workspace.userId.toString(),
                    "your_role" to permission
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            logger.error(e) { "Error getting workspace storage for $workspaceId" }
            throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to get workspace storage information")
        }
    }

    @PostMapping("/check")
    fun checkQuotaBeforeUpload(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
        val userId = user.id.orThrow("User")

        return try {
            val fileSizeBytes =
                ((body["file_size_bytes"] as? Number)?.toLong())
                    ?: throw ResponseStatusException(HttpStatus.BAD_REQUEST, "file_size_bytes is required")
            val collectionId =
                (body["collection_id"] as? String)?.let { UUID.fromString(it) }
                    ?: throw ResponseStatusException(HttpStatus.BAD_REQUEST, "collection_id is required")

            // Find the collection and its workspace
            val collection =
                collectionService.findById(collectionId)
                    ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "Collection not found")

            val workspaceId = collection.workspaceId
            val workspace =
                workspaceService.findById(workspaceId)
                    ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "Workspace not found")

            // Check if user can modify the collection
            if (!workspaceService.canEdit(workspaceId, userId)) {
                logger.warn { "User $userId attempted quota check for collection $collectionId without modify permissions" }
                throw ResponseStatusException(HttpStatus.FORBIDDEN, "You don't have permission to upload to this collection")
            }

            // Check storage quota for the workspace owner (who pays for storage)
            val ownerUserId = workspace.userId
            val result = subscriptionService.checkUsageLimit(ownerUserId, UsageType.STORAGE_BYTES, fileSizeBytes)
            val summary = subscriptionService.getUsageSummary(ownerUserId)

            logger.info {
                "Quota check for user $userId uploading ${fileSizeBytes / (1024 * 1024)}MB to collection $collectionId (owner: $ownerUserId): ${if (result.allowed) "ALLOWED" else "DENIED"}"
            }

            ResponseEntity.ok(
                mapOf(
                    "allowed" to result.allowed,
                    "message" to (result.message ?: "Upload allowed"),
                    "usage" to result.currentUsage,
                    "limit" to if (result.limit == Long.MAX_VALUE) null else result.limit,
                    "tier" to summary.planName,
                    "workspace_owner_id" to ownerUserId.toString(),
                    "workspace_id" to workspaceId.toString()
                )
            )
        } catch (e: ResponseStatusException) {
            throw e
        } catch (e: Exception) {
            logger.error(e) { "Error checking storage quota" }
            throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to check storage quota")
        }
    }
}
