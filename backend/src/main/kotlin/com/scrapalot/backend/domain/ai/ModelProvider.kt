package com.scrapalot.backend.domain.ai

import com.scrapalot.backend.domain.auth.User
import io.hypersistence.utils.hibernate.type.json.JsonBinaryType
import jakarta.persistence.*
import org.hibernate.annotations.Type
import java.time.LocalDateTime
import java.util.UUID

@Entity
@Table(
    name = "model_providers",
    schema = "scrapalot",
    indexes = [
        Index(name = "idx_model_providers_name", columnList = "name"),
        Index(name = "idx_model_providers_user_id", columnList = "user_id")
    ]
)
class ModelProvider(
    @Id
    @Column(name = "id", nullable = false)
    var id: UUID = UUID.randomUUID(),
    @Column(name = "created_at", nullable = false, updatable = false)
    var createdAt: LocalDateTime = LocalDateTime.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: LocalDateTime = LocalDateTime.now(),
    @Column(name = "user_id", nullable = true)
    var userId: UUID? = null,
    @Column(name = "name", length = 100, nullable = false)
    var name: String,
    @Column(name = "provider_type", length = 50, nullable = false)
    var providerType: String = "local",
    @Column(name = "api_key", length = 255, nullable = true)
    var apiKey: String? = null,
    @Column(name = "api_base", length = 255, nullable = true)
    var apiBase: String? = null,
    @Column(name = "description", length = 500, nullable = true)
    var description: String? = null,
    @Suppress("unused") // JPA column — read via JSON serialization or future validation UI
    @Column(name = "show_models", nullable = false)
    var showModels: Boolean = true,
    @Column(name = "status", length = 50, nullable = false)
    var status: String = "active",
    @Suppress("unused") // JPA column — populated by Python validation sync
    @Column(name = "validation_status", length = 50, nullable = true)
    var validationStatus: String? = "unknown",
    @Suppress("unused") // JPA column — populated by Python validation sync
    @Column(name = "validation_error", columnDefinition = "TEXT", nullable = true)
    var validationError: String? = null,
    @Suppress("unused") // JPA column — populated by Python validation sync
    @Column(name = "last_validation_at", length = 50, nullable = true)
    var lastValidationAt: String? = null,
    @Suppress("unused") // JPA column — populated by Python validation sync
    @Column(name = "last_successful_validation_at", length = 50, nullable = true)
    var lastSuccessfulValidationAt: String? = null,
    @Type(JsonBinaryType::class)
    @Column(name = "settings", columnDefinition = "jsonb", nullable = true)
    var settings: Map<String, Any>? = null,
    // Relationships
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", insertable = false, updatable = false)
    var user: User? = null,
    @OneToMany(mappedBy = "provider", cascade = [CascadeType.ALL], orphanRemoval = true)
    var models: MutableList<ModelProviderModel> = mutableListOf()
) {
    @PreUpdate
    fun preUpdate() {
        updatedAt = LocalDateTime.now()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ModelProvider) return false
        return id == other.id
    }

    override fun hashCode(): Int = id.hashCode()

    override fun toString(): String = "ModelProvider(id=$id, name=$name, providerType=$providerType, status=$status, userId=$userId)"
}
