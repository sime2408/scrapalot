package com.scrapalot.backend.grpc

import com.scrapalot.backend.domain.notes.Note
import com.scrapalot.backend.grpc.common.StatusResponse
import com.scrapalot.backend.grpc.common.Timestamp
import com.scrapalot.backend.grpc.notes.*
import com.scrapalot.backend.repository.NoteRepository
import com.scrapalot.backend.utils.grpcCall
import io.grpc.Status
import io.grpc.StatusException
import mu.KotlinLogging
import net.devh.boot.grpc.server.service.GrpcService
import java.util.UUID
import com.scrapalot.backend.grpc.common.UUID as ProtoUUID

private val logger = KotlinLogging.logger {}

@Suppress("HasPlatformType") // gRPC grpcCall { } infers return type from proto builder — explicit types would be verbose
@GrpcService
class NotesServiceImpl(
    private val noteRepository: NoteRepository,
) : NotesServiceGrpcKt.NotesServiceCoroutineImplBase() {
    // ── CRUD ─────────────────────────────────────────────────────────────────

    override suspend fun createNote(request: CreateNoteRequest) =
        grpcCall {
            noteRepository
                .save(
                    Note(
                        title = request.title,
                        content = request.content.takeIf { it.isNotEmpty() },
                        noteType = request.noteType,
                        tags = request.tagsList.takeIf { it.isNotEmpty() },
                        workspaceId = UUID.fromString(request.workspaceId.value),
                        userId = UUID.fromString(request.userId.value),
                        sessionId = if (request.hasSessionId()) UUID.fromString(request.sessionId.value) else null,
                        isPublic = request.isPublic,
                        isPinned = request.isPinned,
                    )
                ).also { logger.debug { "Created note: ${it.id} for user ${it.userId}" } }
                .toNoteInfo()
        }

    override suspend fun getNote(request: ProtoUUID) =
        grpcCall {
            val noteId = UUID.fromString(request.value)
            (
                noteRepository.findById(noteId).orElse(null)
                    ?: throw StatusException(Status.NOT_FOUND.withDescription("Note not found: $noteId"))
            ).also { logger.debug { "Retrieved note: $noteId" } }
                .toNoteInfo()
        }

    override suspend fun listNotes(request: ListNotesRequest) =
        grpcCall {
            val userId = UUID.fromString(request.userId.value)
            val notes =
                when {
                    request.hasSessionId() -> noteRepository.findBySessionId(UUID.fromString(request.sessionId.value))
                    request.hasWorkspaceId() -> noteRepository.findByWorkspaceIdAndUserId(UUID.fromString(request.workspaceId.value), userId)
                    else -> noteRepository.findByUserId(userId)
                }
            val paginated = notes.drop(request.skip.coerceAtLeast(0)).take(request.limit.coerceIn(1, 100))
            logger.debug { "Listed ${paginated.size} notes for user $userId" }
            ListNotesResponse
                .newBuilder()
                .addAllNotes(paginated.map { it.toNoteInfo() })
                .setTotal(notes.size)
                .build()
        }

    override suspend fun updateNote(request: UpdateNoteRequest) =
        grpcCall {
            val noteId = UUID.fromString(request.noteId.value)
            val note =
                noteRepository.findById(noteId).orElse(null)
                    ?: throw StatusException(Status.NOT_FOUND.withDescription("Note not found: $noteId"))
            noteRepository
                .save(
                    note.copy(
                        title = if (request.hasTitle()) request.title else note.title,
                        content = if (request.hasContent()) request.content else note.content,
                        noteType = if (request.hasNoteType()) request.noteType else note.noteType,
                        tags = request.tagsList.takeIf { it.isNotEmpty() } ?: note.tags,
                        isPublic = if (request.hasIsPublic()) request.isPublic else note.isPublic,
                        isPinned = if (request.hasIsPinned()) request.isPinned else note.isPinned,
                    )
                ).also { logger.debug { "Updated note: $noteId" } }
                .toNoteInfo()
        }

    override suspend fun deleteNote(request: ProtoUUID) =
        grpcCall {
            val noteId = UUID.fromString(request.value)
            if (!noteRepository.existsById(noteId)) throw StatusException(Status.NOT_FOUND.withDescription("Note not found: $noteId"))
            noteRepository.deleteById(noteId)
            logger.info { "Deleted note: $noteId" }
            StatusResponse
                .newBuilder()
                .setSuccess(true)
                .setMessage("Note deleted successfully")
                .build()
        }

    // ── Stubs ────────────────────────────────────────────────────────────────

    override suspend fun shareNote(request: ShareNoteRequest): NoteShareInfo = unimplemented("Share note")

    override suspend fun listShares(request: ProtoUUID): ListSharesResponse = unimplemented("List shares")

    override suspend fun revokeShare(request: RevokeShareRequest): StatusResponse = unimplemented("Revoke share")

    override suspend fun createComment(request: CreateCommentRequest): NoteCommentInfo = unimplemented("Create comment")

    override suspend fun listComments(request: ProtoUUID): ListCommentsResponse = unimplemented("List comments")

    override suspend fun updateComment(request: UpdateCommentRequest): NoteCommentInfo = unimplemented("Update comment")

    override suspend fun deleteComment(request: DeleteCommentRequest): StatusResponse = unimplemented("Delete comment")

    override suspend fun resolveComment(request: ProtoUUID): NoteCommentInfo = unimplemented("Resolve comment")

    override suspend fun listVersions(request: ProtoUUID): ListVersionsResponse = unimplemented("List versions")

    override suspend fun getVersion(request: GetVersionRequest): NoteVersionInfo = unimplemented("Get version")

    override suspend fun restoreVersion(request: GetVersionRequest): NoteInfo = unimplemented("Restore version")

    private fun <T> unimplemented(op: String): T = throw StatusException(Status.UNIMPLEMENTED.withDescription("$op not yet implemented"))

    // ── Helpers ──────────────────────────────────────────────────────────────

    private fun Any.toProto() = ProtoUUID.newBuilder().setValue(toString()).build()

    private fun java.time.Instant.toTs() = Timestamp.newBuilder().setSeconds(epochSecond).build()

    private fun Note.toNoteInfo() =
        NoteInfo
            .newBuilder()
            .setId(requireNotNull(id) { "Note ID is null" }.toProto())
            .setTitle(title)
            .setNoteType(noteType)
            .setWorkspaceId(workspaceId.toProto())
            .setUserId(userId.toProto())
            .setIsPublic(isPublic)
            .setIsPinned(isPinned)
            .setCreatedAt(createdAt.toTs())
            .setUpdatedAt(updatedAt.toTs())
            .apply {
                content?.let { setContent(it) }
                sessionId?.let { setSessionId(it.toProto()) }
                tags?.let { addAllTags(it) }
            }.build()
}
