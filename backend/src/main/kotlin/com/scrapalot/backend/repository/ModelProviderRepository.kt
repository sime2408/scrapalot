package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.ai.ModelProvider
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.UUID

@Suppress("unused")
@Repository
interface ModelProviderRepository : JpaRepository<ModelProvider, UUID> {
    fun findByUserIdAndStatus(
        userId: UUID,
        status: String
    ): List<ModelProvider>

    fun findByUserIdIsNullAndStatus(status: String): List<ModelProvider>

    @Query(
        "SELECT p FROM ModelProvider p WHERE (p.userId = :userId OR p.userId IS NULL) AND p.status = :status"
    )
    fun findActiveForUser(
        @Param("userId") userId: UUID,
        @Param("status") status: String
    ): List<ModelProvider>

    fun findByProviderTypeAndStatusAndUserId(
        providerType: String,
        status: String,
        userId: UUID
    ): ModelProvider?

    fun findByProviderTypeAndStatusAndUserIdIsNull(
        providerType: String,
        status: String
    ): ModelProvider?

    @Query(
        "SELECT p FROM ModelProvider p WHERE p.providerType = :providerType AND p.status = 'active'"
    )
    fun findByProviderTypeAndStatusActive(
        @Param("providerType") providerType: String
    ): List<ModelProvider>
}
