package com.scrapalot.backend.domain.workspace

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import org.hibernate.annotations.JdbcTypeCode
import org.hibernate.type.SqlTypes
import java.time.OffsetDateTime
import java.util.UUID

/**
 * Workspace-level mapping from annotation color (hex) to a human-readable
 * label such as "critical", "insight" or "to-cite". Used by the PDF /
 * EPUB annotation popovers to show meaningful tooltips on the swatches
 * and by the annotation sidebar to filter by semantic category.
 */
@Entity
@Table(name = "annotation_color_semantics", schema = "scrapalot")
data class AnnotationColorSemantics(
    @Id
    @Column(name = "workspace_id", nullable = false, columnDefinition = "uuid")
    val workspaceId: UUID,
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "color_to_label", nullable = false, columnDefinition = "jsonb")
    var colorToLabel: Map<String, String> = emptyMap(),
    @Column(name = "created_at", nullable = false)
    val createdAt: OffsetDateTime = OffsetDateTime.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: OffsetDateTime = OffsetDateTime.now(),
)
