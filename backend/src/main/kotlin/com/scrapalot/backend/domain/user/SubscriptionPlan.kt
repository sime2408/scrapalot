package com.scrapalot.backend.domain.user

import jakarta.persistence.*
import org.hibernate.annotations.JdbcTypeCode
import org.hibernate.annotations.UuidGenerator
import org.hibernate.type.SqlTypes
import java.math.BigDecimal
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "subscription_plans", schema = "scrapalot")
data class SubscriptionPlan(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(nullable = false, unique = true, length = 100)
    var name: String,
    @Column(name = "display_name", nullable = true, length = 100)
    var displayName: String? = null,
    @Column(columnDefinition = "TEXT")
    var description: String? = null,
    @Column(name = "price_monthly", nullable = false, precision = 10, scale = 2)
    var priceMonthly: BigDecimal,
    @Column(name = "price_annual", nullable = true, precision = 10, scale = 2)
    var priceAnnual: BigDecimal? = null,
    @Column(name = "storage_limit_bytes", nullable = true)
    var storageLimitBytes: Long? = null,
    @Column(name = "documents_limit", nullable = true)
    var documentsLimit: Int? = null,
    @Column(name = "tokens_limit", nullable = true)
    var tokensLimit: Long? = null,
    @Column(name = "max_workspaces", nullable = true)
    var maxWorkspaces: Int? = null,
    @Column(name = "max_collections_per_workspace", nullable = true)
    var maxCollectionsPerWorkspace: Int? = null,
    @Column(name = "max_documents_per_collection", nullable = true)
    var maxDocumentsPerCollection: Int? = null,
    @Column(name = "stripe_price_id_monthly", nullable = true, length = 100)
    var stripePriceIdMonthly: String? = null,
    @Column(name = "stripe_price_id_annual", nullable = true, length = 100)
    var stripePriceIdAnnual: String? = null,
    // BYOK (bring-your-own-key) price variant — NULL = no BYOK option.
    @Column(name = "price_monthly_byok")
    var priceMonthlyByok: BigDecimal? = null,
    @Column(name = "price_annual_byok")
    var priceAnnualByok: BigDecimal? = null,
    @Column(name = "stripe_price_id_monthly_byok")
    var stripePriceIdMonthlyByok: String? = null,
    @Column(name = "stripe_price_id_annual_byok")
    var stripePriceIdAnnualByok: String? = null,
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    var features: Map<String, Any>? = null,
    @Column(name = "sort_order", nullable = true)
    var sortOrder: Int? = null,
    @Column(name = "is_active", nullable = false)
    var isActive: Boolean = true,
    @Column(name = "trial_days", nullable = false)
    var trialDays: Int = 0,
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: Instant = Instant.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: Instant = Instant.now()
) {
    @PreUpdate
    fun onUpdate() {
        updatedAt = Instant.now()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is SubscriptionPlan) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "SubscriptionPlan(id=$id, name='$name', priceMonthly=$priceMonthly, isActive=$isActive)"
}
