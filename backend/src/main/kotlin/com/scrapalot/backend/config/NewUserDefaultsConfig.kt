package com.scrapalot.backend.config

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory
import mu.KotlinLogging
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.io.ClassPathResource

private val logger = KotlinLogging.logger {}

data class NewUserDefaults(
    val generalSettings: Map<String, Any>,
    val documentProcessing: Map<String, Any>,
    val defaultWorkspaceName: String,
    val defaultCollectionName: String
)

@Configuration
class NewUserDefaultsConfig {
    @Bean
    fun newUserDefaults(): NewUserDefaults {
        val mapper = ObjectMapper(YAMLFactory())
        val resource = ClassPathResource("config-new-users.yaml")

        @Suppress("UNCHECKED_CAST")
        val config = mapper.readValue(resource.inputStream, Map::class.java) as Map<String, Any>

        @Suppress("UNCHECKED_CAST")
        val generalSettings = (config["general_settings"] as? Map<String, Any>) ?: emptyMap()

        @Suppress("UNCHECKED_CAST")
        val documentProcessing = (config["document_processing"] as? Map<String, Any>) ?: emptyMap()

        @Suppress("UNCHECKED_CAST")
        val defaultWorkspace = (config["default_workspace"] as? Map<String, Any>) ?: emptyMap()

        @Suppress("UNCHECKED_CAST")
        val defaultCollection = (config["default_collection"] as? Map<String, Any>) ?: emptyMap()

        val defaults =
            NewUserDefaults(
                generalSettings = generalSettings + mapOf("theme" to "system"),
                documentProcessing = documentProcessing,
                defaultWorkspaceName = defaultWorkspace["name"]?.toString() ?: "My Workspace",
                defaultCollectionName = defaultCollection["name"]?.toString() ?: "Research Papers"
            )

        logger.info { "Loaded new user defaults: workspace='${defaults.defaultWorkspaceName}', collection='${defaults.defaultCollectionName}'" }

        return defaults
    }
}
