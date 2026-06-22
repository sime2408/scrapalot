package com.scrapalot.backend.controller.knowledge

import com.scrapalot.backend.grpc.DocumentExtrasGrpcClient
import com.scrapalot.backend.grpc.document.DuplicateMatchEntry
import com.scrapalot.backend.grpc.document.ListCollectionDocsRequest
import com.scrapalot.backend.grpc.document.RelationEntry
import com.scrapalot.backend.grpc.document.SavedSearchInfo
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.service.WorkspaceService
import com.scrapalot.backend.utils.authenticatedUserId
import com.scrapalot.backend.utils.requireAccess
import kotlinx.coroutines.runBlocking
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1")
class KnowledgeController(
    private val userService: UserService,
    private val workspaceService: WorkspaceService,
    private val documentExtrasGrpcClient: DocumentExtrasGrpcClient,
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    // ── Document Relations ───────────────────────────────────────────

    @PostMapping("/documents/{documentId}/relations")
    fun createDocumentRelation(
        @PathVariable documentId: UUID,
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Map<String, Any?>> =
        runBlocking {
            val userId = userDetails.userId()
            val targetDocId = body["target_document_id"] as? String ?: throw IllegalArgumentException("target_document_id is required")
            val relationType = body["relationship_type"] as? String ?: throw IllegalArgumentException("relationship_type is required")
            val workspaceId = body["workspace_id"] as? String ?: throw IllegalArgumentException("workspace_id is required")
            val note = body["note"] as? String

            val response =
                documentExtrasGrpcClient.createDocumentRelation(
                    sourceDocId = documentId.toString(),
                    targetDocId = targetDocId,
                    relationType = relationType,
                    userId = userId.toString(),
                    workspaceId = workspaceId,
                    note = note,
                )
            ResponseEntity.status(HttpStatus.CREATED).body(
                mapOf(
                    "success" to response.success,
                    "id" to response.id,
                    "relationship_type" to response.relationshipType,
                )
            )
        }

    @GetMapping("/documents/{documentId}/relations")
    fun listDocumentRelations(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            userDetails.userId()
            val response = documentExtrasGrpcClient.listDocumentRelations(documentId.toString())
            ResponseEntity.ok(
                mapOf(
                    "outgoing" to response.outgoingList.map { it.toMap() },
                    "incoming" to response.incomingList.map { it.toMap() },
                )
            )
        }

    @DeleteMapping("/relations/{relationId}")
    fun deleteDocumentRelation(
        @PathVariable relationId: String,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Map<String, Boolean>> =
        runBlocking {
            val userId = userDetails.userId()
            documentExtrasGrpcClient.deleteDocumentRelationById(relationId, userId.toString())
            ResponseEntity.ok(mapOf("success" to true))
        }

    // ── Saved Searches ───────────────────────────────────────────────

    @GetMapping("/saved-searches")
    fun listSavedSearches(
        @RequestParam("workspace_id") workspaceId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<List<Map<String, Any?>>> =
        runBlocking {
            val userId = userDetails.userId()
            workspaceService.requireAccess(workspaceId, userId)
            val response = documentExtrasGrpcClient.listSavedSearches(userId.toString(), workspaceId.toString())
            ResponseEntity.ok(response.searchesList.map { it.toMap() })
        }

    @PostMapping("/saved-searches")
    fun createSavedSearch(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Map<String, Any?>> =
        runBlocking {
            val userId = userDetails.userId()
            val workspaceId = body["workspace_id"] as? String ?: throw IllegalArgumentException("workspace_id is required")
            val name = body["name"] as? String ?: throw IllegalArgumentException("name is required")
            val criteriaJson = body["criteria_json"] as? String ?: throw IllegalArgumentException("criteria_json is required")
            val color = body["color"] as? String

            workspaceService.requireAccess(UUID.fromString(workspaceId), userId)
            val response = documentExtrasGrpcClient.createSavedSearch(userId.toString(), workspaceId, name, criteriaJson, color)
            ResponseEntity.status(HttpStatus.CREATED).body(
                mapOf(
                    "success" to response.success,
                    "search" to response.search.toMap(),
                )
            )
        }

    @PostMapping("/saved-searches/{searchId}/execute")
    fun executeSavedSearch(
        @PathVariable searchId: UUID,
        @RequestParam(defaultValue = "100") limit: Int,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            val userId = userDetails.userId()
            val response = documentExtrasGrpcClient.executeSavedSearch(searchId.toString(), userId.toString(), limit)
            ResponseEntity.ok(mapOf("document_ids" to response.documentIdsList))
        }

    @PutMapping("/saved-searches/{searchId}")
    fun updateSavedSearch(
        @PathVariable searchId: UUID,
        @RequestBody body: Map<String, Any?>,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Map<String, Any?>> =
        runBlocking {
            val userId = userDetails.userId()
            val name = body["name"] as? String
            val criteriaJson = body["criteria_json"] as? String
            val color = body["color"] as? String
            val isPinned = body["is_pinned"] as? Boolean
            val response =
                documentExtrasGrpcClient.updateSavedSearch(
                    searchId.toString(),
                    userId.toString(),
                    name,
                    criteriaJson,
                    color,
                    isPinned,
                )
            ResponseEntity.ok(
                mapOf(
                    "success" to response.success,
                    "search" to response.search.toMap(),
                )
            )
        }

    @PostMapping("/saved-searches/preview")
    fun previewSavedSearch(
        @RequestBody body: Map<String, Any>,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            val userId = userDetails.userId()
            val workspaceId = body["workspace_id"] as? String ?: throw IllegalArgumentException("workspace_id is required")
            val criteriaJson = body["criteria_json"] as? String ?: throw IllegalArgumentException("criteria_json is required")
            workspaceService.requireAccess(UUID.fromString(workspaceId), userId)
            val response = documentExtrasGrpcClient.previewSavedSearch(userId.toString(), workspaceId, criteriaJson)
            ResponseEntity.ok(mapOf("count" to response.count))
        }

    @DeleteMapping("/saved-searches/{searchId}")
    fun deleteSavedSearch(
        @PathVariable searchId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Map<String, Boolean>> =
        runBlocking {
            val userId = userDetails.userId()
            documentExtrasGrpcClient.deleteSavedSearch(searchId.toString(), userId.toString())
            ResponseEntity.ok(mapOf("success" to true))
        }

    // ── Duplicate Detection ──────────────────────────────────────────

    @GetMapping("/documents/{documentId}/duplicates")
    fun findDuplicates(
        @PathVariable documentId: UUID,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            userDetails.userId()
            val response = documentExtrasGrpcClient.findDuplicates(documentId.toString())
            ResponseEntity.ok(mapOf("matches" to response.matchesList.map { it.toMap() }))
        }

    @PostMapping("/documents/{documentId}/merge")
    fun mergeDuplicates(
        @PathVariable documentId: UUID,
        @RequestBody body: Map<String, String>,
        @AuthenticationPrincipal userDetails: UserDetails,
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            val userId = userDetails.userId()
            val duplicateId = body["duplicate_id"] ?: throw IllegalArgumentException("duplicate_id is required")
            val response =
                documentExtrasGrpcClient.mergeDuplicates(
                    canonicalId = documentId.toString(),
                    duplicateId = duplicateId,
                    userId = userId.toString(),
                )
            ResponseEntity.ok(mapOf("success" to response.success, "message" to response.message))
        }

    @GetMapping("/collections/{collectionId}/duplicates")
    fun findCollectionDuplicates(
        @PathVariable collectionId: UUID,
    ): ResponseEntity<Map<String, Any>> =
        runBlocking {
            val docs =
                documentExtrasGrpcClient.listCollectionDocuments(
                    ListCollectionDocsRequest
                        .newBuilder()
                        .setCollectionId(collectionId.toString())
                        .setPage(1)
                        .setPageSize(1000)
                        .build()
                )

            val allMatches = mutableListOf<Map<String, Any?>>()
            val seen = mutableSetOf<String>()

            // Parse document IDs from the JSON response
            val documentsJson = docs.documentsJson
            val docIds = "\"id\"\\s*:\\s*\"([^\"]+)\"".toRegex().findAll(documentsJson).map { it.groupValues[1] }.toList()

            for (docId in docIds) {
                if (docId in seen) continue
                val dupes = documentExtrasGrpcClient.findDuplicates(docId)
                for (match in dupes.matchesList) {
                    val pairKey = listOf(docId, match.documentId).sorted().joinToString(":")
                    if (pairKey !in seen) {
                        seen.add(pairKey)
                        allMatches.add(match.toMap() + mapOf("source_document_id" to docId))
                    }
                }
            }

            ResponseEntity.ok(mapOf("matches" to allMatches, "total" to allMatches.size))
        }
}

// ── Extensions ───────────────────────────────────────────────────────────────

private fun RelationEntry.toMap(): Map<String, Any?> =
    mapOf(
        "id" to id,
        "document_id" to documentId,
        "relationship_type" to relationshipType,
        "note" to note,
        "created_at" to createdAt,
        "title" to title,
    )

private fun SavedSearchInfo.toMap(): Map<String, Any?> =
    mapOf(
        "id" to id,
        "name" to name,
        "criteria_json" to criteriaJson,
        "icon" to icon,
        "color" to color,
        "sort_order" to sortOrder,
        "is_pinned" to isPinned,
        "result_count" to resultCount,
        "last_evaluated_at" to lastEvaluatedAt.ifEmpty { null },
        "created_at" to createdAt,
        "updated_at" to updatedAt,
    )

private fun DuplicateMatchEntry.toMap(): Map<String, Any?> =
    mapOf(
        "document_id" to documentId,
        "title" to title,
        "filename" to filename,
        "match_type" to matchType,
        "confidence" to confidence,
        "doi" to doi,
        "isbn" to isbn,
    )
