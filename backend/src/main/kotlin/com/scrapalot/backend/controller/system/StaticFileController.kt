package com.scrapalot.backend.controller.system

import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Value
import org.springframework.core.io.FileSystemResource
import org.springframework.core.io.Resource
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RestController
import java.io.File
import java.nio.file.Paths
import java.util.*

private val logger = KotlinLogging.logger {}

/**
 * Controller for serving static files (backward compatibility with Python backend)
 */
@RestController
class StaticFileController(
    @param:Value("\${application.upload.path:/app/data/upload}")
    private val uploadPath: String
) {
    /**
     * Backward compatible endpoint for profile pictures
     * Python backend served files at: /upload/profile_pictures/{filename}
     */
    @GetMapping("/upload/profile_pictures/{filename}")
    fun getProfilePictureBackwardCompatible(
        @PathVariable filename: String
    ): ResponseEntity<Resource> =
        try {
            val (name, extension) = validateFilename(filename)
            val file = getProfilePictureFile(name, extension)
            val resource: Resource = FileSystemResource(file)
            val contentType = getContentType(extension)

            logger.debug { "Serving profile picture: $filename (${file.length()} bytes)" }

            ResponseEntity
                .ok()
                .contentType(contentType)
                .header(HttpHeaders.CACHE_CONTROL, "public, max-age=31536000")
                .body(resource)
        } catch (e: IllegalArgumentException) {
            logger.warn { e.message }
            ResponseEntity.badRequest().build()
        } catch (e: NoSuchElementException) {
            logger.warn { e.message }
            ResponseEntity.notFound().build()
        } catch (e: Exception) {
            logger.error(e) { "Get profile picture failed: ${e.message}" }
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build()
        }

    private fun validateFilename(filename: String): Pair<String, String> {
        val parts = filename.split(".")
        if (parts.size != 2) {
            throw IllegalArgumentException("Invalid filename format: $filename")
        }

        val (name, extension) = parts

        try {
            UUID.fromString(name)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("Invalid UUID in filename: $filename")
        }

        if (extension !in listOf("jpg", "jpeg", "png", "webp")) {
            throw IllegalArgumentException("Invalid file extension: $extension")
        }

        return name to extension
    }

    private fun getProfilePictureFile(
        name: String,
        extension: String
    ): File {
        val filePath = Paths.get(uploadPath, "profile_pictures", "$name.$extension")
        val file = filePath.toFile()

        if (!file.exists() || !file.isFile) {
            throw NoSuchElementException("Profile picture not found: $name.$extension")
        }

        return file
    }

    private fun getContentType(extension: String): MediaType =
        when (extension) {
            "png" -> MediaType.IMAGE_PNG
            "webp" -> MediaType.parseMediaType("image/webp")
            else -> MediaType.IMAGE_JPEG
        }
}
