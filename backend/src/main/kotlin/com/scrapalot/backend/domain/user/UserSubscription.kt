package com.scrapalot.backend.domain.user

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "user_subscriptions", schema = "scrapalot")
data class UserSubscription(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    var userId: UUID,
    @Column(name = "subscription_plan_id", nullable = false, columnDefinition = "uuid")
    var subscriptionPlanId: UUID,
    @Column(nullable = false, length = 20)
    var status: String = "active",
    @Column(name = "billing_cycle", nullable = false, length = 20)
    var billingCycle: String = "monthly",
    @Column(name = "payment_method", nullable = true, length = 50)
    var paymentMethod: String? = null,
    @Column(name = "stripe_subscription_id", nullable = true, length = 255)
    var stripeSubscriptionId: String? = null,
    @Column(name = "stripe_customer_id", nullable = true, length = 255)
    var stripeCustomerId: String? = null,
    @Column(name = "current_period_start", nullable = true)
    var currentPeriodStart: Instant? = null,
    @Column(name = "current_period_end", nullable = true)
    var currentPeriodEnd: Instant? = null,
    @Column(name = "cancel_at_period_end", nullable = false)
    var cancelAtPeriodEnd: Boolean = false,
    // Subscribed at the BYOK (bring-your-own-key) discounted price.
    @Column(nullable = false)
    var byok: Boolean = false,
    @Column(name = "subscribed_at", nullable = true)
    var subscribedAt: Instant? = null,
    @Column(name = "cancelled_at", nullable = true)
    var cancelledAt: Instant? = null,
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
        if (other !is UserSubscription) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "UserSubscription(id=$id, userId=$userId, status='$status', billingCycle='$billingCycle')"
}
