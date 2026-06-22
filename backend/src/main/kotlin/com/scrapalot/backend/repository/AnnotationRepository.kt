package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.collection.Annotation
import org.springframework.data.domain.Page
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.UUID

@Suppress("unused")
@Repository
interface AnnotationRepository : JpaRepository<Annotation, UUID> {
    fun findByDocumentIdAndUserIdOrderBySortIndex(
        documentId: UUID,
        userId: UUID
    ): List<Annotation>

    fun findByDocumentIdOrderBySortIndex(documentId: UUID): List<Annotation>

    fun findByCollectionIdAndUserIdOrderByCreatedAtDesc(
        collectionId: UUID,
        userId: UUID
    ): List<Annotation>

    fun findByCollectionIdAndUserIdOrderByCreatedAtDesc(
        collectionId: UUID,
        userId: UUID,
        pageable: Pageable
    ): Page<Annotation>

    fun findByUserIdOrderByCreatedAtDesc(userId: UUID): List<Annotation>

    fun countByDocumentIdAndUserId(
        documentId: UUID,
        userId: UUID
    ): Long

    fun deleteByDocumentIdAndUserId(
        documentId: UUID,
        userId: UUID
    )

    @Query(
        """
        SELECT a FROM Annotation a
        WHERE a.documentId = :documentId
        AND a.userId = :userId
        AND a.annotationType = :type
        ORDER BY a.sortIndex
    """
    )
    fun findByDocumentAndType(
        @Param("documentId") documentId: UUID,
        @Param("userId") userId: UUID,
        @Param("type") type: Short
    ): List<Annotation>

    @Query(
        """
        SELECT a FROM Annotation a
        WHERE a.documentId IN :documentIds
        AND a.userId = :userId
        ORDER BY a.documentId, a.sortIndex
    """
    )
    fun findByDocumentIdsAndUserId(
        @Param("documentIds") documentIds: List<UUID>,
        @Param("userId") userId: UUID
    ): List<Annotation>

    @Query(
        """
        SELECT DISTINCT a.documentId FROM Annotation a
        WHERE a.collectionId = :collectionId
        AND a.userId = :userId
    """
    )
    fun findAnnotatedDocumentIds(
        @Param("collectionId") collectionId: UUID,
        @Param("userId") userId: UUID
    ): List<UUID>

    @Query(
        """
        SELECT DISTINCT a.documentId FROM Annotation a
        WHERE a.userId = :userId
        AND (LOWER(a.selectedText) LIKE LOWER(CONCAT('%', :query, '%'))
             OR LOWER(a.comment) LIKE LOWER(CONCAT('%', :query, '%')))
    """
    )
    fun searchByText(
        @Param("userId") userId: UUID,
        @Param("query") query: String
    ): List<UUID>

    /**
     * Full-text search across annotation comments using the GIN-indexed
     * `comment_tsv` column (migration 110). Falls back to ILIKE when the
     * tsquery rejects the input (e.g. punctuation only) so the caller
     * never sees an exception for unusual queries.
     */
    @Query(
        value = """
            SELECT * FROM scrapalot.annotations a
            WHERE a.user_id = :userId
            AND (
                a.comment_tsv @@ plainto_tsquery('simple', :query)
                OR a.comment ILIKE CONCAT('%', :query, '%')
            )
            ORDER BY a.created_at DESC
            LIMIT :maxResults
        """,
        nativeQuery = true,
    )
    fun searchByComment(
        @Param("userId") userId: UUID,
        @Param("query") query: String,
        @Param("maxResults") maxResults: Int,
    ): List<Annotation>
}
