package com.scrapalot.backend.controller.chat

import com.scrapalot.backend.dto.CreateMessageRequest
import com.scrapalot.backend.dto.MessageDTO
import com.scrapalot.backend.dto.MessageFeedbackRequest
import com.scrapalot.backend.dto.MessageListResponse
import com.scrapalot.backend.service.MessageService
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.*
import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.security.SecurityRequirement
import io.swagger.v3.oas.annotations.tags.Tag
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1/messages")
@Tag(name = "Messages", description = "Chat message management")
@SecurityRequirement(name = "bearerAuth")
class MessageController(
    private val messageService: MessageService,
    private val userService: UserService
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    @GetMapping
    @Operation(summary = "Get messages", description = "Get all messages for a specific session")
    fun getMessages(
        @AuthenticationPrincipal userDetails: UserDetails,
        @RequestParam sessionId: UUID,
        @RequestParam(defaultValue = "0") page: Int,
        @RequestParam(defaultValue = "100") pageSize: Int,
        @RequestParam(defaultValue = "false") all: Boolean,
        @RequestParam(defaultValue = "asc") order: String
    ): ResponseEntity<*> =
        resultOf {
            val userId = userDetails.userId()

            if (all) {
                messageService.getAllMessagesBySessionId(sessionId, userId)
            } else {
                messageService.getMessagesBySessionId(sessionId, userId, page, pageSize, order)
            }
        }.toResponseEntity()

    @GetMapping("/{messageId}")
    @Operation(summary = "Get message by ID", description = "Get a specific message by ID")
    fun getMessageById(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable messageId: UUID
    ): ResponseEntity<MessageDTO> =
        resultOf {
            val userId = userDetails.userId()
            messageService.getMessageById(messageId, userId)
        }.toResponseEntity()

    @PostMapping
    @Operation(summary = "Create message", description = "Create a new message in a session")
    fun createMessage(
        @AuthenticationPrincipal userDetails: UserDetails,
        @RequestBody request: CreateMessageRequest
    ): ResponseEntity<MessageDTO> =
        resultOf {
            val userId = userDetails.userId()
            messageService.createMessage(userId, request)
        }.toResponseEntity(HttpStatus.CREATED)

    @DeleteMapping("/{messageId}")
    @Operation(summary = "Delete message", description = "Delete a message")
    fun deleteMessage(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable messageId: UUID
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            messageService.deleteMessage(messageId, userId)
        }.toNoContentResponse()

    @GetMapping("/{messageId}/metrics")
    @Operation(summary = "Get message metrics", description = "Get token usage metrics for a specific message")
    fun getMessageMetrics(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable messageId: UUID
    ): ResponseEntity<Map<String, Any>?> =
        resultOf {
            val userId = userDetails.userId()
            messageService.getMessageMetrics(messageId, userId)
        }.toResponseEntity()

    @GetMapping("/search")
    @Operation(summary = "Search messages", description = "Search messages by content")
    fun searchMessages(
        @AuthenticationPrincipal userDetails: UserDetails,
        @RequestParam sessionId: UUID,
        @RequestParam query: String,
        @RequestParam(defaultValue = "0") page: Int,
        @RequestParam(defaultValue = "100") pageSize: Int
    ): ResponseEntity<MessageListResponse> =
        resultOf {
            val userId = userDetails.userId()
            messageService.searchMessages(sessionId, userId, query, page, pageSize)
        }.toResponseEntity()

    @PutMapping("/{messageId}/feedback")
    @Operation(summary = "Update message feedback", description = "Set thumbs up/down feedback on an AI message (1=positive, -1=negative, null=remove)")
    fun updateFeedback(
        @AuthenticationPrincipal userDetails: UserDetails,
        @PathVariable messageId: UUID,
        @RequestBody request: MessageFeedbackRequest
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            messageService.updateFeedback(messageId, userId, request)
        }.toNoContentResponse()

    @GetMapping("/latest")
    @Operation(summary = "Get latest message", description = "Get the latest message in a session")
    fun getLatestMessage(
        @AuthenticationPrincipal userDetails: UserDetails,
        @RequestParam sessionId: UUID
    ): ResponseEntity<MessageDTO?> =
        resultOf {
            val userId = userDetails.userId()
            messageService
                .getLatestMessage(sessionId, userId)
                .orNotFound("No messages found in session")
        }.toResponseEntity()
}
