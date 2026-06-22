package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.ai.ModelProviderModel
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.UUID

@Repository
interface ModelProviderModelRepository : JpaRepository<ModelProviderModel, UUID> {
    fun findByProviderIdAndModelName(
        providerId: UUID,
        modelName: String
    ): ModelProviderModel?

    fun findByProviderId(providerId: UUID): List<ModelProviderModel>

    @Query(
        """
        SELECT m FROM ModelProviderModel m
        JOIN ModelProvider p ON m.providerId = p.id
        WHERE m.id = :modelId
          AND p.status = 'active'
          AND (p.userId = :userId OR p.userId IS NULL)
        """
    )
    fun findAccessibleModelById(
        @Param("modelId") modelId: UUID,
        @Param("userId") userId: UUID
    ): ModelProviderModel?
}
