package com.scrapalot.backend.domain.auth

import jakarta.persistence.*
import org.hibernate.annotations.UuidGenerator
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "users", schema = "scrapalot")
data class User(
    @Id
    @GeneratedValue
    @UuidGenerator
    @Column(columnDefinition = "uuid")
    var id: UUID? = null,
    @Column(nullable = true, unique = true, length = 50)
    var username: String? = null,
    @Column(nullable = true, unique = true, length = 100)
    var email: String? = null,
    @Column(nullable = true, length = 255)
    var password: String? = null,
    @Column(name = "first_name", nullable = true, length = 100)
    var firstName: String? = null,
    @Column(name = "last_name", nullable = true, length = 100)
    var lastName: String? = null,
    @Column(name = "profile_picture", nullable = true, length = 500)
    var profilePicture: String? = null,
    @Column(nullable = false, length = 20)
    var role: String = "user",
    // A superadmin keeps role="admin" (so all admin gates still apply) and
    // additionally may impersonate other admins. See migration 128.
    @Column(name = "is_superadmin", nullable = false)
    var isSuperadmin: Boolean = false,
    @Column(name = "is_active", nullable = false)
    var isActive: Boolean = true,
    @Column(name = "is_external", nullable = false)
    var isExternal: Boolean = false,
    @Column(name = "license_agreement_consent", nullable = false)
    var licenseAgreementConsent: Boolean = false,
    @Column(name = "content_sharing_consent", nullable = false)
    var contentSharingConsent: Boolean = true,
    @Column(name = "tour_completed", nullable = false)
    var tourCompleted: Boolean = false,
    @Column(name = "billing_exempt", nullable = false)
    var billingExempt: Boolean = false,
    // When the user consumed their one free trial (NULL = still available).
    @Column(name = "trial_used_at")
    var trialUsedAt: Instant? = null,
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
        if (other !is User) return false
        return id != null && id == other.id
    }

    override fun hashCode(): Int = id?.hashCode() ?: 0

    override fun toString(): String = "User(id=$id, username=$username, email=$email, role=$role, isActive=$isActive)"
}
