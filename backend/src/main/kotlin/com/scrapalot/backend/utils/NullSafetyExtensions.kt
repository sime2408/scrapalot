package com.scrapalot.backend.utils

import java.util.NoSuchElementException
import java.util.UUID

/**
 * Extension functions for null-safe operations.
 * These replace dangerous !! operator usage with explicit error handling.
 */

/**
 * Safely unwrap UUID, throwing IllegalStateException with context if null.
 * Use this instead of id!! to provide better error messages.
 */
fun UUID?.orThrow(entityName: String): UUID = this ?: throw IllegalStateException("$entityName ID must not be null")

/**
 * Safely unwrap any value, throwing IllegalStateException with context if null.
 * Use this instead of value!! to provide better error messages.
 */
fun <T> T?.orThrow(fieldName: String): T = this ?: throw IllegalStateException("$fieldName must not be null")

/**
 * Safely get map value, throwing IllegalArgumentException if missing.
 * Use this instead of map["key"]!! to handle missing keys gracefully.
 */
fun <K, V> Map<K, V>.getOrThrow(
    key: K,
    errorMessage: String? = null
): V =
    this[key] ?: throw IllegalArgumentException(
        errorMessage ?: "Required key '$key' not found in map"
    )

/**
 * Safely get map value as String, throwing IllegalArgumentException if missing.
 */
fun Map<String, Any>.getStringOrThrow(key: String): String {
    val value = this[key] ?: throw IllegalArgumentException("Required key '$key' not found")
    return value as? String ?: throw IllegalArgumentException("Key '$key' is not a String")
}

/**
 * Unwrap a nullable entity lookup result, throwing NoSuchElementException if null.
 * Maps to 404 Not Found in REST responses via [toResponseEntity].
 * Use this instead of .toResult("...").getOrThrow() chains.
 */
fun <T> T?.orNotFound(message: String): T = this ?: throw NoSuchElementException(message)
