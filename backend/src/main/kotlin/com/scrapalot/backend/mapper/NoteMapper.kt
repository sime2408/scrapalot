package com.scrapalot.backend.mapper

import com.scrapalot.backend.domain.notes.Note
import com.scrapalot.backend.domain.notes.NoteComment
import com.scrapalot.backend.domain.notes.NoteShare
import com.scrapalot.backend.domain.notes.NoteVersion
import com.scrapalot.backend.dto.CreateCommentRequest
import com.scrapalot.backend.dto.CreateNoteRequest
import com.scrapalot.backend.dto.NoteCommentResponse
import com.scrapalot.backend.dto.NoteResponse
import com.scrapalot.backend.dto.NoteShareResponse
import com.scrapalot.backend.dto.NoteVersionResponse
import com.scrapalot.backend.dto.ShareNoteRequest
import com.scrapalot.backend.dto.UpdateNoteRequest
import org.mapstruct.Mapper
import org.mapstruct.Mapping
import org.mapstruct.MappingTarget
import org.mapstruct.ReportingPolicy

/**
 * MapStruct mapper for Note entity and DTOs
 */
@Mapper(
    componentModel = "spring",
    unmappedTargetPolicy = ReportingPolicy.IGNORE
)
interface NoteMapper {
    /**
     * Convert Note entity to NoteResponse DTO
     */
    fun toNoteResponse(note: Note): NoteResponse

    /**
     * Convert a list of Note entities to a list of NoteResponse DTOs
     */
    fun toNoteResponseList(notes: List<Note>): List<NoteResponse>

    /**
     * Create a Note entity from CreateNoteRequest DTO
     */
    @Mapping(target = "id", ignore = true)
    @Mapping(target = "createdAt", ignore = true)
    @Mapping(target = "updatedAt", ignore = true)
    fun toNote(
        request: CreateNoteRequest,
        userId: java.util.UUID
    ): Note

    /**
     * Update Note entity from UpdateNoteRequest DTO
     * Note: isPublicNote and isPinnedNote use @get: JvmName to avoid "public"/"pinned" reserved keyword conflicts
     */
    @Mapping(target = "id", ignore = true)
    @Mapping(target = "noteType", ignore = true)
    @Mapping(target = "workspaceId", ignore = true)
    @Mapping(target = "userId", ignore = true)
    @Mapping(target = "sessionId", ignore = true)
    @Mapping(target = "isPublicNote", ignore = true)
    @Mapping(target = "createdAt", ignore = true)
    @Mapping(target = "updatedAt", ignore = true)
    fun updateNoteFromDto(
        request: UpdateNoteRequest,
        @MappingTarget note: Note
    )

    /**
     * Convert NoteVersion entity to NoteVersionResponse DTO
     */
    fun toNoteVersionResponse(version: NoteVersion): NoteVersionResponse

    /**
     * Convert list of NoteVersion entities to a list of NoteVersionResponse DTOs
     */
    fun toNoteVersionResponseList(versions: List<NoteVersion>): List<NoteVersionResponse>

    /**
     * Convert NoteComment entity to NoteCommentResponse DTO
     */
    fun toNoteCommentResponse(comment: NoteComment): NoteCommentResponse

    /**
     * Convert a list of NoteComment entities to a list of NoteCommentResponse DTOs
     */
    fun toNoteCommentResponseList(comments: List<NoteComment>): List<NoteCommentResponse>

    /**
     * Create NoteComment entity from CreateCommentRequest DTO
     */
    @Mapping(target = "id", ignore = true)
    @Mapping(target = "createdAt", ignore = true)
    @Mapping(target = "updatedAt", ignore = true)
    fun toNoteComment(
        request: CreateCommentRequest,
        noteId: java.util.UUID,
        userId: java.util.UUID
    ): NoteComment

    /**
     * Convert NoteShare entity to NoteShareResponse (Note: Entity has userId field only)
     */
    fun toNoteShareResponse(share: NoteShare): NoteShareResponse

    /**
     * Convert a list of NoteShare entities to a list of NoteShareResponse DTOs
     */
    fun toNoteShareResponseList(shares: List<NoteShare>): List<NoteShareResponse>

    /**
     * Create a NoteShare entity from ShareNoteRequest DTO
     */
    @Mapping(target = "id", ignore = true)
    @Mapping(target = "createdAt", ignore = true)
    @Mapping(target = "updatedAt", ignore = true)
    fun toNoteShare(
        request: ShareNoteRequest,
        noteId: java.util.UUID
    ): NoteShare
}
