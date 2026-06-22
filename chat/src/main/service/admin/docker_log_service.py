"""Service for collecting Docker container logs."""

from pathlib import Path
import platform
import re
import subprocess

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class DockerLogService:
    """Service for collecting Docker container logs via Docker API socket."""

    DEFAULT_CONTAINER = "scrapalot-chat"
    DEFAULT_TAIL_LINES = 100
    DEFAULT_LOG_FILE = "data/logs/scrapalot.log"

    # Platform-specific Docker connection
    IS_WINDOWS = platform.system() == "Windows"
    DOCKER_SOCKET = "/var/run/docker.sock"  # Linux/Mac
    WINDOWS_PIPE = "//./pipe/docker_engine"  # Windows named pipe

    # Patterns to filter out from logs (admin/debug internal logs)
    IGNORE_PATTERNS = [
        re.compile(r"admin/debug", re.IGNORECASE),
        re.compile(r"get_debug_logs", re.IGNORECASE),
        re.compile(r"trigger.?autofix", re.IGNORECASE),
        re.compile(r"retrieved debug logs", re.IGNORECASE),
        re.compile(r"Admin.*retrieved.*logs", re.IGNORECASE),
        re.compile(r"Admin.*triggered.*autofix", re.IGNORECASE),
    ]

    def _should_filter_line(self, line: str) -> bool:
        """Check if a log line should be filtered out."""
        return any(pattern.search(line) for pattern in self.IGNORE_PATTERNS)

    def _filter_log_lines(self, logs: str) -> str:
        """Filter out admin/debug log lines from text logs."""
        lines = logs.split("\n")
        filtered = [line for line in lines if line.strip() and not self._should_filter_line(line)]
        return "\n".join(filtered)

    def _read_log_file(self, log_file: str, tail_lines: int) -> str | None:
        """
        Read logs from a file when Docker container is not available.

        Args:
            log_file: Path to the log file
            tail_lines: Number of lines to retrieve from the end

        Returns:
            Log output as string, or None if failed
        """
        try:
            log_path = Path(log_file)
            if not log_path.exists():
                logger.warning("Log file not found: %s", log_file)
                return None

            # Read last N lines efficiently
            with open(log_path, encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
                # Get last tail_lines
                last_lines = lines[-tail_lines:] if len(lines) > tail_lines else lines
                logs = "".join(last_lines)

            # Filter out admin/debug logs
            filtered_logs = self._filter_log_lines(logs)
            logger.info("Retrieved %d lines from log file: %s", len(last_lines), log_file)
            return filtered_logs.strip()

        except Exception as e:
            logger.exception("Error reading log file %s: %s", log_file, str(e))
            return None

    @staticmethod
    def _is_inside_docker() -> bool:
        """Check if running inside a Docker container."""
        return Path("/.dockerenv").exists()

    def get_container_logs(
        self,
        container_name: str = DEFAULT_CONTAINER,
        tail_lines: int = DEFAULT_TAIL_LINES,
    ) -> str | None:
        """
        Get recent logs from a Docker container.

        When running inside Docker, reads the log file directly.
        When running on the host, uses Docker API.

        Args:
            container_name: Name of the Docker container
            tail_lines: Number of lines to retrieve

        Returns:
            Log output as string, or None if failed
        """
        try:
            # Inside Docker: read log file directly (Docker API can't find own container by name)
            if self._is_inside_docker():
                return self._read_log_file(self.DEFAULT_LOG_FILE, tail_lines)

            if self.IS_WINDOWS:
                # Windows: Use docker CLI command (works with Docker Desktop)
                cmd = [
                    "docker",
                    "logs",
                    "--tail",
                    str(tail_lines),
                    container_name,
                ]

                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )

                if result.returncode == 0:
                    logs = result.stdout + result.stderr  # Combine stdout and stderr
                    # Filter out admin/debug logs
                    filtered_logs = self._filter_log_lines(logs)
                    logger.info("Retrieved %d lines from container %s (Windows)", tail_lines, container_name)
                    return filtered_logs.strip()
                else:
                    # Docker container not available - immediately fall back to log file
                    return self._read_log_file(self.DEFAULT_LOG_FILE, tail_lines)
            else:
                # Linux/Mac: Use curl with Unix socket
                url = f"http://localhost/containers/{container_name}/logs?stdout=1&stderr=1&tail={tail_lines}"
                cmd = [
                    "curl",
                    "-s",
                    "--unix-socket",
                    self.DOCKER_SOCKET,
                    url,
                ]

                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=False,  # Get raw bytes
                    timeout=30,
                    check=False,
                )

                if result.returncode == 0:
                    # Docker API returns logs with stream headers (8 bytes per frame)
                    # We need to strip these headers for readable output
                    logs = self._strip_docker_stream_headers(result.stdout)
                    logger.info("Retrieved %d lines from container %s (Linux/Mac)", tail_lines, container_name)
                    return logs.strip()
                else:
                    # Docker container not available - immediately fall back to log file
                    return self._read_log_file(self.DEFAULT_LOG_FILE, tail_lines)

        except subprocess.TimeoutExpired:
            logger.error("Timeout getting logs from container %s", container_name)
            return None
        except Exception as e:
            logger.exception("Error getting Docker logs: %s", str(e))
            return None

    def _strip_docker_stream_headers(self, raw_data: bytes) -> str:
        """
        Strip Docker stream headers from log output.

        Docker API returns logs in multiplexed stream format:
        - Bytes 0-7: Header for each frame
          - Byte 0: stream type (1=stdout, 2=stderr)
          - Bytes 1-3: reserved (zeros)
          - Bytes 4-7: payload size (big-endian uint32)
        - Bytes 8+: payload data

        Returns clean text log output.
        """
        output_lines = []
        pos = 0

        while pos < len(raw_data):
            # Need at least 8 bytes for header
            if pos + 8 > len(raw_data):
                break

            # Parse header
            # noinspection PyStatementEffect
            raw_data[pos]
            # Bytes 1-3 are reserved
            # Bytes 4-7 are size (big-endian uint32)
            size = int.from_bytes(raw_data[pos + 4 : pos + 8], byteorder="big")

            # Move past header
            pos += 8

            # Extract payload
            if pos + size > len(raw_data):
                # Incomplete frame, take what we have
                payload = raw_data[pos:]
                pos = len(raw_data)
            else:
                payload = raw_data[pos : pos + size]
                pos += size

            # Decode payload to string
            # noinspection PyBroadException
            try:
                text = payload.decode("utf-8", errors="replace")
                # Split into lines and add (filtering out admin/debug logs)
                for line in text.split("\n"):
                    clean_line = line.strip()
                    if clean_line and not self._should_filter_line(clean_line):
                        output_lines.append(clean_line)
            except Exception:
                # Skip unparsable data
                pass

        return "\n".join(output_lines)

    @staticmethod
    def extract_error_context(logs: str, context_lines: int = 5) -> str:
        """
        Extract error-related lines with context BEFORE each error.

        Shows only actual errors with preceding context lines.
        Stack trace lines following an error are included.

        Args:
            logs: Full log output
            context_lines: Number of lines to include BEFORE errors

        Returns:
            Filtered log output with error context only
        """
        lines = logs.split("\n")
        error_indices = []

        # Find lines containing error indicators (case-sensitive for precision)
        error_patterns = [
            "ERROR",
            "CRITICAL",
            "Exception",
            "Traceback (most recent call last)",
            "raise ",
        ]

        for i, line in enumerate(lines):
            if any(pattern in line for pattern in error_patterns):
                error_indices.append(i)

        if not error_indices:
            return f"No errors found in last {len(lines)} log lines."

        # Collect context lines BEFORE each error and stack trace AFTER
        result_lines = []
        processed_indices = set()

        for error_idx in error_indices:
            if error_idx in processed_indices:
                continue

            # Add separator between error blocks
            if result_lines:
                result_lines.append("")
                result_lines.append("--- next error ---")
                result_lines.append("")

            # Add context lines BEFORE the error
            start = max(0, error_idx - context_lines)
            for i in range(start, error_idx):
                if i not in processed_indices:
                    result_lines.append(lines[i])
                    processed_indices.add(i)

            # Add the error line with marker
            result_lines.append(f">>> {lines[error_idx]}")
            processed_indices.add(error_idx)

            # Include stack trace lines after error (indented lines or "File" refs)
            stack_idx = error_idx + 1
            while stack_idx < len(lines):
                line = lines[stack_idx]
                # Stack trace indicators
                is_stack = line.startswith("  ") or line.startswith("\t") or "File " in line or "line " in line or line.strip().startswith("^")
                if is_stack or not line.strip():
                    if stack_idx not in processed_indices:
                        result_lines.append(line)
                        processed_indices.add(stack_idx)
                    stack_idx += 1
                else:
                    break

        return "\n".join(result_lines)

    @staticmethod
    def extract_warning_context(logs: str, context_lines: int = 5) -> str:
        """
        Extract warning-related lines with context BEFORE each warning.

        Shows only actual warnings with preceding context lines.

        Args:
            logs: Full log output
            context_lines: Number of lines to include BEFORE warnings

        Returns:
            Filtered log output with warning context only
        """
        lines = logs.split("\n")
        warning_indices = []

        # Find lines containing warning indicators
        warning_patterns = [
            "WARNING",
            "WARN",
        ]

        for i, line in enumerate(lines):
            if any(pattern in line for pattern in warning_patterns):
                warning_indices.append(i)

        if not warning_indices:
            return f"No warnings found in last {len(lines)} log lines."

        # Collect context lines BEFORE each warning
        result_lines = []
        processed_indices = set()

        for warning_idx in warning_indices:
            if warning_idx in processed_indices:
                continue

            # Add separator between warning blocks
            if result_lines:
                result_lines.append("")
                result_lines.append("--- next warning ---")
                result_lines.append("")

            # Add context lines BEFORE the warning
            start = max(0, warning_idx - context_lines)
            for i in range(start, warning_idx):
                if i not in processed_indices:
                    result_lines.append(lines[i])
                    processed_indices.add(i)

            # Add the warning line with marker
            result_lines.append(f">>> {lines[warning_idx]}")
            processed_indices.add(warning_idx)

        return "\n".join(result_lines)


docker_log_service = DockerLogService()
