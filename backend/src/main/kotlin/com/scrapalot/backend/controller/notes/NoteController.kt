package com.scrapalot.backend.controller.notes

import com.scrapalot.backend.config.PromptsProperties
import com.scrapalot.backend.domain.notes.Note
import com.scrapalot.backend.domain.notes.NoteComment
import com.scrapalot.backend.domain.notes.NoteReaction
import com.scrapalot.backend.domain.notes.NoteVersion
import com.scrapalot.backend.dto.AddReactionRequest
import com.scrapalot.backend.dto.CollaborationClearedResponse
import com.scrapalot.backend.dto.CreateCommentRequest
import com.scrapalot.backend.dto.CreateNoteRequest
import com.scrapalot.backend.dto.NoteCommentResponse
import com.scrapalot.backend.dto.NoteImageResponse
import com.scrapalot.backend.dto.NoteReactionGroupResponse
import com.scrapalot.backend.dto.NoteReactionResponse
import com.scrapalot.backend.dto.NoteResponse
import com.scrapalot.backend.dto.NoteVersionResponse
import com.scrapalot.backend.dto.PaginatedNotesResponse
import com.scrapalot.backend.dto.SaveNamedVersionRequest
import com.scrapalot.backend.dto.ShareNoteRequest
import com.scrapalot.backend.dto.UpdateCommentRequest
import com.scrapalot.backend.dto.UpdateNoteRequest
import com.scrapalot.backend.grpc.ChatGrpcClient
import com.scrapalot.backend.service.EventType
import com.scrapalot.backend.service.ModelProviderService
import com.scrapalot.backend.service.NoteReactionService
import com.scrapalot.backend.service.NoteService
import com.scrapalot.backend.service.RedisEventPublisher
import com.scrapalot.backend.service.SubscriptionService
import com.scrapalot.backend.service.UsageType
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.service.WorkspaceService
import com.scrapalot.backend.utils.*
import jakarta.validation.Valid
import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Value
import org.springframework.core.io.FileSystemResource
import org.springframework.core.io.Resource
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import org.springframework.web.multipart.MultipartFile
import java.io.File
import java.nio.file.Files
import java.util.NoSuchElementException
import java.util.UUID

private val logger = KotlinLogging.logger {}

@RestController
@RequestMapping("/api/v1/notes")
class NoteController(
    private val noteService: NoteService,
    private val noteReactionService: NoteReactionService,
    private val workspaceService: WorkspaceService,
    private val userService: UserService,
    private val redisEventPublisher: RedisEventPublisher,
    private val chatGrpcClient: ChatGrpcClient,
    private val modelProviderService: ModelProviderService,
    private val prompts: PromptsProperties,
    private val subscriptionService: SubscriptionService,
    @param:Value("\${application.upload.path:data/upload}")
    private val uploadPath: String
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    @GetMapping
    fun getNotes(
        @RequestParam(required = false) workspaceId: UUID?,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<NoteResponse>> =
        resultOf {
            val userId = userDetails.userId()

            val notes =
                if (workspaceId != null) {
                    workspaceService.requireAccess(workspaceId, userId)
                    noteService.findAccessibleNotes(workspaceId, userId)
                } else {
                    workspaceService
                        .findAllAccessibleWorkspaces(userId)
                        .flatMap { workspace ->
                            noteService.findAccessibleNotes(workspace.id.orThrow("Workspace"), userId)
                        }
                }

            notes.map { it.toResponse() }
        }.toResponseEntity()

    /**
     * Datoteka → Otvori dialog: paginated + category-scoped list.
     * category: academic / writing / social / personal / review / uncategorized / null (all).
     *
     * Query param names are snake_case to match the rest of the frontend's
     * notes endpoints; Spring MVC does not auto-convert camelCase to
     * snake_case on query strings (Jackson snake_case config applies only
     * to request bodies).
     */
    @GetMapping("/paged")
    fun getNotesPaged(
        @RequestParam("workspace_id") workspaceId: UUID,
        @RequestParam(value = "category", required = false) category: String?,
        @RequestParam(value = "q", required = false) q: String?,
        @RequestParam(value = "page", defaultValue = "1") page: Int,
        @RequestParam(value = "page_size", defaultValue = "20") pageSize: Int,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<PaginatedNotesResponse> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireAccess(workspaceId, userId)

            val safePage = if (page < 1) 1 else page
            val safePageSize = pageSize.coerceIn(1, 100)
            val pageable =
                org.springframework.data.domain.PageRequest
                    .of(safePage - 1, safePageSize)

            val result =
                noteService.findAccessibleNotesByCategory(
                    workspaceId = workspaceId,
                    userId = userId,
                    category = category,
                    q = q,
                    pageable = pageable
                )

            PaginatedNotesResponse(
                items = result.content.map { it.toResponse() },
                page = safePage,
                pageSize = safePageSize,
                total = result.totalElements
            )
        }.toResponseEntity()

    @GetMapping("/{noteId}")
    fun getNote(
        @PathVariable noteId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<NoteResponse> =
        resultOf {
            val userId = userDetails.userId()
            val note =
                noteService
                    .findById(noteId)
                    .orNotFound("Note not found: $noteId")
            workspaceService.requireAccess(note.workspaceId, userId)

            note.toResponse()
        }.toResponseEntity()

    @GetMapping("/search")
    fun searchNotes(
        @RequestParam workspaceId: UUID,
        @RequestParam query: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<NoteResponse>> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireAccess(workspaceId, userId)

            noteService.searchByTitle(workspaceId, query).map { it.toResponse() }
        }.toResponseEntity()

    // Get notes linked to a specific document
    @GetMapping("/by-document/{documentId}")
    fun getNotesByDocument(
        @PathVariable documentId: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<NoteResponse>> =
        resultOf {
            val userId = userDetails.userId()
            noteService.findByDocumentId(documentId, userId).map { it.toResponse() }
        }.toResponseEntity()

    @PostMapping
    fun createNote(
        @Valid @RequestBody request: CreateNoteRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<NoteResponse> =
        resultOf {
            val userId = userDetails.userId()
            workspaceService.requireAccess(request.workspaceId, userId)

            val note =
                noteService.createNote(
                    title = request.title,
                    content = request.content,
                    workspaceId = request.workspaceId,
                    userId = userId,
                    noteType = request.noteType,
                    tags = request.tags,
                    sessionId = request.sessionId,
                    documentId = request.documentId,
                    category = request.category,
                    isPublic = request.isPublic,
                    isPinned = request.isPinned
                )

            // Publish Redis event for WebSocket distribution
            publishNoteEvent(
                noteId = note.id.orThrow("Note"),
                eventType = EventType.NOTE_CREATED,
                workspaceId = request.workspaceId,
                userId = userId,
                data = mapOf("note" to note.toResponse())
            )

            note.toResponse()
        }.toResponseEntity(HttpStatus.CREATED)

    /**
     * Fetch the server-persisted Research Context
     * for a note. Returns null when unset; the frontend falls back to
     * the user's default / localStorage cache.
     */
    @GetMapping("/{noteId}/research-context")
    fun getNoteResearchContext(
        @PathVariable noteId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> =
        resultOf {
            val userId = userDetails.userId()
            val note = noteService.findById(noteId).orNotFound("Note not found: $noteId")
            workspaceService.requireAccess(note.workspaceId, userId)
            mapOf("research_context" to note.researchContext)
        }.toResponseEntity()

    /**
     * Replace (not merge) the server-persisted
     * Research Context. Body: `{ research_context: {...} | null }`.
     * Pass `null` to clear. Editor permission required.
     */
    @PutMapping("/{noteId}/research-context")
    fun setNoteResearchContext(
        @PathVariable noteId: UUID,
        @RequestBody body: Map<String, Any?>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> =
        resultOf {
            val userId = userDetails.userId()

            @Suppress("UNCHECKED_CAST")
            val context = body["research_context"] as? Map<String, Any?>
            val note = noteService.setResearchContext(noteId, userId, context)
            mapOf("research_context" to note.researchContext)
        }.toResponseEntity()

    @PutMapping("/{noteId}")
    fun updateNote(
        @PathVariable noteId: UUID,
        @Valid @RequestBody request: UpdateNoteRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<NoteResponse> =
        resultOf {
            val userId = userDetails.userId()

            val note =
                noteService.updateNote(
                    noteId = noteId,
                    userId = userId,
                    title = request.title,
                    content = request.content,
                    tags = request.tags,
                    category = request.category,
                    isPinned = request.isPinned,
                    createVersion = request.createVersion,
                    emoji = request.emoji,
                    status = request.status,
                    headerImageUrl = request.headerImageUrl,
                    fontScale = request.fontScale,
                )

            // Publish Redis event for WebSocket distribution
            publishNoteEvent(
                noteId = noteId,
                eventType = EventType.NOTE_UPDATED,
                workspaceId = note.workspaceId,
                userId = userId,
                data = mapOf("note" to note.toResponse())
            )

            note.toResponse()
        }.toResponseEntity()

    @DeleteMapping("/{noteId}")
    fun deleteNote(
        @PathVariable noteId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()

            // Get note before deletion for workspaceId
            val note =
                noteService
                    .findById(noteId)
                    .orNotFound("Note not found: $noteId")
            val workspaceId = note.workspaceId

            noteService.deleteNote(noteId, userId)

            // Publish Redis event for WebSocket distribution
            publishNoteEvent(
                noteId = noteId,
                eventType = EventType.NOTE_DELETED,
                workspaceId = workspaceId,
                userId = userId,
                data = mapOf("noteId" to noteId.toString())
            )
        }.toNoContentResponse()

    // Version Management

    @GetMapping("/{noteId}/versions")
    fun getNoteVersions(
        @PathVariable noteId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<NoteVersionResponse>> =
        resultOf {
            val userId = userDetails.userId()
            val note =
                noteService
                    .findById(noteId)
                    .orNotFound("Note not found: $noteId")
            workspaceService.requireAccess(note.workspaceId, userId)

            noteService.getVersions(noteId).map { it.toResponse() }
        }.toResponseEntity()

    // 7.9 — explicit "save version" the user fires from the toolbar.
    // Pairs with the existing implicit auto-snapshot path on update —
    // both end up in note_versions, but kind='named' rows are surfaced
    // separately in the sidebar so the writer can navigate meaningful
    // save-points instead of every auto-coalesced entry.
    @PostMapping("/{noteId}/versions/save-named")
    fun saveNamedVersion(
        @PathVariable noteId: UUID,
        @Valid @RequestBody request: SaveNamedVersionRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<NoteVersionResponse> =
        resultOf {
            val userId = userDetails.userId()
            val note =
                noteService
                    .findById(noteId)
                    .orNotFound("Note not found: $noteId")
            workspaceService.requireAccess(note.workspaceId, userId)

            val saved = noteService.saveNamedVersion(noteId, userId, request.label, request.message)
            publishNoteEvent(
                noteId = noteId,
                eventType = EventType.NOTE_VERSION_SAVED,
                workspaceId = note.workspaceId,
                userId = userId,
                data = mapOf("versionId" to saved.id.toString(), "label" to request.label)
            )
            saved.toResponse()
        }.toResponseEntity()

    @PostMapping("/{noteId}/versions/{versionId}/restore")
    fun restoreVersion(
        @PathVariable noteId: UUID,
        @PathVariable versionId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<NoteResponse> =
        resultOf {
            val userId = userDetails.userId()
            val note = noteService.restoreVersion(noteId, versionId, userId)

            // Publish Redis event for WebSocket distribution
            publishNoteEvent(
                noteId = noteId,
                eventType = EventType.NOTE_VERSION_RESTORED,
                workspaceId = note.workspaceId,
                userId = userId,
                data =
                    mapOf(
                        "note" to note.toResponse(),
                        "versionId" to versionId.toString()
                    )
            )

            note.toResponse()
        }.toResponseEntity()

    // Sharing Management

    @PostMapping("/{noteId}/share")
    fun shareNote(
        @PathVariable noteId: UUID,
        @Valid @RequestBody request: ShareNoteRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()

            // Get note for workspaceId
            val note =
                noteService
                    .findById(noteId)
                    .orNotFound("Note not found: $noteId")

            noteService.shareNote(noteId, request.userId, request.permission, userId)

            // Publish Redis event for WebSocket distribution
            publishNoteEvent(
                noteId = noteId,
                eventType = EventType.NOTE_SHARED,
                workspaceId = note.workspaceId,
                userId = userId,
                data =
                    mapOf(
                        "sharedWith" to request.userId.toString(),
                        "permission" to request.permission
                    )
            )
        }.toResponseEntity(HttpStatus.CREATED).let { ResponseEntity.status(HttpStatus.CREATED).build() }

    @DeleteMapping("/{noteId}/share/{userId}")
    fun removeShare(
        @PathVariable noteId: UUID,
        @PathVariable userId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val currentUserId = userDetails.userId()

            // Get note for workspaceId
            val note =
                noteService
                    .findById(noteId)
                    .orNotFound("Note not found: $noteId")

            noteService.removeShare(noteId, userId, currentUserId)

            // Publish Redis event for WebSocket distribution
            publishNoteEvent(
                noteId = noteId,
                eventType = EventType.NOTE_SHARE_REMOVED,
                workspaceId = note.workspaceId,
                userId = currentUserId,
                data = mapOf("sharedUserId" to userId.toString())
            )
        }.toNoContentResponse()

    // Comments Management

    @GetMapping("/{noteId}/comments")
    fun getComments(
        @PathVariable noteId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<NoteCommentResponse>> =
        resultOf {
            val userId = userDetails.userId()
            val note =
                noteService
                    .findById(noteId)
                    .orNotFound("Note not found: $noteId")
            workspaceService.requireAccess(note.workspaceId, userId)

            noteService.getComments(noteId).map { it.toResponse() }
        }.toResponseEntity()

    @PostMapping("/{noteId}/comments")
    fun addComment(
        @PathVariable noteId: UUID,
        @Valid @RequestBody request: CreateCommentRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<NoteCommentResponse> =
        resultOf {
            val userId = userDetails.userId()

            // Get note for workspaceId
            val note =
                noteService
                    .findById(noteId)
                    .orNotFound("Note not found: $noteId")

            val comment =
                noteService.addComment(
                    noteId = noteId,
                    userId = userId,
                    content = request.content,
                    parentCommentId = request.parentCommentId
                )

            // Publish Redis event for WebSocket distribution
            publishNoteEvent(
                noteId = noteId,
                eventType = EventType.NOTE_COMMENT_ADDED,
                workspaceId = note.workspaceId,
                userId = userId,
                data = mapOf("comment" to comment.toResponse())
            )

            comment.toResponse()
        }.toResponseEntity(HttpStatus.CREATED)

    @PatchMapping("/comments/{commentId}/resolve")
    fun resolveComment(
        @PathVariable commentId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<NoteCommentResponse> =
        resultOf {
            val userId = userDetails.userId()
            val comment = noteService.resolveComment(commentId, userId)

            // Get note for workspaceId
            val note =
                noteService
                    .findById(comment.noteId)
                    .orNotFound("Note not found: ${comment.noteId}")

            // Publish Redis event for WebSocket distribution
            publishNoteEvent(
                noteId = comment.noteId,
                eventType = EventType.NOTE_COMMENT_RESOLVED,
                workspaceId = note.workspaceId,
                userId = userId,
                data = mapOf("comment" to comment.toResponse())
            )

            comment.toResponse()
        }.toResponseEntity()

    @PutMapping("/{noteId}/comments/{commentId}")
    fun updateComment(
        @PathVariable noteId: UUID,
        @PathVariable commentId: UUID,
        @Valid @RequestBody request: UpdateCommentRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<NoteCommentResponse> =
        resultOf {
            val userId = userDetails.userId()

            // Get note for workspaceId
            val note =
                noteService
                    .findById(noteId)
                    .orNotFound("Note not found: $noteId")

            val comment = noteService.updateComment(commentId, noteId, userId, request.content)

            // Publish Redis event for WebSocket distribution
            publishNoteEvent(
                noteId = noteId,
                eventType = EventType.NOTE_COMMENT_UPDATED,
                workspaceId = note.workspaceId,
                userId = userId,
                data = mapOf("comment" to comment.toResponse())
            )

            comment.toResponse()
        }.toResponseEntity()

    @DeleteMapping("/{noteId}/comments/{commentId}")
    fun deleteComment(
        @PathVariable noteId: UUID,
        @PathVariable commentId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()

            // Get note for workspaceId
            val note =
                noteService
                    .findById(noteId)
                    .orNotFound("Note not found: $noteId")

            noteService.deleteComment(commentId, noteId, userId)

            // Publish Redis event for WebSocket distribution
            publishNoteEvent(
                noteId = noteId,
                eventType = EventType.NOTE_COMMENT_DELETED,
                workspaceId = note.workspaceId,
                userId = userId,
                data = mapOf("commentId" to commentId.toString())
            )
        }.toNoContentResponse()

    // Image Upload

    @PostMapping("/upload-image", consumes = [MediaType.MULTIPART_FORM_DATA_VALUE])
    fun uploadImage(
        @RequestParam("file") file: MultipartFile,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<NoteImageResponse> =
        resultOf {
            // Pre-note upload has no workspace context yet — charge the uploader.
            requireStorageQuota(userDetails.userId(), file.size)
            saveNoteImage(file)
        }.toResponseEntity(HttpStatus.CREATED)

    @PostMapping("/{noteId}/upload-image", consumes = [MediaType.MULTIPART_FORM_DATA_VALUE])
    fun uploadNoteImage(
        @PathVariable noteId: UUID,
        @RequestParam("file") file: MultipartFile,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<NoteImageResponse> =
        resultOf {
            val uploaderId = userDetails.userId()
            // Same attribution rule as documents: the workspace OWNER's quota
            // pays for content landing in their workspace; fall back to the
            // uploader when the note has no resolvable workspace.
            val ownerId =
                noteService
                    .findById(noteId)
                    ?.workspaceId
                    ?.let { workspaceService.findById(it)?.userId }
                    ?: uploaderId
            requireStorageQuota(ownerId, file.size)
            saveNoteImage(file)
        }.toResponseEntity(HttpStatus.CREATED)

    /** Hard storage-quota gate for image bytes (403 with the quota message). */
    private fun requireStorageQuota(
        ownerId: UUID,
        bytes: Long
    ) {
        val result = subscriptionService.checkUsageLimit(ownerId, UsageType.STORAGE_BYTES, bytes)
        if (!result.allowed) {
            throw SecurityException(result.message ?: "Storage quota exceeded")
        }
    }

    private fun saveNoteImage(file: MultipartFile): NoteImageResponse {
        val contentType =
            file.contentType
                ?: throw IllegalArgumentException("File content type is missing")

        // Map content-type to a hardcoded extension — breaks taint from user-supplied filename/content-type
        val safeExtension =
            when (contentType) {
                "image/jpeg", "image/jpg" -> "jpg"
                "image/png" -> "png"
                "image/gif" -> "gif"
                "image/webp" -> "webp"
                "image/svg+xml" -> "svg"
                else -> throw IllegalArgumentException("File must be an image (jpeg, png, gif, webp, svg)")
            }

        if (file.size > 10 * 1024 * 1024) {
            throw IllegalArgumentException("File size cannot exceed 10MB")
        }

        val imageDir = File(uploadPath, "notes/images").canonicalFile
        if (!imageDir.exists()) {
            // mkdirs() swallows permission failures and returns false — check it
            // so we fail loudly instead of handing Files.copy a path whose parent
            // silently doesn't exist (manifests as a confusing NoSuchFileException
            // on the destination file).
            val created = imageDir.mkdirs()
            if (!created && !imageDir.isDirectory) {
                logger.error {
                    "Failed to create note image directory: ${imageDir.absolutePath} " +
                        "(writable=${imageDir.parentFile?.canWrite()})"
                }
                throw IllegalStateException("Unable to create image upload directory")
            }
            logger.info { "Created note image directory: ${imageDir.absolutePath}" }
        }

        if (!imageDir.canWrite()) {
            logger.error { "Note image directory not writable: ${imageDir.absolutePath}" }
            throw IllegalStateException("Image upload directory is not writable")
        }

        // Construct filename from trusted sources only: random UUID + hardcoded extension
        val filename = "${UUID.randomUUID()}.$safeExtension"
        val destinationFile = imageDir.toPath().resolve(filename)

        Files.copy(file.inputStream, destinationFile)

        logger.info { "Note image uploaded: $filename (size: ${file.size} bytes)" }

        // Path prefix MUST match StaticResourceConfig.addResourceHandler,
        // which registers "/upload/**" (singular). Returning "/uploads/..."
        // would silently 404 and the editor would render a broken <img>.
        return NoteImageResponse(
            url = "/upload/notes/images/$filename",
            filename = filename
        )
    }

    @GetMapping("/images/{filename}")
    fun getNoteImage(
        @PathVariable filename: String
    ): ResponseEntity<Resource> =
        resultOf {
            val parts = filename.split(".")
            if (parts.size != 2) {
                throw IllegalArgumentException("Invalid filename format")
            }

            // Parse UUID to validate format and strip any path-injection attempts
            val imageUuid =
                runCatching { UUID.fromString(parts[0]) }
                    .getOrElse { throw IllegalArgumentException("Invalid UUID in filename") }

            // Map to hardcoded extension — breaks taint from user-supplied filename
            val safeExtension =
                when (parts[1]) {
                    "jpg", "jpeg" -> "jpg"
                    "png" -> "png"
                    "gif" -> "gif"
                    "webp" -> "webp"
                    "svg" -> "svg"
                    else -> throw IllegalArgumentException("Invalid file extension: ${parts[1]}")
                }

            // Reconstruct filename from trusted components only
            val safeFilename = "$imageUuid.$safeExtension"
            val imageDir = File(uploadPath, "notes/images").canonicalFile
            val filePath = imageDir.toPath().resolve(safeFilename)
            val file = filePath.toFile()

            if (!file.exists() || !file.isFile) {
                throw NoSuchElementException("Image not found: $safeFilename")
            }

            val resource: Resource = FileSystemResource(file)

            val contentType =
                when (safeExtension) {
                    "png" -> MediaType.IMAGE_PNG
                    "gif" -> MediaType.IMAGE_GIF
                    "webp" -> MediaType.parseMediaType("image/webp")
                    "svg" -> MediaType.parseMediaType("image/svg+xml")
                    else -> MediaType.IMAGE_JPEG
                }

            ResponseEntity
                .ok()
                .contentType(contentType)
                .header(HttpHeaders.CACHE_CONTROL, "public, max-age=31536000")
                .body(resource)
        }.fold(
            onSuccess = { it },
            onFailure = { exception ->
                logger.error(exception) { "Get note image failed: ${exception.message}" }
                when (exception) {
                    is NoSuchElementException -> ResponseEntity.notFound().build()
                    is IllegalArgumentException -> ResponseEntity.badRequest().build()
                    else -> ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build()
                }
            }
        )

    // Collaboration

    @PostMapping("/{noteId}/clear-collaboration")
    fun clearCollaboration(
        @PathVariable noteId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<CollaborationClearedResponse> =
        resultOf {
            val userId = userDetails.userId()
            val note =
                noteService
                    .findById(noteId)
                    .orNotFound("Note not found: $noteId")

            if (note.userId != userId) {
                throw SecurityException("Only the note owner can clear collaboration state")
            }

            // Publish Redis event for WebSocket distribution
            publishNoteEvent(
                noteId = noteId,
                eventType = EventType.NOTE_COLLABORATION_CLEARED,
                workspaceId = note.workspaceId,
                userId = userId,
                data =
                    mapOf(
                        "timestamp" to System.currentTimeMillis()
                    )
            )

            logger.info { "Collaboration state cleared for note: $noteId by user: $userId" }

            CollaborationClearedResponse(
                success = true,
                message = "Collaboration state cleared successfully"
            )
        }.toResponseEntity()

    /**
     * Publish note event to Redis for WebSocket distribution
     */
    private fun publishNoteEvent(
        noteId: UUID,
        eventType: EventType,
        workspaceId: UUID,
        userId: UUID,
        data: Map<String, Any> = emptyMap()
    ) {
        redisEventPublisher.publishNoteEvent(
            type = eventType,
            noteId = noteId,
            collectionId = workspaceId, // Using workspaceId as collectionId context
            userId = userId,
            payload = data
        )
        logger.debug { "Published Redis event: $eventType for note: $noteId" }
    }

    // ---- Migration 117 — reactions endpoints ----

    @GetMapping("/{noteId}/reactions")
    fun listReactions(
        @PathVariable noteId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<NoteReactionGroupResponse>> =
        resultOf {
            val userId = userDetails.userId()
            val rows = noteReactionService.listForNote(noteId)
            rows
                .groupBy { it.emoji }
                .map { (emoji, items) ->
                    val userIds = items.map { it.userId }
                    NoteReactionGroupResponse(
                        emoji = emoji,
                        count = items.size,
                        userIds = userIds,
                        includesViewer = userIds.contains(userId),
                    )
                }.sortedByDescending { it.count }
        }.toResponseEntity()

    @PostMapping("/{noteId}/reactions")
    fun addReaction(
        @PathVariable noteId: UUID,
        @Valid @RequestBody request: AddReactionRequest,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<NoteReactionResponse> =
        resultOf {
            val userId = userDetails.userId()
            val saved = noteReactionService.addReaction(noteId, userId, request.emoji)
            publishNoteEvent(
                noteId = noteId,
                eventType = EventType.NOTE_UPDATED,
                workspaceId =
                    noteService.findById(noteId)?.workspaceId
                        ?: throw NoSuchElementException("Note not found: $noteId"),
                userId = userId,
                data = mapOf("reactionAdded" to mapOf("emoji" to request.emoji, "userId" to userId.toString())),
            )
            saved.toResponse()
        }.toResponseEntity(HttpStatus.CREATED)

    // Emoji travels as a query parameter, not a path variable.
    // Spring Cloud Gateway's URI validator rejects most multi-byte
    // percent-encoded glyphs in the path (e.g. 🚀 = %F0%9F%9A%80
    // surfaces as 404 before the request ever reaches this controller).
    // Query parameters are URI-encoded by axios on the way out and
    // decoded by Spring on arrival without the gateway-side check.
    @DeleteMapping("/{noteId}/reactions")
    fun removeReaction(
        @PathVariable noteId: UUID,
        @RequestParam emoji: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Void> =
        resultOf {
            val userId = userDetails.userId()
            val removed = noteReactionService.removeReaction(noteId, userId, emoji)
            if (!removed) throw NoSuchElementException("Reaction not found")
            publishNoteEvent(
                noteId = noteId,
                eventType = EventType.NOTE_UPDATED,
                workspaceId =
                    noteService.findById(noteId)?.workspaceId
                        ?: throw NoSuchElementException("Note not found: $noteId"),
                userId = userId,
                data = mapOf("reactionRemoved" to mapOf("emoji" to emoji, "userId" to userId.toString())),
            )
        }.toNoContentResponse()
}

private fun NoteReaction.toResponse() =
    NoteReactionResponse(
        id = id.orThrow("NoteReaction"),
        noteId = noteId,
        userId = userId,
        emoji = emoji,
        createdAt = createdAt.toString(),
    )

private fun Note.toResponse() =
    NoteResponse(
        id = id.orThrow("Note"),
        title = title,
        content = content,
        noteType = noteType,
        tags = tags,
        workspaceId = workspaceId,
        userId = userId,
        sessionId = sessionId,
        documentId = documentId,
        category = category,
        isPublic = isPublic,
        isPinned = isPinned,
        emoji = emoji,
        status = status,
        headerImageUrl = headerImageUrl,
        fontScale = fontScale,
        createdAt = createdAt.toString(),
        updatedAt = updatedAt.toString()
    )

private fun NoteVersion.toResponse() =
    NoteVersionResponse(
        id = id.orThrow("NoteVersion"),
        noteId = noteId,
        userId = userId,
        versionNumber = versionNumber,
        content = content,
        changeSummary = changeSummary ?: "",
        createdAt = createdAt.toString(),
        kind = kind,
        label = label,
        message = message,
        parentVersionId = parentVersionId
    )

private fun NoteComment.toResponse() =
    NoteCommentResponse(
        id = id.orThrow("NoteComment"),
        noteId = noteId,
        userId = userId,
        parentCommentId = parentCommentId,
        content = content,
        isResolved = isResolved,
        createdAt = createdAt.toString(),
        updatedAt = updatedAt.toString()
    )
