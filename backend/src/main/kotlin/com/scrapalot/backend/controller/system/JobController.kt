package com.scrapalot.backend.controller.system

import com.scrapalot.backend.grpc.JobsGrpcClient
import com.scrapalot.backend.grpc.jobs.CancelJobRequest
import com.scrapalot.backend.grpc.jobs.GetActiveJobsRequest
import com.scrapalot.backend.grpc.jobs.GetJobStatusRequest
import com.scrapalot.backend.service.UserService
import com.scrapalot.backend.utils.getAuthenticatedUser
import com.scrapalot.backend.utils.orThrow
import com.scrapalot.backend.utils.toActiveJobMap
import com.scrapalot.backend.utils.toJobStatusMap
import io.grpc.Status
import io.grpc.StatusRuntimeException
import kotlinx.coroutines.runBlocking
import mu.KotlinLogging
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.web.bind.annotation.*
import org.springframework.web.server.ResponseStatusException

private val logger = KotlinLogging.logger {}

@RestController
@RequestMapping("/api/v1/jobs")
class JobController(
    private val jobsGrpcClient: JobsGrpcClient,
    private val userService: UserService
) {
    @GetMapping("/active")
    fun getActiveJobs(
        @RequestParam(name = "include_details", required = false, defaultValue = "false") includeDetails: Boolean,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> {
        val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
        val userId = user.id.orThrow("User")

        return try {
            val response =
                runBlocking {
                    jobsGrpcClient.getActiveJobs(
                        GetActiveJobsRequest
                            .newBuilder()
                            .setUserId(userId.toString())
                            .setIncludeDetails(includeDetails)
                            .build()
                    )
                }

            ResponseEntity.ok(
                mapOf(
                    "active_jobs_count" to response.totalActiveCount,
                    "active_jobs" to
                        response.activeJobsList.associate { job ->
                            job.jobId to job.toActiveJobMap()
                        },
                    "document_jobs_count" to response.totalDocumentCount,
                    "connector_jobs_count" to response.totalConnectorCount,
                )
            )
        } catch (e: Exception) {
            logger.error(e) { "Error getting active jobs for user $userId" }
            throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to get active jobs")
        }
    }

    @GetMapping("/status/{jobId}")
    fun getJobStatus(
        @PathVariable jobId: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any?>> {
        val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
        val userId = user.id.orThrow("User")

        return try {
            val response =
                runBlocking {
                    jobsGrpcClient.getJobStatus(
                        GetJobStatusRequest
                            .newBuilder()
                            .setJobId(jobId)
                            .setUserId(userId.toString())
                            .build()
                    )
                }

            ResponseEntity.ok(response.toJobStatusMap())
        } catch (e: StatusRuntimeException) {
            when (e.status.code) {
                Status.Code.NOT_FOUND -> throw ResponseStatusException(HttpStatus.NOT_FOUND, "Job not found")
                Status.Code.PERMISSION_DENIED -> throw ResponseStatusException(HttpStatus.FORBIDDEN, "No access to this job")
                else -> throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to get job status")
            }
        } catch (e: Exception) {
            logger.error(e) { "Error getting job status for $jobId" }
            throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to get job status")
        }
    }

    @PostMapping("/cancel/{jobId}")
    fun cancelJob(
        @PathVariable jobId: String,
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<Map<String, Any>> {
        val user = userDetails.getAuthenticatedUser(userService).getOrThrow()
        val userId = user.id.orThrow("User")

        return try {
            val response =
                runBlocking {
                    jobsGrpcClient.cancelJob(
                        CancelJobRequest
                            .newBuilder()
                            .setJobId(jobId)
                            .setUserId(userId.toString())
                            .build()
                    )
                }

            ResponseEntity.ok(
                mapOf(
                    "success" to response.success,
                    "message" to response.message,
                )
            )
        } catch (e: Exception) {
            logger.error(e) { "Error cancelling job $jobId" }
            throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to cancel job")
        }
    }
}
