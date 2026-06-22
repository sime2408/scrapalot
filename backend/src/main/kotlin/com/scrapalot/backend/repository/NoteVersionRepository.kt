package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.notes.NoteVersion
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.UUID

@Suppress("unused")
@Repository
interface NoteVersionRepository : JpaRepository<NoteVersion, UUID> {
    fun findByNoteIdOrderByVersionNumberDesc(noteId: UUID): List<NoteVersion>

    fun findByNoteIdAndVersionNumber(
        noteId: UUID,
        versionNumber: Int
    ): NoteVersion?

    @Query("SELECT MAX(nv.versionNumber) FROM NoteVersion nv WHERE nv.noteId = :noteId")
    fun findMaxVersionNumber(
        @Param("noteId") noteId: UUID
    ): Int?

    fun countByNoteId(noteId: UUID): Long

    fun deleteByNoteId(noteId: UUID): Int
}
