package com.scrapalot.backend.service

import com.scrapalot.backend.domain.chat.Session
import com.scrapalot.backend.dto.CreateSessionRequest
import com.scrapalot.backend.dto.ProviderMetrics
import com.scrapalot.backend.dto.SessionDTO
import com.scrapalot.backend.dto.SessionListResponse
import com.scrapalot.backend.dto.SessionMetricsResponse
import com.scrapalot.backend.dto.UpdateSessionRequest
import com.scrapalot.backend.exception.NotFoundException
import com.scrapalot.backend.mapper.SessionMapper
import com.scrapalot.backend.repository.MessageRepository
import com.scrapalot.backend.repository.NoteRepository
import com.scrapalot.backend.repository.SessionRepository
import org.slf4j.LoggerFactory
import org.springframework.data.domain.Page
import org.springframework.data.domain.PageRequest
import org.springframework.data.domain.Sort
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.UUID

/**
 * Service for managing chat sessions
 */
@Service
class SessionService(
    private val sessionRepository: SessionRepository,
    private val messageRepository: MessageRepository,
    private val noteRepository: NoteRepository,
    private val sessionMapper: SessionMapper
) {
    private val logger = LoggerFactory.getLogger(SessionService::class.java)

    /**
     * Get all sessions for a user with pagination
     */
    @Transactional(readOnly = true)
    fun getSessionsByUserId(
        userId: UUID,
        page: Int = 0,
        pageSize: Int = 50,
        collectionId: UUID? = null,
        folderId: UUID? = null,
        unfiledOnly: Boolean = false
    ): SessionListResponse {
        logger.debug("Getting sessions for user: {}, page: {}, pageSize: {}, folderId: {}, unfiledOnly: {}", userId, page, pageSize, folderId, unfiledOnly)

        val pageable = PageRequest.of(page, pageSize, Sort.by(Sort.Direction.DESC, "updatedAt"))

        val sessionPage =
            when {
                folderId != null -> sessionRepository.findByUserIdAndSessionFolderIdOrderByUpdatedAtDesc(userId, folderId, pageable)
                unfiledOnly -> sessionRepository.findByUserIdAndSessionFolderIdIsNullOrderByUpdatedAtDesc(userId, pageable)
                collectionId != null -> sessionRepository.findByUserIdAndCollectionIdOrderByUpdatedAtDesc(userId, collectionId, pageable)
                else -> sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId, pageable)
            }

        return sessionPage.toListResponse(page, pageSize)
    }

    /**
     * Get a specific session by ID
     */
    @Transactional(readOnly = true)
    fun getSessionById(
        sessionId: UUID,
        userId: UUID
    ): SessionDTO {
        logger.debug("Getting session: {} for user: {}", sessionId, userId)

        val session =
            sessionRepository
                .findByIdAndUserId(sessionId, userId)
                .orElseThrow { NotFoundException("Session not found: $sessionId") }

        return session.toDto()
    }

    /**
     * Ensure conversation name is unique for a user by appending a numeric suffix if needed.
     * Returns null if the input name is null.
     */
    private fun ensureUniqueName(
        userId: UUID,
        name: String?,
        excludeSessionId: UUID? = null
    ): String? {
        if (name.isNullOrBlank()) return name

        val existing = sessionRepository.findByUserIdAndConversationName(userId, name)
        if (existing == null || existing.id == excludeSessionId) return name

        // Find a unique suffix
        var counter = 2
        while (true) {
            val candidate = "$name ($counter)"
            val match = sessionRepository.findByUserIdAndConversationName(userId, candidate)
            if (match == null || match.id == excludeSessionId) return candidate
            counter++
        }
    }

    /**
     * Create a new session
     */
    @Transactional
    fun createSession(
        userId: UUID,
        request: CreateSessionRequest
    ): SessionDTO {
        logger.info("Creating session for user: {}", userId)

        val uniqueName = ensureUniqueName(userId, request.conversationName)

        val session =
            Session(
                userId = userId,
                collectionId = request.collectionId,
                conversationName = uniqueName,
                lastModelUsed = request.lastModelUsed
            )
        val savedSession = sessionRepository.save(session)

        logger.info("Created session: {} for user: {}", savedSession.id, userId)
        return sessionMapper.toDto(savedSession).copy(messageCount = 0L)
    }

    /**
     * Update an existing session
     */
    @Transactional
    fun updateSession(
        sessionId: UUID,
        userId: UUID,
        request: UpdateSessionRequest
    ): SessionDTO {
        logger.info("Updating session: {} for user: {}", sessionId, userId)

        val session =
            sessionRepository
                .findByIdAndUserId(sessionId, userId)
                .orElseThrow { NotFoundException("Session not found: $sessionId") }

        // Ensure conversation name uniqueness BEFORE mapper sets it on the managed entity,
        // otherwise Hibernate auto-flush on the SELECT inside ensureUniqueName triggers
        // a constraint violation with the dirty (non-unique) name already on the entity.
        val uniqueName = request.conversationName?.let { ensureUniqueName(userId, it, excludeSessionId = sessionId) }

        sessionMapper.updateEntity(request, session)
        if (uniqueName != null) {
            session.conversationName = uniqueName
        }

        val updatedSession = sessionRepository.save(session)

        logger.info("Updated session: {}", updatedSession.id)
        return updatedSession.toDto()
    }

    /**
     * Set or clear a session's marker (priority emoji + palette color). Dedicated
     * path so it never collides with rename. Both values null = clear the marker.
     */
    @Transactional
    fun setSessionMarker(
        sessionId: UUID,
        userId: UUID,
        markerIcon: String?,
        markerColor: String?
    ): SessionDTO {
        val session =
            sessionRepository
                .findByIdAndUserId(sessionId, userId)
                .orElseThrow { NotFoundException("Session not found: $sessionId") }
        session.markerIcon = markerIcon?.takeIf { it.isNotBlank() }
        session.markerColor = markerColor?.takeIf { it.isNotBlank() }
        // Intentionally do NOT bump updatedAt — marking is not activity and must
        // not reorder the recency-sorted list.
        return sessionRepository.save(session).toDto()
    }

    /**
     * Pin or unpin a session. Dedicated path so it never collides with rename or
     * marker. Pinned sessions float to the top of their sidebar group (folder or
     * unfiled) regardless of recency.
     */
    @Transactional
    fun setSessionPin(
        sessionId: UUID,
        userId: UUID,
        isPinned: Boolean
    ): SessionDTO {
        val session =
            sessionRepository
                .findByIdAndUserId(sessionId, userId)
                .orElseThrow { NotFoundException("Session not found: $sessionId") }
        session.isPinned = isPinned
        // Like marking, pinning is not activity — but @PreUpdate still stamps
        // updatedAt on save, matching the existing marker behaviour.
        return sessionRepository.save(session).toDto()
    }

    /**
     * Delete a session
     */
    @Transactional
    fun deleteSession(
        sessionId: UUID,
        userId: UUID
    ) {
        logger.info("Deleting session: {} for user: {}", sessionId, userId)

        val session =
            sessionRepository
                .findByIdAndUserId(sessionId, userId)
                .orElseThrow { NotFoundException("Session not found: $sessionId") }

        noteRepository.deleteBySessionId(sessionId)
        sessionRepository.delete(session)
        logger.info("Deleted session: {}", sessionId)
    }

    /**
     * Search sessions by name
     */
    @Transactional(readOnly = true)
    fun searchSessions(
        userId: UUID,
        query: String,
        page: Int = 0,
        pageSize: Int = 50
    ): SessionListResponse {
        logger.debug("Searching sessions for user: {} with query: {}", userId, query)

        val pageable = PageRequest.of(page, pageSize)
        val sessionPage = sessionRepository.searchByUserIdAndName(userId, query, pageable)

        return sessionPage.toListResponse(page, pageSize)
    }

    /**
     * Find a session by the exact conversation name
     */
    @Transactional(readOnly = true)
    fun getSessionByName(
        userId: UUID,
        collectionId: UUID,
        documentIds: List<UUID>
    ): SessionDTO? {
        val name = generateSessionName(collectionId, documentIds)
        val session = sessionRepository.findByUserIdAndConversationName(userId, name) ?: return null
        return session.toDto()
    }

    /**
     * Find the first session for a user and collection
     */
    @Transactional(readOnly = true)
    fun getSessionByCollection(
        userId: UUID,
        collectionId: UUID
    ): SessionDTO? {
        val session =
            sessionRepository.findFirstByUserIdAndCollectionIdOrderByUpdatedAtDesc(userId, collectionId)
                ?: return null
        return session.toDto()
    }

    /**
     * Get aggregated token metrics for a session
     */
    @Transactional(readOnly = true)
    fun getSessionMetrics(
        sessionId: UUID,
        userId: UUID
    ): SessionMetricsResponse {
        if (!sessionRepository.existsByIdAndUserId(sessionId, userId)) {
            throw NotFoundException("Session not found: $sessionId")
        }

        val messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId)
        val assistantMessages = messages.filter { it.role == "assistant" }

        var totalTokens = 0L
        var totalCost = 0.0
        var totalTps = 0.0
        var tpsCount = 0
        val providers = mutableMapOf<String, MutableList<Map<String, Any>>>()

        for (msg in assistantMessages) {
            val metrics = msg.metadata?.get("token_metrics") as? Map<*, *> ?: continue

            val tokens = (metrics["total_tokens"] as? Number)?.toLong() ?: 0L
            val cost = (metrics["total_cost"] as? Number)?.toDouble() ?: 0.0
            val tps = (metrics["tokens_per_second"] as? Number)?.toDouble() ?: 0.0
            val provider = (metrics["provider"] as? String) ?: "unknown"

            totalTokens += tokens
            totalCost += cost
            if (tps > 0) {
                totalTps += tps
                tpsCount++
            }

            providers.getOrPut(provider) { mutableListOf() }.add(
                mapOf("tokens" to tokens, "cost" to cost)
            )
        }

        val providerMetrics =
            providers.mapValues { (_, entries) ->
                ProviderMetrics(
                    totalTokens = entries.sumOf { (it["tokens"] as? Number)?.toLong() ?: 0L },
                    totalCost = entries.sumOf { (it["cost"] as? Number)?.toDouble() ?: 0.0 },
                    requestCount = entries.size
                )
            }

        return SessionMetricsResponse(
            sessionId = sessionId,
            totalTokens = totalTokens,
            totalCost = totalCost,
            totalRequests = assistantMessages.size,
            avgTokensPerSecond = if (tpsCount > 0) totalTps / tpsCount else 0.0,
            providers = providerMetrics
        )
    }

    private fun Session.toDto(): SessionDTO {
        val messageCount = messageRepository.countBySessionId(id)
        // isPinned is set explicitly: Kotlin's Boolean `isX` getter/setter naming
        // (isPinned()/setPinned()) makes MapStruct see the property as `pinned`,
        // so it won't auto-map onto the DTO's `isPinned` field.
        return sessionMapper.toDto(this).copy(messageCount = messageCount, isPinned = isPinned)
    }

    private fun Page<Session>.toListResponse(
        page: Int,
        pageSize: Int
    ): SessionListResponse =
        SessionListResponse(
            sessions = content.map { it.toDto() },
            total = totalElements,
            page = page,
            pageSize = pageSize,
            totalPages = totalPages,
        )

    private fun generateSessionName(
        collectionId: UUID,
        documentIds: List<UUID>
    ): String {
        val sortedDocIds = documentIds.sorted().joinToString(",")
        return if (sortedDocIds.isNotEmpty()) {
            "session_${collectionId}_$sortedDocIds"
        } else {
            "session_$collectionId"
        }
    }
}
