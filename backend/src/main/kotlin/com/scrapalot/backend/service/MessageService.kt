package com.scrapalot.backend.service

import com.scrapalot.backend.dto.CreateMessageRequest
import com.scrapalot.backend.dto.MessageDTO
import com.scrapalot.backend.dto.MessageFeedbackRequest
import com.scrapalot.backend.dto.MessageListResponse
import com.scrapalot.backend.exception.NotFoundException
import com.scrapalot.backend.mapper.MessageMapper
import com.scrapalot.backend.repository.MessageRepository
import com.scrapalot.backend.repository.SessionRepository
import com.scrapalot.backend.utils.runAfterCommit
import org.slf4j.LoggerFactory
import org.springframework.data.domain.PageRequest
import org.springframework.data.domain.Sort
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.UUID

/**
 * Service for managing chat messages
 */
@Service
class MessageService(
    private val messageRepository: MessageRepository,
    private val sessionRepository: SessionRepository,
    private val messageMapper: MessageMapper,
    private val redisEventPublisher: RedisEventPublisher
) {
    private val logger = LoggerFactory.getLogger(MessageService::class.java)

    /**
     * Get all messages for a session with pagination
     */
    @Transactional(readOnly = true)
    fun getMessagesBySessionId(
        sessionId: UUID,
        userId: UUID,
        page: Int = 0,
        pageSize: Int = 100,
        order: String = "asc"
    ): MessageListResponse {
        logger.debug(
            "Getting messages for session: {}, page: {}, pageSize: {}, order: {}",
            sessionId,
            page,
            pageSize,
            order
        )

        // Verify session belongs to user
        if (!sessionRepository.existsByIdAndUserId(sessionId, userId)) {
            throw NotFoundException("Session not found: $sessionId")
        }

        // "desc" drives the chat UI's infinite-scroll history: page 0 is the
        // newest window. We fetch newest-first, then reverse the window back to
        // chronological order so a returned page is always internally ASC and
        // the client can prepend older pages without re-sorting. "asc" (default)
        // keeps the original behaviour for any other consumer.
        val descending = order.equals("desc", ignoreCase = true)
        val messagePage =
            if (descending) {
                val pageable = PageRequest.of(page, pageSize, Sort.by(Sort.Direction.DESC, "createdAt"))
                messageRepository.findBySessionIdOrderByCreatedAtDesc(sessionId, pageable)
            } else {
                val pageable = PageRequest.of(page, pageSize, Sort.by(Sort.Direction.ASC, "createdAt"))
                messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId, pageable)
            }

        val content = if (descending) messagePage.content.reversed() else messagePage.content
        val messages = messageMapper.toDtoList(content)

        return MessageListResponse(
            messages = messages,
            total = messagePage.totalElements,
            page = page,
            pageSize = pageSize,
            totalPages = messagePage.totalPages
        )
    }

    /**
     * Get all messages for a session (no pagination)
     */
    @Transactional(readOnly = true)
    fun getAllMessagesBySessionId(
        sessionId: UUID,
        userId: UUID
    ): List<MessageDTO> {
        logger.debug("Getting all messages for session: {}", sessionId)

        // Verify session belongs to user
        if (!sessionRepository.existsByIdAndUserId(sessionId, userId)) {
            throw NotFoundException("Session not found: $sessionId")
        }

        val messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId)
        return messageMapper.toDtoList(messages)
    }

    /**
     * Get a specific message by ID
     */
    @Transactional(readOnly = true)
    fun getMessageById(
        messageId: UUID,
        userId: UUID
    ): MessageDTO {
        logger.debug("Getting message: {}", messageId)

        val message =
            messageRepository
                .findById(messageId)
                .orElseThrow { NotFoundException("Message not found: $messageId") }

        // Verify session belongs to user
        if (!sessionRepository.existsByIdAndUserId(message.sessionId, userId)) {
            throw NotFoundException("Session not found: ${message.sessionId}")
        }

        return messageMapper.toDto(message)
    }

    /**
     * Create a new message
     */
    @Transactional
    fun createMessage(
        userId: UUID,
        request: CreateMessageRequest
    ): MessageDTO {
        logger.info("Creating message for session: {}", request.sessionId)

        // Verify session exists and belongs to user
        val session =
            sessionRepository
                .findByIdAndUserId(request.sessionId, userId)
                .orElseThrow { NotFoundException("Session not found: ${request.sessionId}") }

        val message = messageMapper.toEntity(request)
        val savedMessage = messageRepository.save(message)

        // Update session's updated_at timestamp
        session.updatedAt = savedMessage.createdAt
        sessionRepository.save(session)

        logger.info("Created message: {} for session: {}", savedMessage.id, request.sessionId)
        return messageMapper.toDto(savedMessage)
    }

    /**
     * Delete a message
     */
    @Transactional
    fun deleteMessage(
        messageId: UUID,
        userId: UUID
    ) {
        logger.info("Deleting message: {}", messageId)

        val message =
            messageRepository
                .findById(messageId)
                .orElseThrow { NotFoundException("Message not found: $messageId") }

        // Verify session belongs to user
        if (!sessionRepository.existsByIdAndUserId(message.sessionId, userId)) {
            throw NotFoundException("Session not found: ${message.sessionId}")
        }

        messageRepository.delete(message)
        logger.info("Deleted message: {}", messageId)
    }

    /**
     * Search messages by content
     */
    @Transactional(readOnly = true)
    fun searchMessages(
        sessionId: UUID,
        userId: UUID,
        query: String,
        page: Int = 0,
        pageSize: Int = 100
    ): MessageListResponse {
        logger.debug("Searching messages in session: {} with query: {}", sessionId, query)

        // Verify session belongs to user
        if (!sessionRepository.existsByIdAndUserId(sessionId, userId)) {
            throw NotFoundException("Session not found: $sessionId")
        }

        val pageable = PageRequest.of(page, pageSize)
        val messagePage = messageRepository.searchBySessionIdAndContent(sessionId, query, pageable)

        val messages = messageMapper.toDtoList(messagePage.content)

        return MessageListResponse(
            messages = messages,
            total = messagePage.totalElements,
            page = page,
            pageSize = pageSize,
            totalPages = messagePage.totalPages
        )
    }

    /**
     * Get token metrics for a specific message
     */
    @Transactional(readOnly = true)
    fun getMessageMetrics(
        messageId: UUID,
        userId: UUID
    ): Map<String, Any>? {
        val message =
            messageRepository
                .findById(messageId)
                .orElseThrow { NotFoundException("Message not found: $messageId") }

        if (!sessionRepository.existsByIdAndUserId(message.sessionId, userId)) {
            throw NotFoundException("Session not found: ${message.sessionId}")
        }

        @Suppress("UNCHECKED_CAST")
        return message.metadata?.get("token_metrics") as? Map<String, Any>
    }

    /**
     * Update feedback on a message (1=positive, -1=negative, null=remove).
     * Optionally accepts feedback_detail (1..5) for fine-grained EMA rating.
     *
     * After commit, publishes the event to scrapalot:stream:message_feedback so
     * the Python AI side can apply EMA reweighting to the touched graph elements
     * (Memify Pipeline).
     */
    @Transactional
    fun updateFeedback(
        messageId: UUID,
        userId: UUID,
        request: MessageFeedbackRequest
    ) {
        logger.debug(
            "Updating feedback for message: {}, feedback: {}, detail: {}",
            messageId,
            request.feedback,
            request.feedbackDetail
        )

        val message =
            messageRepository
                .findById(messageId)
                .orElseThrow { NotFoundException("Message not found: $messageId") }

        if (!sessionRepository.existsByIdAndUserId(message.sessionId, userId)) {
            throw NotFoundException("Message not found: $messageId")
        }

        messageRepository.updateFeedback(messageId, request.feedback, request.feedbackDetail)
        logger.debug("Updated feedback for message: {}", messageId)

        // Skip publish on null (feedback removal) — no graph reweight to do.
        val feedback = request.feedback ?: return
        val sessionId = message.sessionId
        val touched = message.usedGraphElementIds
        runAfterCommit {
            redisEventPublisher.publishMessageFeedback(
                messageId = messageId,
                sessionId = sessionId,
                userId = userId,
                feedback = feedback,
                feedbackDetail = request.feedbackDetail,
                usedGraphElementIds = touched,
                occurredAt = Instant.now()
            )
        }
    }

    /**
     * Get the latest message in a session
     */
    @Transactional(readOnly = true)
    fun getLatestMessage(
        sessionId: UUID,
        userId: UUID
    ): MessageDTO? {
        logger.debug("Getting latest message for session: {}", sessionId)

        // Verify session belongs to user
        if (!sessionRepository.existsByIdAndUserId(sessionId, userId)) {
            throw NotFoundException("Session not found: $sessionId")
        }

        return messageRepository
            .findFirstBySessionIdOrderByCreatedAtDesc(sessionId)
            .map { messageMapper.toDto(it) }
            .orElse(null)
    }
}
