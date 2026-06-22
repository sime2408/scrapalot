package com.scrapalot.backend.config

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Externalized LLM prompt templates loaded from prompts.yaml.
 * Use {placeholder} markers in templates and call [PromptTemplate.user] with substitutions at runtime.
 */
@ConfigurationProperties(prefix = "ai.prompts")
data class PromptsProperties(
    val collection: CollectionPrompts = CollectionPrompts(),
    val generation: GenerationPrompts = GenerationPrompts(),
    val notes: NotesPrompts = NotesPrompts(),
    val research: ResearchPrompts = ResearchPrompts()
) {
    data class CollectionPrompts(
        val generateDescription: PromptTemplate = PromptTemplate()
    )

    data class GenerationPrompts(
        val describe: PromptTemplate = PromptTemplate(),
        val suggest: PromptTemplate = PromptTemplate(),
        val summarize: PromptTemplate = PromptTemplate()
    )

    data class NotesPrompts(
        val translate: PromptTemplate = PromptTemplate(),
        val improveWriting: Map<String, String> = emptyMap()
    )

    data class ResearchPrompts(
        val templates: List<ResearchTemplate> = emptyList()
    )

    data class ResearchTemplate(
        val id: String = "",
        val name: String = "",
        val description: String = "",
        val templateType: String = "",
        val methodology: String = "",
        val tone: String = "",
        val citationStyle: String = "",
        val depth: Int = 3,
        val breadth: Int = 3,
        val outputFormat: String = "",
        val sourceTypes: List<String> = emptyList(),
        val isDefault: Boolean = false
    ) {
        fun toMap(): Map<String, Any> =
            mapOf(
                "id" to id,
                "name" to name,
                "description" to description,
                "template_type" to templateType,
                "methodology" to methodology,
                "tone" to tone,
                "citation_style" to citationStyle,
                "depth" to depth,
                "breadth" to breadth,
                "output_format" to outputFormat,
                "source_types" to sourceTypes,
                "is_default" to isDefault,
                "quality_standards" to emptyMap<String, Int>()
            )
    }

    data class PromptTemplate(
        val system: String = "",
        val user: String = ""
    ) {
        /** Return the user template with all {key} placeholders replaced. */
        fun user(vararg substitutions: Pair<String, String>): String = substitutions.fold(user) { acc, (key, value) -> acc.replace("{$key}", value) }
    }
}
