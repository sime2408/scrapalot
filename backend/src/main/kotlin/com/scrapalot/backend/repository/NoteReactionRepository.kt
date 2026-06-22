package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.notes.NoteReaction
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.stereotype.Repository
import java.util.UUID

@Repository
interface NoteReactionRepository : JpaRepository<NoteReaction, UUID> {
    fun findByNoteId(noteId: UUID): List<NoteReaction>

    fun findByNoteIdAndUserIdAndEmoji(
        noteId: UUID,
        userId: UUID,
        emoji: String,
    ): NoteReaction?

    fun deleteByNoteIdAndUserIdAndEmoji(
        noteId: UUID,
        userId: UUID,
        emoji: String,
    ): Int

    fun deleteByNoteId(noteId: UUID): Int
}
