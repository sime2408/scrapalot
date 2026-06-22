package com.scrapalot.backend.dto

import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size

data class AiGenerateRequest(
    @field:NotBlank(message = "Prompt is required")
    @field:Size(max = 10000, message = "Prompt must be at most 10000 characters")
    val prompt: String,
    val systemPrompt: String? = null,
    val modelName: String? = null,
    val temperature: Double? = null,
    val maxTokens: Int? = null,
    val stream: Boolean = false
)

data class AiGenerateResponse(
    val content: String,
    val model: String,
    val inputTokens: Long,
    val outputTokens: Long,
    val totalTokens: Long
)
