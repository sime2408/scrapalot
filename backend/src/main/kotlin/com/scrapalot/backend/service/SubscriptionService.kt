package com.scrapalot.backend.service

import com.scrapalot.backend.domain.user.SubscriptionPlan
import com.scrapalot.backend.domain.user.UserSubscription
import org.springframework.stereotype.Service
import java.time.Instant
import java.util.UUID

// (CE) Subscriptions / billing / quota are a hosted-only feature. This is an all-allowed
// stub so the Community Edition runs with no tiers, no usage limits and no Stripe — every
// self-hosted user has unlimited access to every feature. The hosted product ships the
// real SubscriptionService (Stripe, plans, quota enforcement, token metering).

enum class UsageType { STORAGE_BYTES, DOCUMENTS, TOKENS, WORKSPACES, COLLECTIONS, API_CALLS }

data class UsageLimitResult(
    val allowed: Boolean,
    val currentUsage: Long,
    val limit: Long,
    val remaining: Long,
    val usagePercentage: Double,
    val message: String? = null,
    val upgradeAvailable: Boolean = false,
    val suggestedPlan: String? = null,
)

data class UsageSummary(
    val userId: UUID,
    val planName: String,
    val storageUsedBytes: Long,
    val storageLimitBytes: Long,
    val storagePercentage: Double,
    val documentsUsed: Int,
    val documentsLimit: Int,
    val documentsPercentage: Double,
    val tokensUsed: Long,
    val tokensLimit: Long,
    val tokensPercentage: Double,
    val workspacesUsed: Int,
    val workspacesLimit: Int,
    val periodStart: Instant?,
    val periodEnd: Instant?,
    val daysRemaining: Int,
    val diskBytes: Long = 0,
    val dbContentBytes: Long = 0,
    val thumbnailBytes: Long = 0,
)

private const val UNLIMITED_LONG = Long.MAX_VALUE
private const val UNLIMITED_INT = Int.MAX_VALUE

@Service
class SubscriptionService {
    // Feature gating — everything is available in the Community Edition.
    fun hasFeature(userId: UUID, feature: String): Boolean = true

    fun hasFeatureOrAdmin(userId: UUID, feature: String): Boolean = true

    fun requireFeature(userId: UUID, feature: String) {
        // CE: no gating — all features are available.
    }

    // Usage limits — unlimited in the Community Edition (you run on your own hardware).
    fun checkUsageLimit(
        userId: UUID,
        usageType: UsageType,
        requestedAmount: Long = 0,
        workspaceId: UUID? = null,
        collectionId: UUID? = null,
    ): UsageLimitResult = UsageLimitResult(
        allowed = true,
        currentUsage = 0,
        limit = UNLIMITED_LONG,
        remaining = UNLIMITED_LONG,
        usagePercentage = 0.0,
    )

    fun getUsageSummary(userId: UUID): UsageSummary = UsageSummary(
        userId = userId,
        planName = "community",
        storageUsedBytes = 0,
        storageLimitBytes = UNLIMITED_LONG,
        storagePercentage = 0.0,
        documentsUsed = 0,
        documentsLimit = UNLIMITED_INT,
        documentsPercentage = 0.0,
        tokensUsed = 0,
        tokensLimit = UNLIMITED_LONG,
        tokensPercentage = 0.0,
        workspacesUsed = 0,
        workspacesLimit = UNLIMITED_INT,
        periodStart = null,
        periodEnd = null,
        daysRemaining = UNLIMITED_INT,
    )

    // No subscriptions in the Community Edition — these return null / no-op.
    fun getUserSubscriptionWithPlan(userId: UUID): Pair<UserSubscription, SubscriptionPlan>? = null

    fun createDefaultSubscription(userId: UUID): UserSubscription? = null

    fun createSubscription(
        userId: UUID,
        planId: UUID,
        billingCycle: String = "monthly",
        stripeSubscriptionId: String? = null,
        stripeCustomerId: String? = null,
        paymentMethod: String? = null,
    ): UserSubscription? = null
}
