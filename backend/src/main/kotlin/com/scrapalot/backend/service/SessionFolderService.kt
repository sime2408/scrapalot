package com.scrapalot.backend.service

import com.scrapalot.backend.domain.chat.SessionFolder
import com.scrapalot.backend.dto.CreateSessionFolderRequest
import com.scrapalot.backend.dto.MoveSessionRequest
import com.scrapalot.backend.dto.SessionFolderDTO
import com.scrapalot.backend.dto.UpdateSessionFolderRequest
import com.scrapalot.backend.exception.NotFoundException
import com.scrapalot.backend.repository.SessionFolderRepository
import com.scrapalot.backend.repository.SessionRepository
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.UUID

@Service
class SessionFolderService(
    private val sessionFolderRepository: SessionFolderRepository,
    private val sessionRepository: SessionRepository
) {
    private val logger = LoggerFactory.getLogger(SessionFolderService::class.java)

    @Transactional(readOnly = true)
    fun getFoldersByUserId(userId: UUID): List<SessionFolderDTO> {
        logger.debug("Getting session folders for user: {}", userId)

        return sessionFolderRepository.findByUserIdOrderByPositionAsc(userId).map { folder ->
            val sessionCount = sessionRepository.countByUserIdAndSessionFolderId(userId, folder.id)
            toDto(folder, sessionCount)
        }
    }

    @Transactional
    fun createFolder(
        userId: UUID,
        request: CreateSessionFolderRequest
    ): SessionFolderDTO {
        logger.info("Creating session folder for user: {}", userId)

        require(request.name.isNotBlank()) { "Folder name must not be blank" }

        val existing = sessionFolderRepository.findByUserIdAndName(userId, request.name.trim())
        require(existing == null) { "Folder with name '${request.name.trim()}' already exists" }

        val position = sessionFolderRepository.countByUserId(userId).toInt()

        val folder =
            SessionFolder(
                userId = userId,
                name = request.name.trim(),
                position = position
            )
        val saved = sessionFolderRepository.save(folder)

        logger.info("Created session folder: {} for user: {}", saved.id, userId)
        return toDto(saved, 0)
    }

    @Transactional
    fun updateFolder(
        folderId: UUID,
        userId: UUID,
        request: UpdateSessionFolderRequest
    ): SessionFolderDTO {
        logger.info("Updating session folder: {} for user: {}", folderId, userId)

        val folder =
            sessionFolderRepository
                .findByIdAndUserId(folderId, userId)
                .orElseThrow { NotFoundException("Session folder not found: $folderId") }

        request.name?.trim()?.takeIf { it.isNotBlank() }?.let { newName ->
            val existing = sessionFolderRepository.findByUserIdAndName(userId, newName)
            require(existing == null || existing.id == folderId) { "Folder with name '$newName' already exists" }
            folder.name = newName
        }

        request.position?.let { folder.position = it }

        val updated = sessionFolderRepository.save(folder)
        val sessionCount = sessionRepository.countByUserIdAndSessionFolderId(userId, folderId)

        logger.info("Updated session folder: {}", updated.id)
        return toDto(updated, sessionCount)
    }

    @Transactional
    fun deleteFolder(
        folderId: UUID,
        userId: UUID
    ) {
        logger.info("Deleting session folder: {} for user: {}", folderId, userId)

        val folder =
            sessionFolderRepository
                .findByIdAndUserId(folderId, userId)
                .orElseThrow { NotFoundException("Session folder not found: $folderId") }

        sessionRepository.clearFolderReferences(folderId)
        sessionFolderRepository.delete(folder)

        logger.info("Deleted session folder: {}", folderId)
    }

    @Transactional
    fun moveSession(
        sessionId: UUID,
        userId: UUID,
        request: MoveSessionRequest
    ) {
        logger.info("Moving session: {} to folder: {} for user: {}", sessionId, request.sessionFolderId, userId)

        val session =
            sessionRepository
                .findByIdAndUserId(sessionId, userId)
                .orElseThrow { NotFoundException("Session not found: $sessionId") }

        request.sessionFolderId?.let { folderId ->
            require(sessionFolderRepository.existsByIdAndUserId(folderId, userId)) {
                "Session folder not found: $folderId"
            }
        }

        session.sessionFolderId = request.sessionFolderId
        sessionRepository.save(session)

        logger.info("Moved session: {} to folder: {}", sessionId, request.sessionFolderId)
    }

    private fun toDto(
        folder: SessionFolder,
        sessionCount: Long
    ): SessionFolderDTO =
        SessionFolderDTO(
            id = folder.id,
            userId = folder.userId,
            name = folder.name,
            position = folder.position,
            sessionCount = sessionCount,
            createdAt = folder.createdAt,
            updatedAt = folder.updatedAt
        )
}
