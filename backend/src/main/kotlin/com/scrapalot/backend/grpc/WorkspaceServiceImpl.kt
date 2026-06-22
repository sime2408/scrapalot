package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.common.StatusResponse
import com.scrapalot.backend.grpc.common.Timestamp
import com.scrapalot.backend.grpc.workspace.*
import com.scrapalot.backend.repository.UserRepository
import com.scrapalot.backend.service.WorkspaceService
import com.scrapalot.backend.utils.grpcCall
import io.grpc.Status
import io.grpc.StatusRuntimeException
import mu.KotlinLogging
import net.devh.boot.grpc.server.service.GrpcService
import java.util.UUID
import com.scrapalot.backend.grpc.common.UUID as ProtoUUID

private val logger = KotlinLogging.logger {}

@Suppress("HasPlatformType") // gRPC grpcCall { } infers return type from proto builder — explicit types would be verbose
@GrpcService
class WorkspaceServiceImpl(
    private val workspaceService: WorkspaceService,
    private val userRepository: UserRepository,
) : WorkspaceServiceGrpcKt.WorkspaceServiceCoroutineImplBase() {
    // ── CRUD ─────────────────────────────────────────────────────────────────

    override suspend fun getWorkspace(request: GetWorkspaceRequest) =
        grpcCall {
            val workspaceId = request.workspaceId.uuid()
            val userId = request.userId.uuid()
            requireAccess(workspaceId, userId)
            workspaceService
                .findById(workspaceId)
                ?.toResponse()
                ?.also { logger.debug { "Retrieved workspace: $workspaceId for user: $userId" } }
                ?: throw StatusRuntimeException(Status.NOT_FOUND.withDescription("Workspace not found: $workspaceId"))
        }

    override suspend fun listWorkspaces(request: ListWorkspacesRequest) =
        grpcCall {
            val userId = request.userId.uuid()
            val workspaces = workspaceService.findAllAccessibleWorkspaces(userId)
            logger.debug { "Listed ${workspaces.size} workspaces for user: $userId" }
            WorkspaceListResponse.newBuilder().addAllWorkspaces(workspaces.map { it.toResponse() }).build()
        }

    override suspend fun createWorkspace(request: CreateWorkspaceRequest) =
        grpcCall {
            val userId = request.userId.uuid()
            val name = request.name.requireNotBlank("Workspace name")
            val description = if (request.hasDescription()) request.description else null
            workspaceService
                .createWorkspace(name, userId, description)
                .toResponse()
                .also { logger.info { "Created workspace for user: $userId" } }
        }

    override suspend fun updateWorkspace(request: UpdateWorkspaceRequest) =
        grpcCall {
            val workspaceId = request.workspaceId.uuid()
            requireEdit(workspaceId, request.userId.uuid())
            workspaceService
                .updateWorkspace(
                    workspaceId,
                    if (request.hasName()) request.name else null,
                    if (request.hasDescription()) request.description else null,
                ).toResponse()
                .also { logger.info { "Updated workspace: $workspaceId" } }
        }

    override suspend fun deleteWorkspace(request: DeleteWorkspaceRequest) =
        grpcCall {
            val workspaceId = request.workspaceId.uuid()
            requireOwner(workspaceId, request.userId.uuid())
            workspaceService.deleteWorkspace(workspaceId)
            logger.info { "Deleted workspace: $workspaceId" }
            statusOk("Workspace deleted successfully")
        }

    override suspend fun getDefaultWorkspace(request: ProtoUUID) =
        grpcCall {
            val userId = request.uuid()
            workspaceService
                .getDefaultWorkspace(userId)
                .toResponse()
                .also { logger.debug { "Retrieved default workspace for user: $userId" } }
        }

    // ── Sharing ──────────────────────────────────────────────────────────────

    override suspend fun shareWorkspace(request: ShareWorkspaceRequest) =
        grpcCall {
            val workspaceId = request.workspaceId.uuid()
            requireOwnerOrAdmin(workspaceId, request.ownerId.uuid())
            val permission =
                request.permission.also {
                    require(it in listOf("read", "write", "admin")) { "Invalid permission: $it. Must be 'read', 'write', or 'admin'" }
                }
            val sharedWith = request.sharedWithUserId.uuid()
            workspaceService.shareWorkspace(workspaceId, sharedWith, permission)
            logger.info { "Shared workspace: $workspaceId with user: $sharedWith, permission: $permission" }
            statusOk("Workspace shared successfully")
        }

    override suspend fun removeUserFromWorkspace(request: RemoveUserRequest) =
        grpcCall {
            val workspaceId = request.workspaceId.uuid()
            requireOwnerOrAdmin(workspaceId, request.ownerId.uuid())
            val userToRemove = request.userIdToRemove.uuid()
            workspaceService.removeWorkspaceAccess(workspaceId, userToRemove)
            logger.info { "Removed user: $userToRemove from workspace: $workspaceId" }
            statusOk("User removed from workspace successfully")
        }

    override suspend fun listWorkspaceUsers(request: ListWorkspaceUsersRequest) =
        grpcCall {
            val workspaceId = request.workspaceId.uuid()
            requireAccess(workspaceId, request.userId.uuid())
            val users =
                workspaceService.getWorkspaceUsers(workspaceId).mapNotNull { wu ->
                    userRepository.findById(wu.userId).orElse(null)?.let { user ->
                        WorkspaceUserInfo
                            .newBuilder()
                            .setUserId(wu.userId.toProto())
                            .setUsername(user.username ?: "")
                            .setEmail(user.email)
                            .setPermission(wu.permission)
                            .setSharedAt(wu.createdAt.toTimestamp())
                            .build()
                    }
                }
            logger.debug { "Listed ${users.size} users for workspace: $workspaceId" }
            WorkspaceUserListResponse.newBuilder().addAllUsers(users).build()
        }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private fun ProtoUUID.uuid(): UUID =
        runCatching { UUID.fromString(value) }
            .getOrElse { throw StatusRuntimeException(Status.INVALID_ARGUMENT.withDescription("Invalid UUID: $value")) }

    @Suppress("SameParameterValue")
    private fun String.requireNotBlank(field: String): String = takeIf { it.isNotBlank() } ?: throw StatusRuntimeException(Status.INVALID_ARGUMENT.withDescription("$field cannot be blank"))

    private fun requireAccess(
        workspaceId: UUID,
        userId: UUID
    ) {
        if (!workspaceService.hasAccess(workspaceId, userId)) {
            throw StatusRuntimeException(Status.PERMISSION_DENIED.withDescription("User does not have access to this workspace"))
        }
    }

    private fun requireEdit(
        workspaceId: UUID,
        userId: UUID
    ) {
        if (!workspaceService.canEdit(workspaceId, userId)) {
            throw StatusRuntimeException(Status.PERMISSION_DENIED.withDescription("User does not have permission to update this workspace"))
        }
    }

    private fun requireOwner(
        workspaceId: UUID,
        userId: UUID
    ) {
        if (!workspaceService.isOwner(workspaceId, userId)) {
            throw StatusRuntimeException(Status.PERMISSION_DENIED.withDescription("Only workspace owner can perform this action"))
        }
    }

    private fun requireOwnerOrAdmin(
        workspaceId: UUID,
        userId: UUID
    ) {
        if (!workspaceService.isOwner(workspaceId, userId) && workspaceService.getUserPermission(workspaceId, userId) != "admin") {
            throw StatusRuntimeException(Status.PERMISSION_DENIED.withDescription("Only workspace owner or admin can perform this action"))
        }
    }

    private fun statusOk(message: String) =
        StatusResponse
            .newBuilder()
            .setSuccess(true)
            .setMessage(message)
            .build()

    private fun UUID.toProto() = ProtoUUID.newBuilder().setValue(toString()).build()

    private fun java.time.Instant.toTimestamp() =
        Timestamp
            .newBuilder()
            .setSeconds(epochSecond)
            .setNanos(nano)
            .build()

    private fun com.scrapalot.backend.domain.workspace.Workspace.toResponse(): WorkspaceResponse {
        val wsId = requireNotNull(id) { "Persisted workspace must have an ID" }
        return WorkspaceResponse
            .newBuilder()
            .setId(wsId.toProto())
            .setName(name)
            .setIsDefault(false)
            .setOwnerId(userId.toProto())
            .setCreatedAt(createdAt.toTimestamp())
            .setUpdatedAt(updatedAt.toTimestamp())
            .apply { description?.let { setDescription(it) } }
            .build()
    }
}
