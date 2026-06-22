package com.scrapalot.backend.utils

/**
 * Slug helpers for workspace + collection routing identifiers.
 *
 * A slug is a lowercased, ASCII-only identifier derived from a human-readable
 * name, used by the OpenAI-compatible `/v1/chat/completions` shim as the
 * `model` field. Mirrors the backfill SQL in Liquibase changeset 115.
 */
object SlugUtils {
    private const val MAX_LEN = 120

    /**
     * Produce a slug from `name`: lowercased, non-alphanumeric runs collapsed
     * to a single `-`, leading/trailing dashes trimmed, capped at MAX_LEN.
     * Returns an empty string if nothing alphanumeric survives.
     */
    fun slugify(name: String): String {
        val collapsed =
            name
                .lowercase()
                .replace(Regex("[^a-z0-9]+"), "-")
                .trim('-')
        return if (collapsed.length <= MAX_LEN) collapsed else collapsed.substring(0, MAX_LEN).trim('-')
    }

    /**
     * Slugify `name` and disambiguate against `exists` by appending `-2`, `-3`,
     * ... until a free slot is found. `fallback` is used when slugify yields
     * an empty string (e.g. punctuation-only name).
     */
    fun uniqueSlugify(
        name: String,
        fallback: String,
        exists: (String) -> Boolean
    ): String {
        val base = slugify(name).ifEmpty { fallback }
        if (!exists(base)) return base
        var counter = 2
        while (counter < 1000) {
            val candidate = truncateForSuffix(base, counter) + "-" + counter
            if (!exists(candidate)) return candidate
            counter++
        }
        // Extremely unlikely; fall back to a base + timestamp suffix.
        return truncateForSuffix(base, 13) + "-" + System.currentTimeMillis()
    }

    private fun truncateForSuffix(
        base: String,
        suffixCounter: Int
    ): String {
        val suffixLen = suffixCounter.toString().length + 1 // includes the `-`
        val maxBase = MAX_LEN - suffixLen
        return if (base.length <= maxBase) base else base.substring(0, maxBase).trim('-')
    }
}
