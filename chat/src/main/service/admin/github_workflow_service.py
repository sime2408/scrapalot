"""Service for triggering GitHub Actions workflows."""

from datetime import UTC, datetime
from enum import Enum
import os

import httpx

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class TargetRepo(str, Enum):
    """Target repository for autofix workflow."""

    BACKEND = "backend"
    FRONTEND = "frontend"


class GitHubWorkflowService:
    """Service for triggering GitHub Actions workflows."""

    GITHUB_API_URL = "https://api.github.com"
    REPOS = {
        TargetRepo.BACKEND: "sime2408/scrapalot-chat",
        TargetRepo.FRONTEND: "sime2408/scrapalot-ui",
    }
    WORKFLOW_FILE = "autofix-manual-trigger.yml"

    def __init__(self):
        # GH_TOKEN used because GitHub doesn't allow GITHUB_ prefix for secrets
        self.token = os.getenv("GH_TOKEN") or os.getenv("GITHUB_TOKEN", "")

    async def trigger_autofix_workflow(
        self,
        error_log: str,
        error_context: str | None = None,
        pr_body: str | None = None,
        target_repo: TargetRepo = TargetRepo.BACKEND,
    ) -> tuple[bool, str]:
        """
        Trigger the auto-fix GitHub Actions workflow.

        Args:
            error_log: Combined browser + Docker error logs
            error_context: Additional context about the error
            pr_body: Optional PR description
            target_repo: Which repo to target (backend or frontend)

        Returns:
            Tuple of (success, message/branch_name)
        """
        if not self.token:
            logger.error("GitHub token not configured")
            return False, "GitHub token not configured"

        # Get the appropriate repo based on target
        repo = self.REPOS.get(target_repo, self.REPOS[TargetRepo.BACKEND])
        logger.info("Triggering autofix workflow for repo: %s", repo)

        # Generate branch name with repo prefix
        timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        repo_prefix = "ui" if target_repo == TargetRepo.FRONTEND else "backend"
        branch_name = f"autofix/{repo_prefix}-error-{timestamp}"

        # Prepare workflow dispatch payload
        # GitHub has input limits, truncate if needed
        max_log_size = 10000
        truncated_log = error_log[:max_log_size]
        if len(error_log) > max_log_size:
            truncated_log += "\n... [truncated]"

        payload = {
            "ref": "main",
            "inputs": {
                "error_log": truncated_log,
                "error_context": error_context or "",
                "branch_name": branch_name,
                "pr_body": pr_body or "",
            },
        }

        url = f"{self.GITHUB_API_URL}/repos/{repo}/actions/workflows/{self.WORKFLOW_FILE}/dispatches"

        headers = {
            "Accept": "application/vnd.github.v3+json",
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers=headers,
                    timeout=30.0,
                )

                if response.status_code == 204:
                    logger.info("Successfully triggered autofix workflow: %s", branch_name)
                    return True, branch_name
                else:
                    error_msg = f"GitHub API error: {response.status_code} - {response.text}"
                    logger.error(error_msg)
                    return False, error_msg

        except httpx.TimeoutException:
            logger.error("Timeout triggering GitHub workflow")
            return False, "Timeout connecting to GitHub"
        except Exception as e:
            logger.exception("Error triggering GitHub workflow: %s", str(e))
            return False, str(e)


github_workflow_service = GitHubWorkflowService()
