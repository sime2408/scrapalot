package com.scrapalot.backend.controller.ai

import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.config.PromptsProperties
import com.scrapalot.backend.grpc.ResearchGrpcClient
import com.scrapalot.backend.grpc.research.*
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.authenticatedUserId
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toResponseEntity
import kotlinx.coroutines.runBlocking
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/v1/research")
class ResearchController(
    private val researchGrpcClient: ResearchGrpcClient,
    private val userService: UserService,
    private val objectMapper: ObjectMapper,
    private val prompts: PromptsProperties,
) {
    private fun UserDetails.userId() = authenticatedUserId(userService)

    @GetMapping("/templates")
    fun getTemplates(): ResponseEntity<Map<String, Any>> =
        resultOf {
            mapOf("templates" to prompts.research.templates.map { it.toMap() })
        }.toResponseEntity()

    @GetMapping("/by-plan/{planId}")
    fun getByPlan(
        @PathVariable planId: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<String> {
        val userId = userDetails.userId()

        val request =
            GetByPlanRequest
                .newBuilder()
                .setPlanId(planId)
                .setUserId(userId.toString())
                .build()

        val response = runBlocking { researchGrpcClient.getByPlan(request) }

        if (!response.found) {
            return ResponseEntity.notFound().build()
        }

        return ResponseEntity.ok(objectMapper.writeValueAsString(toJsonMap(response)))
    }

    @GetMapping("/by-message/{messageId}")
    fun getByMessage(
        @PathVariable messageId: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<String> {
        val userId = userDetails.userId()

        val request =
            GetByMessageRequest
                .newBuilder()
                .setMessageId(messageId)
                .setUserId(userId.toString())
                .build()

        val response = runBlocking { researchGrpcClient.getByMessage(request) }

        if (!response.found) {
            return ResponseEntity.notFound().build()
        }

        return ResponseEntity.ok(objectMapper.writeValueAsString(toJsonMap(response)))
    }

    @GetMapping("/session/{sessionId}")
    fun getSessionPlans(
        @PathVariable sessionId: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<String> {
        val userId = userDetails.userId()

        val request =
            GetSessionPlansRequest
                .newBuilder()
                .setSessionId(sessionId)
                .setUserId(userId.toString())
                .build()

        val response = runBlocking { researchGrpcClient.getSessionPlans(request) }

        val plans = response.plansList.map { planToMap(it) }
        return ResponseEntity.ok(objectMapper.writeValueAsString(plans))
    }

    @GetMapping("/active")
    fun getActiveResearch(
        @RequestParam("session_id") sessionId: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val userId = userDetails.userId()

        val request =
            GetActiveResearchRequest
                .newBuilder()
                .setSessionId(sessionId)
                .setUserId(userId.toString())
                .build()

        val response = runBlocking { researchGrpcClient.getActiveResearch(request) }

        if (!response.found) {
            return ResponseEntity.ok(mapOf("found" to false))
        }

        val payload =
            mapOf(
                "found" to true,
                "research_id" to response.planId,
                "status" to response.status,
                "progress" to response.progress,
                "current_phase" to response.currentPhase,
                "started_at" to response.startedAt,
                "query" to response.query
            )
        return ResponseEntity.ok(payload)
    }

    @PostMapping("/cancel")
    fun cancelResearch(
        @RequestBody body: Map<String, String>,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val userId = userDetails.userId()
        val planId =
            body["research_id"] ?: body["plan_id"]
                ?: return ResponseEntity.badRequest().body(mapOf("error" to "research_id required"))

        val request =
            CancelResearchRequest
                .newBuilder()
                .setPlanId(planId)
                .setUserId(userId.toString())
                .build()

        val response = runBlocking { researchGrpcClient.cancelResearch(request) }

        return ResponseEntity.ok(
            mapOf(
                "cancelled" to response.cancelled,
                "previous_status" to response.previousStatus.ifEmpty { null }
            )
        )
    }

    private fun toJsonMap(response: FullResearchResponse): Map<String, Any?> {
        val result = mutableMapOf<String, Any?>()

        result["plan"] = planToMap(response.plan)

        if (response.hasSynthesis()) {
            result["synthesis"] = synthesisToMap(response.synthesis)
        }

        result["sources"] =
            response.sourcesList.map { source ->
                mapOf(
                    "id" to source.id,
                    "url" to source.url,
                    "title" to source.title.ifEmpty { null },
                    "domain" to source.domain.ifEmpty { null },
                    "source_type" to source.sourceType.ifEmpty { null },
                    "content_snippet" to source.contentSnippet.ifEmpty { null },
                    "credibility_score" to source.credibilityScore,
                    "used_in_synthesis" to source.usedInSynthesis,
                    "citation_count" to source.citationCount
                )
            }

        return result
    }

    private fun planToMap(plan: ResearchPlanInfo): Map<String, Any?> =
        mapOf(
            "id" to plan.id,
            "session_id" to plan.sessionId,
            "message_id" to plan.messageId,
            "query" to plan.query,
            "methodology" to plan.methodology,
            "sections" to parseJsonOrNull(plan.sectionsJson),
            "complexity_score" to plan.complexityScore,
            "status" to plan.status,
            "progress" to plan.progress,
            "error_message" to plan.errorMessage.ifEmpty { null },
            "created_at" to plan.createdAt,
            "updated_at" to plan.updatedAt,
            "discoveries" to parseJsonOrNull(plan.discoveriesJson),
            "council_deliberation" to parseJsonOrNull(plan.councilDeliberationJson)
        )

    private fun synthesisToMap(synthesis: ResearchSynthesisInfo): Map<String, Any?> =
        mapOf(
            "id" to synthesis.id,
            "plan_id" to synthesis.planId,
            "title" to synthesis.title,
            "executive_summary" to synthesis.executiveSummary,
            "main_content" to synthesis.mainContent,
            "sections" to parseJsonOrNull(synthesis.sectionsJson),
            "conclusions" to parseJsonOrNull(synthesis.conclusionsJson),
            "limitations" to parseJsonOrNull(synthesis.limitationsJson),
            "recommendations" to parseJsonOrNull(synthesis.recommendationsJson),
            "citations" to parseJsonOrNull(synthesis.citationsJson),
            "bibliography" to parseJsonOrNull(synthesis.bibliographyJson),
            "quality_score" to synthesis.qualityScore,
            "quality_dimensions" to parseJsonOrNull(synthesis.qualityDimensionsJson),
            "word_count" to synthesis.wordCount,
            "total_sources_used" to synthesis.totalSourcesUsed,
            "created_at" to synthesis.createdAt
        )

    private fun parseJsonOrNull(json: String): Any? {
        if (json.isEmpty()) return null
        return try {
            objectMapper.readValue(json, Any::class.java)
        } catch (_: Exception) {
            json
        }
    }
}
