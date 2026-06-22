package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.collection.Annotation
import com.scrapalot.backend.domain.collection.AnnotationShare
import com.scrapalot.backend.domain.collection.AnnotationShareId
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.UUID

@Suppress("unused")
@Repository
interface AnnotationShareRepository : JpaRepository<AnnotationShare, AnnotationShareId> {
    fun findByAnnotationId(annotationId: UUID): List<AnnotationShare>

    fun findByUserId(userId: UUID): List<AnnotationShare>

    fun findByAnnotationIdAndUserId(
        annotationId: UUID,
        userId: UUID
    ): AnnotationShare?

    fun existsByAnnotationIdAndUserId(
        annotationId: UUID,
        userId: UUID
    ): Boolean

    fun deleteByAnnotationIdAndUserId(
        annotationId: UUID,
        userId: UUID
    ): Int

    fun countByAnnotationId(annotationId: UUID): Long

    /**
     * Resolve the actual annotation rows the recipient has been granted
     * access to. Joins the share table back to annotations so the API
     * can return full annotation payloads in a single query.
     */
    @Query(
        value = """
            SELECT a FROM Annotation a
            WHERE a.id IN (
                SELECT s.annotationId FROM AnnotationShare s
                WHERE s.userId = :userId
            )
            ORDER BY a.createdAt DESC
        """
    )
    fun findAnnotationsSharedWith(
        @Param("userId") userId: UUID
    ): List<Annotation>
}
