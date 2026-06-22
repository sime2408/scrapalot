package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.notes.NoteComment
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.UUID

@Suppress("unused")
@Repository
interface NoteCommentRepository : JpaRepository<NoteComment, UUID> {
    fun findByNoteIdOrderByCreatedAtAsc(noteId: UUID): List<NoteComment>

    fun findByParentCommentId(parentCommentId: UUID): List<NoteComment>

    fun findByNoteIdAndParentCommentIdIsNull(noteId: UUID): List<NoteComment>

    fun findByIsResolvedTrueAndNoteId(noteId: UUID): List<NoteComment>

    fun findByIsResolvedFalseAndNoteId(noteId: UUID): List<NoteComment>

    fun deleteByNoteId(noteId: UUID): Int

    fun countByNoteId(noteId: UUID): Long

    @Query("SELECT COUNT(nc) FROM NoteComment nc WHERE nc.noteId = :noteId AND nc.isResolved = false")
    fun countUnresolvedByNoteId(
        @Param("noteId") noteId: UUID
    ): Long
}
