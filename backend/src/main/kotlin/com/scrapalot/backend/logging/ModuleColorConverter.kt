package com.scrapalot.backend.logging

import ch.qos.logback.classic.pattern.ClassicConverter
import ch.qos.logback.classic.spi.ILoggingEvent

/**
 * Custom Logback converter that colors module/logger names based on their type.
 *
 * Based on Python backend's ColorFormatter MODULE_COLORS mapping:
 * - AI/ML components: Light blue (\033[94m)
 * - Database/Storage: Blue/Purple (\033[34m, \033[35m)
 * - Security/Auth: Bright blue (\033[38;5;33m)
 * - Web Server/HTTP: Cyan (\033[96m)
 * - Graph/Entities: Light purple (\033[95m)
 *
 * The color codes match the Python backend exactly for visual consistency.
 *
 * Usage in logback-spring.xml:
 * ```xml
 * <conversionRule conversionWord="moduleColor" converterClass="com.scrapalot.backend.logging.ModuleColorConverter"/>
 * <pattern>%d{yyyy-MM-dd HH:MM:ss} %emoji[%-7level] %moduleColor{%-35logger{35}} | %msg%n</pattern>
 * ```
 *
 * Example output (with colors):
 * ```
 * 2025-12-07 08:00:00 [INFO   ] com.scrapalot.backend.security     | User authenticated (bright blue)
 * 2025-12-07 08:00:01 [INFO   ] com.scrapalot.backend.repository   | Database query executed (blue)
 * 2025-12-07 08:00:02 [INFO   ] com.scrapalot.backend.grpc         | gRPC request received (cyan)
 * ```
 */
class ModuleColorConverter : ClassicConverter() {
    companion object {
        // ANSI color codes
        private const val RESET = "\u001B[0m"

        /**
         * Module color mappings matching Python backend's MODULE_COLORS.
         * Colors are applied based on package/class name patterns.
         *
         * Sorted by priority (longest/most specific patterns first).
         */
        private val MODULE_COLORS =
            mapOf(
                // Security & Auth (bright blue)
                "security" to "\u001B[38;5;33m",
                "auth" to "\u001B[38;5;33m",
                "jwt" to "\u001B[38;5;33m",
                // Database & Storage
                "repository" to "\u001B[34m", // Blue
                "database" to "\u001B[33m", // Brown/yellow
                "postgres" to "\u001B[34m", // Blue
                "sql" to "\u001B[34m", // Blue
                "db" to "\u001B[34m", // Blue
                "cache" to "\u001B[35m", // Purple
                "redis" to "\u001B[35m", // Purple
                "memory" to "\u001B[1;34m", // Bold blue
                // Graph & Entities
                "entity" to "\u001B[95m", // Light purple
                "graph" to "\u001B[95m", // Light purple
                // Web Server & HTTP
                "controller" to "\u001B[96m", // Cyan (API endpoints)
                "grpc" to "\u001B[96m", // Cyan (gRPC server)
                "http" to "\u001B[93m", // Light yellow
                "api" to "\u001B[93m", // Light yellow
                "request" to "\u001B[93m", // Light yellow
                // AI/ML Components (if added later)
                "llm" to "\u001B[94m", // Light blue
                "embedding" to "\u001B[94m", // Light blue
                "rag" to "\u001B[92m", // Light green
                // Service layer (default color - no specific color, will use level color)
                "service" to "" // No color (uses level color)
            )
    }

    override fun convert(event: ILoggingEvent): String {
        val loggerName = event.loggerName ?: return ""

        // Truncate logger name intelligently (matching Python _truncate_logger_name)
        val truncated = truncateLoggerName(loggerName, 35)

        // Find matching color based on package patterns
        val color = getModuleColor(loggerName.lowercase())

        return if (color.isNotEmpty()) {
            "$color$truncated$RESET"
        } else {
            truncated
        }
    }

    /**
     * Determine the appropriate ANSI color for a logger name based on package patterns.
     * Matches Python backend's _get_logger_color() logic.
     */
    private fun getModuleColor(loggerNameLower: String): String {
        // Sort by length (longest/most specific first) to prioritize specific matches
        val sortedPatterns = MODULE_COLORS.entries.sortedByDescending { it.key.length }

        // Check each pattern to see if it matches the logger name
        for ((pattern, color) in sortedPatterns) {
            if (loggerNameLower.contains(pattern)) {
                return color
            }
        }

        return "" // No specific color, use default
    }

    /**
     * Intelligently truncate logger names that are too long.
     * Matches Python backend's _truncate_logger_name() logic.
     *
     * Examples:
     * - com.scrapalot.backend.controller.user.UserController -> c.s.b.c.UserController (padded to 35)
     * - com.scrapalot.backend.service.UserService -> c.s.b.s.UserService (padded to 35)
     * - short.name -> short.name (padded to 35)
     */
    @Suppress("SameParameterValue")
    private fun truncateLoggerName(
        loggerName: String,
        maxWidth: Int = 35
    ): String {
        if (loggerName.isEmpty()) {
            return " ".repeat(maxWidth)
        }

        // If the name fits, pad it to the required width
        if (loggerName.length <= maxWidth) {
            return loggerName.padEnd(maxWidth)
        }

        // Split by dots
        val parts = loggerName.split(".")

        // If only one part, truncate directly (length > maxWidth is guaranteed at this point)
        if (parts.size == 1) {
            return "${loggerName.take(maxWidth - 3)}...".padEnd(maxWidth)
        }

        // Progressive abbreviation: keep last part full, abbreviate earlier parts
        val lastPart = parts.last()
        val remaining = maxWidth - lastPart.length - (parts.size - 1) // Account for dots

        // If even with abbreviation it doesn't fit, truncate last part too
        val finalLastPart =
            if (remaining < parts.size - 1) {
                lastPart.take(maxWidth / 2)
            } else {
                lastPart
            }

        // Abbreviate all parts except the last one (take first character of each)
        val abbreviated = parts.dropLast(1).map { it.firstOrNull()?.toString() ?: "" }

        // Build the final abbreviated name
        val result = "${abbreviated.joinToString(".")}.$finalLastPart"

        return result.padEnd(maxWidth)
    }
}
