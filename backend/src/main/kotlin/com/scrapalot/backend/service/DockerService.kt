package com.scrapalot.backend.service

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.scrapalot.backend.dto.CommitInfo
import com.scrapalot.backend.dto.ContainerGitInfoResponse
import com.scrapalot.backend.dto.ContainerLogsResponse
import com.scrapalot.backend.dto.ContainerNetworkInfo
import com.scrapalot.backend.dto.ContainerResourceStats
import com.scrapalot.backend.dto.ContainerState
import com.scrapalot.backend.dto.DockerContainerInfo
import com.scrapalot.backend.dto.FileDiff
import com.scrapalot.backend.dto.FileDiffResponse
import com.scrapalot.backend.dto.GitCompareResponse
import com.scrapalot.backend.dto.ListenPort
import com.scrapalot.backend.dto.NetworkAnalysisResponse
import com.scrapalot.backend.dto.NetworkConnection
import com.scrapalot.backend.dto.PortMapping
import com.scrapalot.backend.dto.SystemResourceOverview
import com.scrapalot.backend.dto.SystemStats
import com.scrapalot.backend.dto.UpdateContainerLimitsRequest
import com.scrapalot.backend.dto.UpdateContainerLimitsResponse
import mu.KotlinLogging
import org.springframework.stereotype.Service
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.ConcurrentHashMap

private val logger = KotlinLogging.logger {}

@Service
class DockerService {
    private val objectMapper = ObjectMapper()
    private val diffCache = ConcurrentHashMap<String, String>()
    private val commitHashPattern = Regex("[0-9a-f]{40}")

    private val httpClient =
        HttpClient
            .newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build()

    private val containerToRepo =
        mapOf(
            "scrapalot-backend" to "scrapalot-backend",
            "scrapalot-chat" to "scrapalot-chat",
            "scrapalot-ui" to "scrapalot-ui",
            "scrapalot-gw" to "scrapalot-gw",
        )

    // ── Shell & Process helpers ──────────────────────────────────────────────

    /** Docker container names: alphanumeric, hyphens, underscores, dots — no shell metacharacters. */
    private val safeContainerName = Regex("^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")

    /** Docker container/image IDs: hex digits (short or full 64-char). */
    private val safeContainerId = Regex("^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")

    /** Git refs: commit hashes (hex) or branch/tag names — no path traversal or shell metacharacters. */
    private val safeGitRef = Regex("^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,199}$")

    private fun requireSafeContainerName(name: String) {
        require(safeContainerName.matches(name)) { "Invalid container name: $name" }
    }

    private fun requireSafeContainerId(id: String) {
        require(safeContainerId.matches(id)) { "Invalid container ID: $id" }
    }

    private fun exec(vararg command: String): Result<String> =
        runCatching {
            val process = ProcessBuilder(*command).redirectErrorStream(true).start()
            val output = process.inputStream.bufferedReader().readText()
            val exitCode = process.waitFor()
            check(exitCode == 0) { "Exit code $exitCode: ${output.take(200)}" }
            output
        }

    private fun execOrEmpty(vararg command: String): String =
        exec(*command).getOrElse {
            logger.debug { "exec failed: ${it.message}" }
            ""
        }

    private fun githubToken(): String? =
        (System.getenv("GH_TOKEN") ?: System.getenv("GITHUB_TOKEN"))
            .takeUnless { it.isNullOrBlank() }

    private fun githubGet(
        path: String,
        accept: String = "application/vnd.github.v3+json",
        timeout: Long = 10
    ): HttpResponse<String>? {
        val token = githubToken() ?: return null
        val request =
            HttpRequest
                .newBuilder()
                .uri(URI.create("https://api.github.com/repos/sime2408/$path"))
                .header("Authorization", "Bearer $token")
                .header("Accept", accept)
                .header("User-Agent", "scrapalot-backend")
                .timeout(Duration.ofSeconds(timeout))
                .GET()
                .build()
        return httpClient
            .send(request, HttpResponse.BodyHandlers.ofString())
            .takeIf { it.statusCode() == 200 }
    }

    // ── JsonNode extensions ──────────────────────────────────────────────────

    private fun JsonNode.str(key: String): String = get(key)?.asText() ?: ""

    private fun JsonNode.int(key: String): Int = get(key)?.asInt() ?: 0

    // ── Public API ───────────────────────────────────────────────────────────

    fun listRunningContainers(): List<DockerContainerInfo> =
        runCatching {
            exec("docker", "ps", "--format", "{{json .}}")
                .getOrThrow()
                .lines()
                .filter { it.isNotBlank() }
                .mapNotNull { parseContainerJson(it) }
        }.onFailure { logger.error(it) { "Failed to list Docker containers" } }
            .getOrDefault(emptyList())

    fun updateContainerLimits(
        containerName: String,
        request: UpdateContainerLimitsRequest
    ): UpdateContainerLimitsResponse {
        requireSafeContainerName(containerName)
        val containers = listRunningContainers()
        val container =
            containers.find { it.name == containerName }
                ?: return UpdateContainerLimitsResponse(containerName, false, "Container not found: $containerName")

        val args = mutableListOf("docker", "update")

        request.memoryLimitMb?.let { mb ->
            if (mb < 64) return UpdateContainerLimitsResponse(containerName, false, "Memory limit must be at least 64 MB")
            if (mb > 16384) return UpdateContainerLimitsResponse(containerName, false, "Memory limit must be at most 16384 MB (16 GB)")
            args.addAll(listOf("--memory", "${mb}m"))
        }

        request.cpuLimit?.let { cpus ->
            if (cpus < 0.1) return UpdateContainerLimitsResponse(containerName, false, "CPU limit must be at least 0.1")
            if (cpus > 16.0) return UpdateContainerLimitsResponse(containerName, false, "CPU limit must be at most 16.0")
            args.addAll(listOf("--cpus", cpus.toString()))
        }

        if (args.size == 2) {
            return UpdateContainerLimitsResponse(containerName, false, "No limits specified to update")
        }

        args.add(containerName)

        return runCatching {
            val output = exec(*args.toTypedArray()).getOrThrow()
            logger.info { "Updated container limits for $containerName: $output" }

            // Invalidate resource cache
            cachedResources = null

            // Restart if requested
            if (request.restart) {
                logger.info { "Restarting container $containerName after limit update" }
                exec("docker", "restart", containerName).getOrThrow()
            }

            // Read back new limits
            val newLimits = fetchContainerLimits(setOf(containerName))
            val limits = newLimits[containerName]

            UpdateContainerLimitsResponse(
                containerName = containerName,
                success = true,
                message = if (request.restart) "Limits updated and container restarted" else "Limits updated (no restart)",
                newMemoryLimitMb = limits?.first,
                newCpuLimit = limits?.second
            )
        }.onFailure { logger.error(it) { "Failed to update limits for $containerName" } }
            .getOrDefault(UpdateContainerLimitsResponse(containerName, false, "Failed to update limits: ${container.name}"))
    }

    fun getContainerLogs(
        containerId: String,
        tailLines: Int,
        level: String?,
        @Suppress("UNUSED_PARAMETER") contextLines: Int
    ): ContainerLogsResponse {
        requireSafeContainerId(containerId)
        val containers = listRunningContainers()
        val container =
            containers.find { it.id == containerId || it.name == containerId }
                ?: return ContainerLogsResponse(logs = "Container not found: $containerId", errorCount = 0, warningCount = 0, filteredBy = null)
        val resolvedId = container.id

        return runCatching {
            val logs = exec("docker", "logs", "--tail", tailLines.toString(), "--timestamps", resolvedId).getOrThrow()
            val filtered = level?.takeIf { it != "all" }?.let { filterLogsByLevel(logs, it.uppercase()) } ?: logs
            ContainerLogsResponse(
                logs = filtered,
                errorCount = countLogLevel(logs, "ERROR"),
                warningCount = countLogLevel(logs, "WARN"),
                filteredBy = level?.uppercase(),
            )
        }.onFailure { logger.error(it) { "Failed to get container logs for $containerId" } }
            .getOrDefault(ContainerLogsResponse(logs = "Error fetching logs", errorCount = 0, warningCount = 0, filteredBy = null))
    }

    fun getNetworkAnalysis(): NetworkAnalysisResponse =
        runCatching {
            NetworkAnalysisResponse(
                activeConnections = getActiveConnections(),
                containerNetworks = getContainerNetworks(),
                listenPorts = getListeningPorts(),
            )
        }.onFailure { logger.error(it) { "Failed to get network analysis" } }
            .getOrDefault(NetworkAnalysisResponse(activeConnections = emptyList(), containerNetworks = emptyMap(), listenPorts = emptyList()))

    fun getContainerGitInfo(containerId: String): ContainerGitInfoResponse {
        requireSafeContainerId(containerId)
        val containers = listRunningContainers()
        val container =
            containers.find { it.id == containerId }
                ?: return ContainerGitInfoResponse(containerId = containerId, containerName = "unknown", error = "Container not found")

        val repoName =
            containerToRepo[container.name]
                ?: return ContainerGitInfoResponse(containerId = containerId, containerName = container.name)

        return runCatching {
            val deployedCommit = extractDeployedCommit(container.name, repoName)
            val recentCommits = fetchRecentCommitsFromGitHub(repoName)
            ContainerGitInfoResponse(
                containerId = containerId,
                containerName = container.name,
                repoName = repoName,
                deployedCommit = deployedCommit,
                recentCommits = recentCommits,
                isUpToDate = deployedCommit != null && recentCommits.firstOrNull()?.sha == deployedCommit,
            )
        }.onFailure { logger.error(it) { "Failed to get git info for ${container.name}" } }
            .getOrDefault(ContainerGitInfoResponse(containerId = containerId, containerName = container.name, repoName = repoName, error = "Failed"))
    }

    fun getGitCompare(
        repoName: String,
        base: String,
        head: String
    ): GitCompareResponse {
        require(repoName in containerToRepo.values) { "Unknown repository: $repoName" }
        require(safeGitRef.matches(base)) { "Invalid base ref: $base" }
        require(safeGitRef.matches(head)) { "Invalid head ref: $head" }
        return runCatching {
            val root =
                githubGet("$repoName/compare/$base...$head", timeout = 15)
                    ?.body()
                    ?.let { objectMapper.readTree(it) }
                    ?: return GitCompareResponse(error = "GitHub API unavailable")

            GitCompareResponse(
                totalCommits = root.int("total_commits"),
                aheadBy = root.int("ahead_by"),
                behindBy = root.int("behind_by"),
                files =
                    root.get("files")?.takeIf { it.isArray }?.mapNotNull { node ->
                        node.str("filename").takeIf { it.isNotBlank() }?.let { filename ->
                            FileDiff(
                                filename = filename,
                                status = node.str("status").ifBlank { "modified" },
                                additions = node.int("additions"),
                                deletions = node.int("deletions"),
                                patch = node.get("patch")?.asText(),
                            )
                        }
                    } ?: emptyList(),
            )
        }.onFailure { logger.error(it) { "GitHub Compare failed for $repoName ($base...$head)" } }
            .getOrDefault(GitCompareResponse(error = "Compare failed"))
    }

    fun getFileDiff(
        repoName: String,
        base: String,
        head: String,
        path: String
    ): FileDiffResponse {
        require(repoName in containerToRepo.values) { "Unknown repository: $repoName" }
        require(safeGitRef.matches(base)) { "Invalid base ref: $base" }
        require(safeGitRef.matches(head)) { "Invalid head ref: $head" }
        require(path.isNotBlank() && !path.contains("..")) { "Invalid path: $path" }
        return runCatching {
            val fullDiff = fetchFullDiff(repoName, base, head) ?: return FileDiffResponse(error = "Failed to fetch diff")
            val patch = extractFilePatch(fullDiff, path) ?: return FileDiffResponse(error = "File not found in diff")
            FileDiffResponse(patch = patch)
        }.onFailure { logger.error(it) { "Failed to get file diff for $path" } }
            .getOrDefault(FileDiffResponse(error = "Diff failed"))
    }

    // ── Git helpers ──────────────────────────────────────────────────────────

    /**
     * Resolve the commit SHA the running container was built from.
     *
     * Three fallbacks, in order — first one that yields a 40-char hex wins:
     *
     *   1. Image tag suffix. Original behaviour: scan RepoTags for `repo:<sha>`.
     *      Works only when CI/CD tags by commit hash. Returns null when the
     *      image is tagged purely with `:latest` (the bug users hit).
     *
     *   2. OCI image label `org.opencontainers.image.revision`. Standard
     *      label baked in by GitHub Actions / Docker buildx. Survives
     *      `:latest` tagging because labels live in image metadata.
     *
     *   3. Host-side git: `git -C /opt/scrapalot/<repoName> rev-parse HEAD`.
     *      Last resort for the deployment server. The host repo is the
     *      same source CI/CD just built from, so on a single-host deploy
     *      this matches the running container. `repoName` is already a
     *      known value from `containerToRepo`, so the path can't be
     *      attacker-controlled.
     */
    private fun extractDeployedCommit(
        containerName: String,
        repoName: String
    ): String? =
        runCatching {
            // (0) Bind-mounted source wins over the image. When a container runs its
            // code straight from the host repo (scrapalot-chat: `/opt/scrapalot/<repo>/src`
            // → `/app/src`, deployed via `docker restart`, no per-commit image rebuild),
            // the image's tag/OCI label is frozen at the last full rebuild and can be
            // dozens of commits stale. The actually-running commit is the host repo HEAD,
            // so the diff base must come from there — not the image metadata below.
            if (containerRunsFromHostRepo(containerName, repoName)) {
                readGitHead("/opt/scrapalot/$repoName")?.let { return it }
            }

            val imageId =
                execOrEmpty("docker", "inspect", "--format", "{{.Image}}", containerName)
                    .trim()
                    .takeIf { it.isNotBlank() } ?: return null

            // (1) commit-hash tag
            val fromTag =
                execOrEmpty("docker", "image", "inspect", "--format", "{{range .RepoTags}}{{.}} {{end}}", imageId)
                    .split(" ")
                    .map { it.substringAfter(":") }
                    .firstOrNull { commitHashPattern.matches(it) }
            if (fromTag != null) return fromTag

            // (2) OCI revision label
            val fromLabel =
                execOrEmpty(
                    "docker",
                    "image",
                    "inspect",
                    "--format",
                    "{{index .Config.Labels \"org.opencontainers.image.revision\"}}",
                    imageId
                ).trim().takeIf { commitHashPattern.matches(it) }
            if (fromLabel != null) return fromLabel

            // (3) host repo HEAD via plain-text .git read.
            // We use file IO instead of `git rev-parse` because the Kotlin
            // container ships without the git binary (slimmer image), but the
            // host repos are bind-mounted read-only at /opt/scrapalot. Parsing
            // .git/HEAD + ref file is enough to identify the deployed commit.
            if (repoName !in containerToRepo.values) return null
            return readGitHead("/opt/scrapalot/$repoName")
        }.getOrNull()

    /**
     * True when the container bind-mounts source from its host repo
     * (`/opt/scrapalot/<repoName>` → somewhere in the container). Such a
     * container runs the host repo's working tree directly, so its live commit
     * is the host HEAD, not whatever the image was built from. Auto-detected
     * from `docker inspect` mounts — no per-repo flag to maintain.
     */
    private fun containerRunsFromHostRepo(
        containerName: String,
        repoName: String
    ): Boolean {
        val repoPrefix = "/opt/scrapalot/$repoName/"
        return execOrEmpty(
            "docker",
            "inspect",
            "--format",
            "{{range .Mounts}}{{if eq .Type \"bind\"}}{{.Source}}\n{{end}}{{end}}",
            containerName,
        ).lineSequence().any { it.trim().startsWith(repoPrefix) }
    }

    /**
     * Resolve the current HEAD SHA of a bind-mounted host repo without
     * shelling out to `git`. Handles both:
     *   - Detached HEAD: HEAD file is a 40-char hex.
     *   - Branch ref:    HEAD file is `ref: refs/heads/<name>`, follow that
     *                    to `.git/refs/heads/<name>` for the SHA.
     * Returns null on any IO error or if the result isn't a 40-char hex.
     */
    private fun readGitHead(repoPath: String): String? =
        runCatching {
            val gitDir = java.io.File(repoPath, ".git")
            if (!gitDir.isDirectory) return null
            val head =
                java.io
                    .File(gitDir, "HEAD")
                    .readText()
                    .trim()
            val sha =
                if (head.startsWith("ref:")) {
                    val refPath = head.substringAfter("ref:").trim()
                    val refFile = java.io.File(gitDir, refPath)
                    if (refFile.isFile) refFile.readText().trim() else null
                } else {
                    head
                }
            sha?.takeIf { commitHashPattern.matches(it) }
        }.getOrNull()

    private fun fetchRecentCommitsFromGitHub(repoName: String): List<CommitInfo> {
        githubToken() ?: return emptyList()
        val since = Instant.now().minus(30, ChronoUnit.DAYS)
        return runCatching {
            (1..5)
                .asSequence()
                .map { page -> githubGet("$repoName/commits?sha=main&since=$since&per_page=100&page=$page") }
                .takeWhile { it != null }
                .flatMap { resp ->
                    objectMapper
                        .readTree(requireNotNull(resp) { "GitHub API response is null" }.body())
                        .takeIf { it.isArray && !it.isEmpty }
                        ?.mapNotNull { node ->
                            val commit = node.get("commit")
                            CommitInfo(
                                sha = node.str("sha"),
                                message =
                                    commit
                                        ?.get("message")
                                        ?.asText()
                                        ?.lines()
                                        ?.firstOrNull(),
                                author = commit?.get("author")?.str("name"),
                                date = commit?.get("author")?.str("date"),
                            )
                        }?.asSequence() ?: emptySequence()
                }.toList()
        }.onFailure { logger.error(it) { "GitHub API failed for $repoName" } }
            .getOrDefault(emptyList())
    }

    private fun fetchFullDiff(
        repoName: String,
        base: String,
        head: String
    ): String? {
        val cacheKey = "$repoName/$base...$head"
        diffCache[cacheKey]?.let { return it }
        return githubGet("$repoName/compare/$base...$head", accept = "application/vnd.github.v3.diff", timeout = 30)
            ?.body()
            ?.also { body ->
                if (diffCache.size >= 20) {
                    diffCache
                        .keys()
                        .asIterator()
                        .next()
                        .let { diffCache.remove(it) }
                }
                diffCache[cacheKey] = body
            }
    }

    private fun extractFilePatch(
        fullDiff: String,
        path: String
    ): String? {
        val marker = "diff --git a/$path b/$path"
        val startIdx = fullDiff.indexOf(marker).takeIf { it >= 0 } ?: return null
        val endIdx = fullDiff.indexOf("\ndiff --git ", startIdx + marker.length).takeIf { it >= 0 } ?: fullDiff.length
        val section = fullDiff.substring(startIdx, endIdx)
        val hunkIdx = section.indexOf("\n@@").takeIf { it >= 0 } ?: return null
        return section.substring(hunkIdx + 1).trimEnd()
    }

    // ── Resource stats ──────────────────────────────────────────────────

    @Volatile
    private var cachedResources: SystemResourceOverview? = null

    @Volatile
    private var cachedResourcesTimestamp: Long = 0

    private val resourceCacheTtlMs = 3000L // 3-second cache to avoid hammering docker stats

    fun getContainerResourceStats(): SystemResourceOverview {
        val now = System.currentTimeMillis()
        cachedResources?.takeIf { now - cachedResourcesTimestamp < resourceCacheTtlMs }?.let { return it }

        val containerStats = fetchDockerStats()
        val containerLimits = fetchContainerLimits(containerStats.keys)
        val systemStats = fetchSystemStats()

        val resources =
            containerStats
                .map { (name, stats) ->
                    val limits = containerLimits[name]
                    val memLimitMb = limits?.first ?: 0L
                    val cpuLimit = limits?.second

                    ContainerResourceStats(
                        name = name,
                        state = if (stats.cpuPercent >= 0) ContainerState.RUNNING else ContainerState.STOPPED,
                        cpuPercent = stats.cpuPercent,
                        memoryPercent = stats.memoryPercent,
                        memoryUsageMb = stats.memoryUsageMb,
                        memoryLimitMb = memLimitMb,
                        cpuLimit = cpuLimit,
                        pids = stats.pids,
                        uptime = stats.uptime
                    )
                }.sortedBy { it.name }

        val totalAllocated = resources.sumOf { it.memoryLimitMb }
        val physicalMb = systemStats.memoryTotalMb

        val result =
            SystemResourceOverview(
                containers = resources,
                system = systemStats,
                totalAllocatedMemoryMb = totalAllocated,
                physicalMemoryMb = physicalMb,
                overcommitWarning = totalAllocated > physicalMb
            )

        cachedResources = result
        cachedResourcesTimestamp = now
        return result
    }

    private data class RawContainerStats(
        val cpuPercent: Double,
        val memoryPercent: Double,
        val memoryUsageMb: Long,
        val pids: Int,
        val uptime: String
    )

    private fun fetchDockerStats(): Map<String, RawContainerStats> {
        val statsOutput =
            execOrEmpty(
                "docker",
                "stats",
                "--no-stream",
                "--format",
                """{"name":"{{.Name}}","cpu":"{{.CPUPerc}}","memory":"{{.MemPerc}}","mem_usage":"{{.MemUsage}}","pids":"{{.PIDs}}"}"""
            )

        val healthOutput =
            execOrEmpty(
                "docker",
                "ps",
                "-a",
                "--format",
                """{"name":"{{.Names}}","status":"{{.Status}}"}"""
            )

        val uptimes = mutableMapOf<String, String>()
        healthOutput.lines().filter { it.isNotBlank() }.forEach { line ->
            runCatching {
                val node = objectMapper.readTree(line)
                uptimes[node.str("name")] = node.str("status")
            }
        }

        return buildMap {
            statsOutput.lines().filter { it.isNotBlank() }.forEach { line ->
                runCatching {
                    val node = objectMapper.readTree(line)
                    val name = node.str("name")
                    val cpuStr = node.str("cpu").replace("%", "")
                    val memStr = node.str("memory").replace("%", "")
                    val memUsage = parseMemUsage(node.str("mem_usage"))
                    val pids = node.str("pids").toIntOrNull() ?: 0

                    put(
                        name,
                        RawContainerStats(
                            cpuPercent = cpuStr.toDoubleOrNull() ?: 0.0,
                            memoryPercent = memStr.toDoubleOrNull() ?: 0.0,
                            memoryUsageMb = memUsage,
                            pids = pids,
                            uptime = uptimes[name] ?: "unknown"
                        )
                    )
                }
            }
        }
    }

    private fun parseMemUsage(memUsage: String): Long {
        // Format: "1.234GiB / 8GiB" - parse the first part
        val used = memUsage.split("/").firstOrNull()?.trim() ?: return 0
        return parseSizeToMb(used)
    }

    private fun parseSizeToMb(sizeStr: String): Long {
        val str = sizeStr.trim().uppercase()
        val multipliers = listOf("TIB" to 1048576L, "GIB" to 1024L, "MIB" to 1L, "KIB" to 0L, "TB" to 1000000L, "GB" to 1000L, "MB" to 1L, "KB" to 0L)
        for ((suffix, mult) in multipliers) {
            if (str.endsWith(suffix)) {
                return (
                    str
                        .removeSuffix(suffix)
                        .trim()
                        .toDoubleOrNull()
                        ?.times(mult)
                )?.toLong() ?: 0L
            }
        }
        // Bytes
        return (
            str
                .removeSuffix("B")
                .trim()
                .toDoubleOrNull()
                ?.div(1048576)
        )?.toLong() ?: 0L
    }

    private fun fetchContainerLimits(containerNames: Set<String>): Map<String, Pair<Long, Double?>> {
        // docker inspects all containers at once for memory limit and CPU limit
        if (containerNames.isEmpty()) return emptyMap()

        return buildMap {
            for (name in containerNames) {
                runCatching {
                    val output =
                        execOrEmpty(
                            "docker",
                            "inspect",
                            "--format",
                            "{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}",
                            name
                        ).trim()
                    val parts = output.split(" ")
                    val memBytes = parts.getOrNull(0)?.toLongOrNull() ?: 0L
                    val nanoCpus = parts.getOrNull(1)?.toLongOrNull() ?: 0L

                    val memMb = if (memBytes > 0) memBytes / 1048576 else 0L
                    val cpuLimit = if (nanoCpus > 0) nanoCpus / 1_000_000_000.0 else null

                    put(name, Pair(memMb, cpuLimit))
                }
            }
        }
    }

    private fun fetchSystemStats(): SystemStats {
        // Read /proc/meminfo
        var memTotalKb = 0L
        var memAvailableKb = 0L
        runCatching {
            execOrEmpty("cat", "/proc/meminfo").lines().forEach { line ->
                when {
                    line.startsWith("MemTotal:") -> memTotalKb = line.split(Regex("\\s+"))[1].toLongOrNull() ?: 0
                    line.startsWith("MemAvailable:") -> memAvailableKb = line.split(Regex("\\s+"))[1].toLongOrNull() ?: 0
                }
            }
        }
        val memTotalMb = memTotalKb / 1024
        val memUsedMb = (memTotalKb - memAvailableKb) / 1024
        val memPercent = if (memTotalKb > 0) (memTotalKb - memAvailableKb).toDouble() / memTotalKb * 100 else 0.0

        // Read /proc/loadavg
        var load1 = 0.0
        var load5 = 0.0
        var load15 = 0.0
        runCatching {
            val parts = execOrEmpty("cat", "/proc/loadavg").split(" ")
            load1 = parts.getOrNull(0)?.toDoubleOrNull() ?: 0.0
            load5 = parts.getOrNull(1)?.toDoubleOrNull() ?: 0.0
            load15 = parts.getOrNull(2)?.toDoubleOrNull() ?: 0.0
        }

        // Get CPU count
        var cpuCount = 1
        runCatching {
            cpuCount = execOrEmpty("nproc").trim().toIntOrNull() ?: 1
        }

        // Get disk usage
        var diskUsedGb = 0.0
        var diskTotalGb = 0.0
        var diskPercent = 0.0
        runCatching {
            val dfOutput = execOrEmpty("df", "-h", "/")
            val dfLine = dfOutput.lines().getOrNull(1) ?: ""
            val dfParts = dfLine.split(Regex("\\s+"))
            if (dfParts.size >= 5) {
                diskTotalGb = parseSizeToGb(dfParts[1])
                diskUsedGb = parseSizeToGb(dfParts[2])
                diskPercent = dfParts[4].replace("%", "").toDoubleOrNull() ?: 0.0
            }
        }

        return SystemStats(
            memoryTotalMb = memTotalMb,
            memoryUsedMb = memUsedMb,
            memoryPercent = memPercent,
            cpuCount = cpuCount,
            loadAverage1m = load1,
            loadAverage5m = load5,
            loadAverage15m = load15,
            diskUsedGb = diskUsedGb,
            diskTotalGb = diskTotalGb,
            diskPercent = diskPercent
        )
    }

    private fun parseSizeToGb(sizeStr: String): Double {
        val str = sizeStr.trim().uppercase()
        return when {
            str.endsWith("T") -> str.removeSuffix("T").toDoubleOrNull()?.times(1000) ?: 0.0
            str.endsWith("G") -> str.removeSuffix("G").toDoubleOrNull() ?: 0.0
            str.endsWith("M") -> str.removeSuffix("M").toDoubleOrNull()?.div(1000) ?: 0.0
            else -> 0.0
        }
    }

    // ── Container parsing ────────────────────────────────────────────────────

    private fun parseContainerJson(json: String): DockerContainerInfo? =
        runCatching {
            val node = objectMapper.readTree(json)
            val status = node.str("Status")
            DockerContainerInfo(
                id = node.str("ID").take(12),
                name = node.str("Names").removePrefix("/"),
                image = node.str("Image"),
                status = status,
                state =
                    when {
                        status.startsWith("Up") -> ContainerState.RUNNING
                        status.startsWith("Exited") -> ContainerState.STOPPED
                        status.startsWith("Paused") -> ContainerState.PAUSED
                        status.startsWith("Restarting") -> ContainerState.RESTARTING
                        else -> ContainerState.DEAD
                    },
                ports = parsePorts(node.str("Ports")),
                created = node.str("CreatedAt"),
                networks =
                    node
                        .str("Networks")
                        .split(",")
                        .map { it.trim() }
                        .filter { it.isNotEmpty() },
            )
        }.onFailure { logger.error(it) { "Failed to parse container JSON" } }.getOrNull()

    private val portRegex = """(\d+\.\d+\.\d+\.\d+):(\d+)->(\d+)/(tcp|udp)""".toRegex()

    private fun parsePorts(portsStr: String): List<PortMapping> =
        portsStr.split(",").mapNotNull { portRegex.find(it.trim())?.destructured?.let { (_, hp, cp, t) -> PortMapping(cp.toInt(), hp.toInt(), t) } }

    // ── Log helpers ──────────────────────────────────────────────────────────

    private fun filterLogsByLevel(
        logs: String,
        level: String
    ): String {
        val keywords =
            when (level) {
                "ERROR" -> listOf("ERROR", "EXCEPTION", "TRACEBACK")
                "WARN" -> listOf("WARN", "WARNING")
                else -> return logs
            }
        return logs
            .lines()
            .filter { line -> keywords.any { line.uppercase().contains(it) } }
            .joinToString("\n")
            .ifBlank { "No $level logs found" }
    }

    private fun countLogLevel(
        logs: String,
        level: String
    ): Int {
        val pattern =
            when (level) {
                "ERROR" -> """\b(ERROR|EXCEPTION|TRACEBACK)\b""".toRegex()
                "WARN" -> """\b(WARN|WARNING)\b""".toRegex()
                else -> return 0
            }
        return pattern.findAll(logs.uppercase()).count()
    }

    // ── Network helpers ──────────────────────────────────────────────────────

    private fun getActiveConnections(): List<NetworkConnection> =
        runCatching {
            exec("ss", "-tulnp")
                .getOrThrow()
                .lines()
                .filter { it.isNotBlank() && !it.startsWith("Netid") }
                .mapNotNull { line ->
                    val parts = line.trim().split(Regex("\\s+"))
                    if (parts.size < 5) return@mapNotNull null
                    val usersStr = parts.drop(6).joinToString(" ")
                    NetworkConnection(
                        protocol = parts[0],
                        localAddress = parts[4],
                        remoteAddress = parts.getOrElse(5) { "*:*" },
                        state = parts[1],
                        pid = """pid=(\d+)""".toRegex().find(usersStr)?.groupValues?.get(1)?.toIntOrNull(),
                        program = """\("([^"]+)""".toRegex().find(usersStr)?.groupValues?.get(1),
                    )
                }
        }.onFailure { logger.error(it) { "Failed to get active connections" } }.getOrDefault(emptyList())

    private fun getContainerNetworks(): Map<String, ContainerNetworkInfo> =
        runCatching {
            val root = objectMapper.readTree(exec("docker", "network", "inspect", "bridge").getOrThrow())
            if (!root.isArray || root.isEmpty) return@runCatching emptyMap()
            val network = root[0]
            val networkName = network.str("Name").ifBlank { "bridge" }
            buildMap {
                network.get("Containers")?.fields()?.forEach { (id, info) ->
                    put(
                        id.take(12),
                        ContainerNetworkInfo(
                            containerId = id.take(12),
                            containerName = info.str("Name"),
                            ipAddress = info.str("IPv4Address").substringBefore("/"),
                            gateway =
                                network
                                    .get("IPAM")
                                    ?.get("Config")
                                    ?.get(0)
                                    ?.str("Gateway") ?: "",
                            macAddress = info.str("MacAddress"),
                            networkName = networkName,
                        )
                    )
                }
            }
        }.onFailure { logger.error(it) { "Failed to get container networks" } }.getOrDefault(emptyMap())

    private fun getListeningPorts(): List<ListenPort> =
        runCatching {
            exec("sh", "-c", "ss -tuln state listening").getOrThrow().lines().drop(1).mapNotNull { line ->
                val parts = line.trim().split(Regex("\\s+"))
                if (parts.size < 5) return@mapNotNull null
                val localAddr = parts[3]
                val lastColon = localAddr.lastIndexOf(':')
                if (lastColon < 0) return@mapNotNull null
                val address = localAddr.substring(0, lastColon)
                val portStr = localAddr.substring(lastColon + 1)
                portStr.toIntOrNull()?.let { port -> ListenPort(port, parts[0], address, null, null) }
            }
        }.onFailure { logger.error(it) { "Failed to get listening ports" } }.getOrDefault(emptyList())
}
