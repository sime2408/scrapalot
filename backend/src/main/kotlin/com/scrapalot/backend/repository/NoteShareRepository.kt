package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.notes.NoteShare
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.stereotype.Repository
import java.util.UUID

@Suppress("unused")
@Repository
interface NoteShareRepository : JpaRepository<NoteShare, UUID> {
    fun findByNoteId(noteId: UUID): List<NoteShare>

    fun findByUserId(userId: UUID): List<NoteShare>

    fun findByNoteIdAndUserId(
        noteId: UUID,
        userId: UUID
    ): NoteShare?

    fun existsByNoteIdAndUserId(
        noteId: UUID,
        userId: UUID
    ): Boolean

    fun deleteByNoteIdAndUserId(
        noteId: UUID,
        userId: UUID
    ): Int

    fun deleteByNoteId(noteId: UUID): Int

    fun countByNoteId(noteId: UUID): Long
}
