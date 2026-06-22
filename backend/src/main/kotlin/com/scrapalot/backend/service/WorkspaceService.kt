package com.scrapalot.backend.service

import com.scrapalot.backend.domain.workspace.Workspace
import com.scrapalot.backend.domain.workspace.WorkspaceUser
import com.scrapalot.backend.repository.CollectionRepository
import com.scrapalot.backend.repository.WorkspaceRepository
import com.scrapalot.backend.repository.WorkspaceUserRepository
import com.scrapalot.backend.utils.SlugUtils
import com.scrapalot.backend.utils.orThrow
import com.scrapalot.backend.utils.runAfterCommit
import mu.KotlinLogging
import org.springframework.data.domain.PageRequest
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.NoSuchElementException
import java.util.UUID

private val logger = KotlinLogging.logger {}

@Service
@Transactional
class WorkspaceService(
    private val workspaceRepository: WorkspaceRepository,
    private val workspaceUserRepository: WorkspaceUserRepository,
    private val collectionRepository: CollectionRepository,
    private val redisEventPublisher: RedisEventPublisher,
    private val collectionWorkspaceSyncService: CollectionWorkspaceSyncService,
    private val workspaceMemberSyncService: WorkspaceMemberSyncService,
    private val settingsService: SettingsService
) {
    @Transactional(readOnly = true)
    fun findById(id: UUID): Workspace? = workspaceRepository.findById(id).orElse(null)

    @Transactional(readOnly = true)
    fun findByUserId(userId: UUID): List<Workspace> = workspaceRepository.findByUserIdOrderByCreatedAtDesc(userId)

    @Transactional(readOnly = true)
    fun findAllAccessibleWorkspaces(userId: UUID): List<Workspace> = workspaceRepository.findAllAccessibleWorkspaces(userId)

    fun getDefaultWorkspace(userId: UUID): Workspace {
        // First check if user has a selected workspace in settings.
        // Must verify access — a stale selectedWorkspaceId pointing at a
        // workspace the user no longer belongs to (membership revoked,
        // admin impersonation seeded a foreign id, etc.) would otherwise
        // be returned and trigger a 403 storm on every workspace-scoped
        // call that checks requireAccess.
        val selectedWorkspaceId = settingsService.getSelectedWorkspace(userId)
        if (selectedWorkspaceId != null && hasAccess(selectedWorkspaceId, userId)) {
            val selectedWorkspace = workspaceRepository.findById(selectedWorkspaceId).orElse(null)
            if (selectedWorkspace != null) {
                return selectedWorkspace
            }
        }

        // Fallback: find oldest workspace
        val workspaces = workspaceRepository.findOldestByUserId(userId, PageRequest.of(0, 1))

        return if (workspaces.isNotEmpty()) {
            workspaces[0]
        } else {
            // Create default workspace if none exists
            createWorkspace("My Workspace", userId)
        }
    }

    fun createWorkspace(
        name: String,
        userId: UUID,
        description: String? = null
    ): Workspace {
        // Slug is set once on create and immutable across renames so OpenAI-SDK
        // consumers don't break when a user edits the workspace name.
        val slug =
            SlugUtils.uniqueSlugify(
                name = name,
                fallback = "workspace",
            ) { candidate -> workspaceRepository.existsBySlugAndUserId(candidate, userId) }

        val workspace =
            Workspace(
                name = name,
                slug = slug,
                description = description,
                userId = userId,
                isPublic = false,
                isShared = false,
                createdAt = Instant.now(),
                updatedAt = Instant.now()
            )

        val savedWorkspace = workspaceRepository.save(workspace)

        // Add owner to workspace_users table
        val workspaceUser =
            WorkspaceUser(
                workspaceId = savedWorkspace.id.orThrow("SavedWorkspace"),
                userId = userId,
                permission = "admin",
                createdAt = Instant.now(),
                updatedAt = Instant.now()
            )
        workspaceUserRepository.save(workspaceUser)

        logger.info { "Created workspace: ${savedWorkspace.id} for user: $userId" }

        val wsId = requireNotNull(savedWorkspace.id) { "Workspace must have an ID" }
        runAfterCommit {
            redisEventPublisher.publishWorkspaceEvent(
                type = EventType.WORKSPACE_CREATED,
                workspaceId = wsId,
                userId = userId,
                payload =
                    mapOf(
                        "workspace_name" to name,
                        "owner_user_id" to userId.toString()
                    )
            )
        }

        return savedWorkspace
    }

    fun updateWorkspace(
        workspaceId: UUID,
        name: String?,
        description: String?
    ): Workspace {
        val workspace =
            workspaceRepository.findById(workspaceId).orElseThrow {
                NoSuchElementException("Workspace not found: $workspaceId")
            }

        val updatedWorkspace =
            workspace.copy(
                name = name ?: workspace.name,
                description = description ?: workspace.description,
                updatedAt = Instant.now()
            )

        val saved = workspaceRepository.save(updatedWorkspace)

        val ownerUserId = workspace.userId
        val savedName = saved.name
        runAfterCommit {
            redisEventPublisher.publishWorkspaceEvent(
                type = EventType.WORKSPACE_UPDATED,
                workspaceId = workspaceId,
                userId = ownerUserId,
                payload =
                    mapOf(
                        "workspace_name" to savedName,
                        "owner_user_id" to ownerUserId.toString()
                    )
            )
            collectionWorkspaceSyncService.refreshSnapshot()
        }

        return saved
    }

    fun deleteWorkspace(workspaceId: UUID) {
        val workspace =
            workspaceRepository.findById(workspaceId).orElseThrow {
                NoSuchElementException("Workspace not found: $workspaceId")
            }

        // Check if workspace has collections
        val collectionCount = collectionRepository.countByWorkspaceId(workspaceId)
        if (collectionCount > 0) {
            throw IllegalStateException("Cannot delete workspace with collections")
        }

        workspaceRepository.deleteById(workspaceId)
        logger.info { "Deleted workspace: $workspaceId" }

        val ownerUserId = workspace.userId
        val wsName = workspace.name
        runAfterCommit {
            redisEventPublisher.publishWorkspaceEvent(
                type = EventType.WORKSPACE_DELETED,
                workspaceId = workspaceId,
                userId = ownerUserId,
                payload =
                    mapOf(
                        "workspace_name" to wsName,
                        "owner_user_id" to ownerUserId.toString()
                    )
            )
            collectionWorkspaceSyncService.refreshSnapshot()
        }
    }

    fun shareWorkspace(
        workspaceId: UUID,
        targetUserId: UUID,
        permission: String
    ): WorkspaceUser {
        val workspace =
            workspaceRepository.findById(workspaceId).orElseThrow {
                NoSuchElementException("Workspace not found: $workspaceId")
            }

        // Check if already shared
        val existing = workspaceUserRepository.findByWorkspaceIdAndUserId(workspaceId, targetUserId)
        val saved =
            if (existing != null) {
                // Update permission
                val updated =
                    existing.copy(
                        permission = permission,
                        updatedAt = Instant.now()
                    )
                logger.info { "Updated workspace share: $workspaceId with user: $targetUserId, permission: $permission" }
                workspaceUserRepository.save(updated)
            } else {
                // Create new share
                val workspaceUser =
                    WorkspaceUser(
                        workspaceId = workspaceId,
                        userId = targetUserId,
                        permission = permission,
                        createdAt = Instant.now(),
                        updatedAt = Instant.now()
                    )
                logger.info { "Shared workspace: $workspaceId with user: $targetUserId, permission: $permission" }
                workspaceUserRepository.save(workspaceUser)
            }

        // Flip the entity's is_shared flag the first time anyone besides the
        // owner is added. Without this the workspace looks "private" to every
        // consumer that filters on the flag (sidebar shared-badge, snapshot
        // exports). The flag is only flipped, never cleared, because
        // unsharing is handled separately and we want the indicator to stick
        // until the last extra member is removed.
        if (!workspace.isShared) {
            workspace.isShared = true
            workspaceRepository.save(workspace)
        }

        // Cross-service sync: tell Python the workspace acquired a new member
        // so its caches (collection_workspace snapshot, RAG access scopes)
        // reflect the share. Without the snapshot refresh + WORKSPACE_SHARED
        // event, an invited user's first deep-research call would still see
        // an empty collection set even though Kotlin's REST ACL accepted the
        // request. runAfterCommit() guarantees the publish only happens once
        // the transaction lands.
        val ownerUserId = workspace.userId
        val workspaceName = workspace.name
        runAfterCommit {
            redisEventPublisher.publishWorkspaceEvent(
                type = EventType.WORKSPACE_SHARED,
                workspaceId = workspaceId,
                userId = ownerUserId,
                payload =
                    mapOf(
                        "workspace_name" to workspaceName,
                        "owner_user_id" to ownerUserId.toString(),
                        "shared_with_user_id" to targetUserId.toString(),
                        "permission" to permission
                    )
            )
            collectionWorkspaceSyncService.refreshSnapshot()
            workspaceMemberSyncService.refreshSnapshot()
        }

        return saved
    }

    fun removeWorkspaceAccess(
        workspaceId: UUID,
        userId: UUID
    ) {
        val deleted = workspaceUserRepository.deleteByWorkspaceIdAndUserId(workspaceId, userId)
        if (deleted == 0) {
            throw NoSuchElementException("User does not have access to this workspace")
        }
        logger.info { "Removed workspace access: $workspaceId for user: $userId" }
        // Keep the Python-side membership snapshot in lockstep so revoked access
        // takes effect for agentic discovery / library inventory immediately.
        runAfterCommit { workspaceMemberSyncService.refreshSnapshot() }
    }

    // Get workspace users for controller
    @Transactional(readOnly = true)
    fun getWorkspaceUsers(workspaceId: UUID): List<WorkspaceUser> = workspaceUserRepository.findByWorkspaceId(workspaceId)

    @Transactional(readOnly = true)
    fun getUserPermission(
        workspaceId: UUID,
        userId: UUID
    ): String? {
        // Check if user is the owner
        val workspace = workspaceRepository.findById(workspaceId).orElse(null)
        if (workspace != null && workspace.userId == userId) {
            return "admin"
        }

        // Check workspace_users table
        return workspaceUserRepository.findPermissionByWorkspaceIdAndUserId(workspaceId, userId)
    }

    @Transactional(readOnly = true)
    fun hasAccess(
        workspaceId: UUID,
        userId: UUID
    ): Boolean {
        // Check if user is owner
        if (workspaceRepository.existsByIdAndUserId(workspaceId, userId)) {
            return true
        }

        // Check if user is in workspace_users
        return workspaceUserRepository.existsByWorkspaceIdAndUserId(workspaceId, userId)
    }

    @Transactional(readOnly = true)
    fun canEdit(
        workspaceId: UUID,
        userId: UUID
    ): Boolean {
        val permission = getUserPermission(workspaceId, userId)
        return permission in listOf("admin", "write")
    }

    @Transactional(readOnly = true)
    fun isOwner(
        workspaceId: UUID,
        userId: UUID
    ): Boolean = workspaceRepository.existsByIdAndUserId(workspaceId, userId)

    fun updateUserRole(
        workspaceId: UUID,
        targetUserId: UUID,
        permission: String
    ) {
        // Prevent changing workspace owner's role
        if (isOwner(workspaceId, targetUserId)) {
            throw IllegalArgumentException("Cannot change the workspace owner's role")
        }

        val existing =
            workspaceUserRepository.findByWorkspaceIdAndUserId(workspaceId, targetUserId)
                ?: throw NoSuchElementException("User does not have access to this workspace")

        val updated =
            existing.copy(
                permission = permission,
                updatedAt = Instant.now()
            )
        workspaceUserRepository.save(updated)

        logger.info { "Updated workspace role: $workspaceId, user: $targetUserId, permission: $permission" }
    }
}
