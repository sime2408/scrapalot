"""Admin-related DTOs for administrative operations."""

from enum import Enum

from pydantic import BaseModel


class TargetRepo(str, Enum):
    """Target repository for autofix workflow."""

    BACKEND = "backend"
    FRONTEND = "frontend"


class TriggerAutofixRequest(BaseModel):
    """A request to trigger the auto-fix GitHub workflow."""

    browser_errors: str
    error_context: str | None = None
    target_repo: TargetRepo = TargetRepo.BACKEND


class TriggerAutofixResponse(BaseModel):
    """Response from auto-fix trigger."""

    success: bool
    branch_name: str | None = None
    message: str


class DebugLogsResponse(BaseModel):
    """Response containing debug logs for display."""

    success: bool
    backend_logs: str
    frontend_logs: str | None = None
    message: str
