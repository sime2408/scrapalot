package com.scrapalot.backend.dto

import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Pattern
import java.util.UUID

/** Record-a-view request body. */
data class RecordDocumentViewRequest(
    @field:NotNull
    val documentId: UUID,
    val collectionId: UUID? = null,
    @field:NotNull
    @field:Pattern(regexp = "^(pdf_open|epub_open|cited|rag_retrieved|note_linked)$")
    val source: String,
)

data class RecentDocumentResponse(
    val documentId: UUID,
    val collectionId: UUID?,
    val lastViewedAt: String,
    val source: String,
)

data class RecentDocumentsResponse(
    val recents: List<RecentDocumentResponse>,
)
