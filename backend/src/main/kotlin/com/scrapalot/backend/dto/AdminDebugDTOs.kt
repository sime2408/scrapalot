package com.scrapalot.backend.dto

/**
 * Docker container information
 */
data class DockerContainerInfo(
    val id: String, // Short container ID (12 chars)
    val name: String, // Container name (e.g., "scrapalot-chat")
    val image: String, // Image name
    val status: String, // "Up 2 hours"
    val state: ContainerState, // RUNNING, STOPPED, etc.
    val ports: List<PortMapping>, // Port mappings
    val created: String, // ISO timestamp
    val networks: List<String> // Network names
)

data class PortMapping(
    val containerPort: Int,
    val hostPort: Int,
    val type: String // "tcp" or "udp"
)

enum class ContainerState {
    RUNNING,
    STOPPED,
    PAUSED,
    RESTARTING,
    DEAD
}

/**
 * Container logs with metadata
 */
data class ContainerLogsResponse(
    val logs: String,
    val errorCount: Int,
    val warningCount: Int,
    val filteredBy: String? // "ERROR", "WARN", null
)

/**
 * Network analysis for all containers
 */
data class NetworkAnalysisResponse(
    val activeConnections: List<NetworkConnection>,
    val containerNetworks: Map<String, ContainerNetworkInfo>,
    val listenPorts: List<ListenPort>
)

data class NetworkConnection(
    val protocol: String, // "tcp", "udp"
    val localAddress: String, // "0.0.0.0:8090"
    val remoteAddress: String, // "192.168.1.100:54321"
    val state: String, // "ESTABLISHED", "LISTEN"
    val pid: Int?,
    val program: String? // "java", "python"
)

data class ContainerNetworkInfo(
    val containerId: String,
    val containerName: String,
    val ipAddress: String,
    val gateway: String,
    val macAddress: String,
    val networkName: String
)

data class ListenPort(
    val port: Int,
    val protocol: String, // "tcp", "udp"
    val address: String, // "0.0.0.0", "127.0.0.1"
    val program: String?,
    val containerId: String?
)

/**
 * Request to update container resource limits
 */
data class UpdateContainerLimitsRequest(
    val memoryLimitMb: Long? = null,
    val cpuLimit: Double? = null,
    val restart: Boolean = false
)

/**
 * Response after updating container limits
 */
data class UpdateContainerLimitsResponse(
    val containerName: String,
    val success: Boolean,
    val message: String,
    val newMemoryLimitMb: Long? = null,
    val newCpuLimit: Double? = null
)

/**
 * Container resource usage and configured limits
 */
data class ContainerResourceStats(
    val name: String,
    val state: ContainerState,
    val cpuPercent: Double,
    val memoryPercent: Double,
    val memoryUsageMb: Long,
    val memoryLimitMb: Long,
    val cpuLimit: Double?,
    val pids: Int,
    val uptime: String
)

/**
 * Host system resource stats
 */
data class SystemStats(
    val memoryTotalMb: Long,
    val memoryUsedMb: Long,
    val memoryPercent: Double,
    val cpuCount: Int,
    val loadAverage1m: Double,
    val loadAverage5m: Double,
    val loadAverage15m: Double,
    val diskUsedGb: Double,
    val diskTotalGb: Double,
    val diskPercent: Double
)

/**
 * Complete system resource overview for the admin dashboard
 */
data class SystemResourceOverview(
    val containers: List<ContainerResourceStats>,
    val system: SystemStats,
    val totalAllocatedMemoryMb: Long,
    val physicalMemoryMb: Long,
    val overcommitWarning: Boolean
)

/**
 * A single commit from the GitHub API
 */
data class CommitInfo(
    val sha: String,
    val message: String?,
    val author: String?,
    val date: String?
)

/**
 * Git commit info for a container (deployed vs. recent commits on main)
 */
data class ContainerGitInfoResponse(
    val containerId: String,
    val containerName: String,
    val repoName: String? = null,
    val deployedCommit: String? = null,
    val recentCommits: List<CommitInfo> = emptyList(),
    val isUpToDate: Boolean = false,
    val error: String? = null,
)

/**
 * A single file diff from GitHub Compare API
 */
data class FileDiff(
    val filename: String,
    val status: String,
    val additions: Int,
    val deletions: Int,
    val patch: String?
)

/**
 * Response from GitHub Compare API
 */
data class GitCompareResponse(
    val totalCommits: Int = 0,
    val aheadBy: Int = 0,
    val behindBy: Int = 0,
    val files: List<FileDiff> = emptyList(),
    val error: String? = null,
)

/**
 * Response for on-demand file diff loading
 */
data class FileDiffResponse(
    val patch: String? = null,
    val error: String? = null,
)
