package com.scrapalot.backend.service

import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component
import java.io.File

private val logger = KotlinLogging.logger {}

/**
 * Source-of-truth for note image files on disk is the note's own HTML.
 *
 * - Upload: writes file under <uploadPath>/notes/images/<uuid>.<ext>.
 * - updateNote: diff old vs new HTML; any filename referenced by the
 *   old content but missing from the new one is deleted from disk.
 * - deleteNote: every filename referenced by the final HTML is deleted.
 *
 * No database tracking, no scheduled cleanup, no grace period — by design.
 * Tradeoff accepted: undo / Y.js late replay of an image removal within
 * the same save cycle can leave a broken <img>; in practice this is rare
 * and the user just re-uploads.
 */
@Component
class NoteImageStore(
    @param:Value("\${application.upload.path:/app/data/upload}")
    private val uploadPath: String,
) {
    private val imagesDir: File
        get() = File(uploadPath, NOTES_IMAGES_SUBDIR).canonicalFile

    /**
     * Delete files whose filenames appear in [previousHtml] but not in
     * [currentHtml]. Missing files and non-matching paths are ignored.
     */
    fun deleteRemoved(
        previousHtml: String?,
        currentHtml: String?
    ) {
        val before = extractFilenames(previousHtml)
        if (before.isEmpty()) return
        val after = extractFilenames(currentHtml)
        val removed = before - after
        if (removed.isEmpty()) return
        deleteAll(removed)
    }

    /** Delete every image file referenced by [html]. Used on note delete. */
    fun deleteAllInContent(html: String?) {
        val filenames = extractFilenames(html)
        if (filenames.isEmpty()) return
        deleteAll(filenames)
    }

    private fun deleteAll(filenames: Collection<String>) {
        val dir = imagesDir
        var removed = 0
        var failed = 0
        filenames.forEach { name ->
            val file = File(dir, name)
            // canonicalPath check to defend against "../" escapes even
            // though filenames come from our own regex of UUID.ext.
            if (file.exists() && file.canonicalPath.startsWith(dir.canonicalPath)) {
                if (file.delete()) removed++ else failed++
            }
        }
        if (removed > 0 || failed > 0) {
            logger.info { "Removed $removed note image file(s), failed=$failed" }
        }
    }

    companion object {
        const val NOTES_IMAGES_SUBDIR = "notes/images"

        /** Matches the paths produced by NoteController.saveNoteImage. */
        private val FILENAME_REGEX =
            Regex(
                "/upload/notes/images/([0-9a-fA-F-]{36}\\.(?:jpg|jpeg|png|gif|webp|svg))"
            )

        fun extractFilenames(html: String?): Set<String> {
            if (html.isNullOrBlank()) return emptySet()
            return FILENAME_REGEX.findAll(html).map { it.groupValues[1] }.toSet()
        }
    }
}
