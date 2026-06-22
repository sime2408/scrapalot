package com.scrapalot.backend.controller.admin

import com.scrapalot.backend.dto.ContainerGitInfoResponse
import com.scrapalot.backend.dto.ContainerLogsResponse
import com.scrapalot.backend.dto.DockerContainerInfo
import com.scrapalot.backend.dto.FileDiffResponse
import com.scrapalot.backend.dto.GitCompareResponse
import com.scrapalot.backend.dto.NetworkAnalysisResponse
import com.scrapalot.backend.dto.SystemResourceOverview
import com.scrapalot.backend.dto.SystemStats
import com.scrapalot.backend.dto.UpdateContainerLimitsRequest
import com.scrapalot.backend.dto.UpdateContainerLimitsResponse
import com.scrapalot.backend.service.DockerService
import com.scrapalot.backend.utils.recoverWith
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toResponseEntity
import mu.KotlinLogging
import org.springframework.http.ResponseEntity
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.*

private val logger = KotlinLogging.logger {}

/**
 * Admin Debug Controller
 *
 * Provides debugging endpoints for admin users:
 * - Docker container listing and logs
 * - Network analysis (active connections, ports)
 */
@RestController
@RequestMapping("/api/v1/admin/debug")
@PreAuthorize("hasRole('ADMIN')")
class AdminDebugController(
    private val dockerService: DockerService
) {
    @GetMapping("/docker/containers")
    fun listDockerContainers(): ResponseEntity<List<DockerContainerInfo>> =
        resultOf {
            dockerService.listRunningContainers()
        }.recoverWith<List<DockerContainerInfo>, Exception> { exception ->
            logger.error(exception) { "Failed to list Docker containers: ${exception.message}" }
            emptyList()
        }.toResponseEntity()

    @PutMapping("/docker/resources/{containerName}")
    fun updateContainerLimits(
        @PathVariable containerName: String,
        @RequestBody request: UpdateContainerLimitsRequest
    ): ResponseEntity<UpdateContainerLimitsResponse> =
        resultOf {
            dockerService.updateContainerLimits(containerName, request)
        }.recoverWith<UpdateContainerLimitsResponse, Exception> { exception ->
            logger.error(exception) { "Failed to update container limits: ${exception.message}" }
            UpdateContainerLimitsResponse(containerName, false, "Error: ${exception.message}")
        }.toResponseEntity()

    @GetMapping("/docker/containers/{containerId}/logs")
    fun getContainerLogs(
        @PathVariable containerId: String,
        @RequestParam(name = "tail_lines", defaultValue = "200") tailLines: Int,
        @RequestParam(required = false, defaultValue = "all") level: String,
        @RequestParam(name = "context_lines", defaultValue = "5") contextLines: Int
    ): ResponseEntity<ContainerLogsResponse> =
        resultOf {
            dockerService.getContainerLogs(containerId, tailLines, level, contextLines)
        }.recoverWith<ContainerLogsResponse, Exception> { exception ->
            logger.error(exception) { "Failed to get container logs: ${exception.message}" }
            ContainerLogsResponse(
                logs = "Error: ${exception.message}",
                errorCount = 0,
                warningCount = 0,
                filteredBy = null
            )
        }.toResponseEntity()

    @GetMapping("/docker/containers/{containerId}/git-info")
    fun getContainerGitInfo(
        @PathVariable containerId: String
    ): ResponseEntity<ContainerGitInfoResponse> =
        resultOf {
            dockerService.getContainerGitInfo(containerId)
        }.recoverWith<ContainerGitInfoResponse, Exception> { exception ->
            logger.error(exception) { "Failed to get git info: ${exception.message}" }
            ContainerGitInfoResponse(
                containerId = containerId,
                containerName = "unknown",
                repoName = null,
                deployedCommit = null,
                recentCommits = emptyList(),
                isUpToDate = false,
                error = exception.message
            )
        }.toResponseEntity()

    @GetMapping("/docker/git-compare")
    fun getGitCompare(
        @RequestParam repo: String,
        @RequestParam base: String,
        @RequestParam head: String
    ): ResponseEntity<GitCompareResponse> =
        resultOf {
            dockerService.getGitCompare(repo, base, head)
        }.recoverWith<GitCompareResponse, Exception> { exception ->
            logger.error(exception) { "Failed to get git compare: ${exception.message}" }
            GitCompareResponse(
                totalCommits = 0,
                aheadBy = 0,
                behindBy = 0,
                files = emptyList(),
                error = exception.message
            )
        }.toResponseEntity()

    @GetMapping("/docker/git-file-diff")
    fun getGitFileDiff(
        @RequestParam repo: String,
        @RequestParam base: String,
        @RequestParam head: String,
        @RequestParam path: String
    ): ResponseEntity<FileDiffResponse> =
        resultOf {
            dockerService.getFileDiff(repo, base, head, path)
        }.recoverWith<FileDiffResponse, Exception> { exception ->
            logger.error(exception) { "Failed to get file diff: ${exception.message}" }
            FileDiffResponse(patch = null, error = exception.message)
        }.toResponseEntity()

    @GetMapping("/docker/resources")
    fun getDockerResources(): ResponseEntity<SystemResourceOverview> =
        resultOf {
            dockerService.getContainerResourceStats()
        }.recoverWith<SystemResourceOverview, Exception> { exception ->
            logger.error(exception) { "Failed to get resource stats: ${exception.message}" }
            SystemResourceOverview(
                containers = emptyList(),
                system = SystemStats(0, 0, 0.0, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
                totalAllocatedMemoryMb = 0,
                physicalMemoryMb = 0,
                overcommitWarning = false
            )
        }.toResponseEntity()

    @GetMapping("/docker/network")
    fun getNetworkAnalysis(): ResponseEntity<NetworkAnalysisResponse> =
        resultOf {
            dockerService.getNetworkAnalysis()
        }.recoverWith<NetworkAnalysisResponse, Exception> { exception ->
            logger.error(exception) { "Failed to get network analysis: ${exception.message}" }
            NetworkAnalysisResponse(
                activeConnections = emptyList(),
                containerNetworks = emptyMap(),
                listenPorts = emptyList()
            )
        }.toResponseEntity()
}
