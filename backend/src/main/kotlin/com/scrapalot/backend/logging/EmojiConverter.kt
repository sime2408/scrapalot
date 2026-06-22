package com.scrapalot.backend.logging

import ch.qos.logback.classic.pattern.ClassicConverter
import ch.qos.logback.classic.spi.ILoggingEvent

/**
 * Custom Logback converter that adds emoji icons based on the log level.

Based on the * * Python backend's ColorFormatter level_icons:
 * - WARNING: ⚠️ (warning sign)
 * - ERROR: ❌ (cross mark)
 * - CRITICAL: 🔥 (fire emoji)
 * - DEBUG/INFO/TRACE: No icon (empty string)
 *
 * Usage in logback-spring.xml:
 * ```xml
 * <conversionRule conversionWord="emoji" converterClass="com.scrapalot.backend.logging.EmojiConverter"/>
 * <pattern>%emoji%level %logger | %msg%n</pattern>
 * ```
 *
 * Example output:
 * ```
 * 2025-12-07 08:00:00 ⚠️[WARNING] com.scrapalot.backend.controller | Connection timeout
 * 2025-12-07 08:00:01 ❌[ERROR  ] com.scrapalot.backend.service   | Database connection failed
 * 2025-12-07 08:00:02 🔥[FATAL  ] com.scrapalot.backend          | System crash
 * 2025-12-07 08:00:03 [INFO   ] com.scrapalot.backend.controller | Request processed
 * ```
 */
class EmojiConverter : ClassicConverter() {
    companion object {
        /**
         * Level-to-emoji mappings matching Python backend.
         * Only WARNING, ERROR, and FATAL/CRITICAL have icons.
         */
        private val LEVEL_EMOJIS =
            mapOf(
                "WARN" to "⚠️", // Warning sign
                "WARNING" to "⚠️", // Warning sign
                "ERROR" to "❌", // Cross mark
                "FATAL" to "🔥", // Fire emoji (CRITICAL in Python)
                "CRITICAL" to "🔥" // Fire emoji
            )
    }

    override fun convert(event: ILoggingEvent): String {
        val level = event.level.toString()
        return LEVEL_EMOJIS[level] ?: ""
    }
}
