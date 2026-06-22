package com.scrapalot.backend.service

import com.scrapalot.backend.domain.notes.NoteReaction
import com.scrapalot.backend.repository.NoteReactionRepository
import com.scrapalot.backend.repository.NoteRepository
import mu.KotlinLogging
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.NoSuchElementException
import java.util.UUID

private val logger = KotlinLogging.logger {}

/**
 * Migration 117 — reaction toggle for the page-meta row.
 *
 * One row per (note, user, emoji). `addReaction` is idempotent: a
 * duplicate INSERT is caught and treated as "already exists". Removal
 * is via the same triple. List + group helpers fan out the rows so the
 * UI can show "👍 3, ❤️ 1" chips without an extra round trip.
 */
@Service
@Transactional
class NoteReactionService(
    private val noteRepository: NoteRepository,
    private val noteReactionRepository: NoteReactionRepository,
) {
    fun addReaction(
        noteId: UUID,
        userId: UUID,
        emoji: String
    ): NoteReaction {
        val cleaned = emoji.trim()
        logger.info { "addReaction enter note=$noteId user=$userId emoji='$cleaned' bytes=${cleaned.toByteArray(Charsets.UTF_8).size}" }
        require(cleaned.isNotEmpty()) { "Emoji is required" }
        require(cleaned.length <= 32) { "Emoji must be ≤ 32 characters" }

        // Surface a clear error if the note has been deleted out from
        // under the caller — the foreign key would catch it anyway, but
        // the JPA exception is much less actionable on the client.
        if (!noteRepository.existsById(noteId)) {
            logger.warn { "addReaction: note $noteId does not exist via noteRepository.existsById" }
            throw NoSuchElementException("Note not found: $noteId")
        }

        // Toggle-on idempotent: if the same (note, user, emoji) row
        // already exists, return it instead of trying to insert again.
        val existing = noteReactionRepository.findByNoteIdAndUserIdAndEmoji(noteId, userId, cleaned)
        if (existing != null) {
            logger.info { "addReaction: existing row returned id=${existing.id}" }
            return existing
        }

        return try {
            val saved =
                noteReactionRepository.save(
                    NoteReaction(
                        noteId = noteId,
                        userId = userId,
                        emoji = cleaned,
                    ),
                )
            logger.info { "addReaction: SAVED id=${saved.id} (will commit on tx end)" }
            saved
        } catch (ex: DataIntegrityViolationException) {
            // Race window between findByNoteIdAndUserIdAndEmoji() and
            // save() — fall back to whatever's now in the table.
            logger.warn(ex) { "Race on note_reaction insert ($noteId, $userId, $cleaned) — returning existing row" }
            noteReactionRepository.findByNoteIdAndUserIdAndEmoji(noteId, userId, cleaned)
                ?: throw ex
        }
    }

    fun removeReaction(
        noteId: UUID,
        userId: UUID,
        emoji: String
    ): Boolean {
        val cleaned = emoji.trim()
        val removed = noteReactionRepository.deleteByNoteIdAndUserIdAndEmoji(noteId, userId, cleaned)
        return removed > 0
    }

    @Transactional(readOnly = true)
    fun listForNote(noteId: UUID): List<NoteReaction> = noteReactionRepository.findByNoteId(noteId)
}
