package com.scrapalot.backend.dto

import java.util.UUID

data class ResolvedModel(
    val providerId: UUID,
    val providerName: String,
    val providerType: String,
    val modelName: String,
    val modelId: UUID?,
    val apiKey: String?,
    val apiBase: String?,
    val isSystemProvider: Boolean
)
