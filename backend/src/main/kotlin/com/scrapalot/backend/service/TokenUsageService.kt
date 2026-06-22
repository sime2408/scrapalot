package com.scrapalot.backend.service

import org.springframework.stereotype.Service
import java.math.BigDecimal
import java.util.UUID

// (CE) Token-usage metering is a hosted-only feature. No-op stub — the Community Edition
// does not meter, cap or bill token usage (you bring your own LLM key).
@Service
class TokenUsageService {
    fun incrementUsage(
        userId: UUID,
        inputTokens: Long,
        outputTokens: Long,
        costUsd: BigDecimal,
    ) {
        // no-op
    }
}
