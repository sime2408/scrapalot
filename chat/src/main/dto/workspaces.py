from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class WorkspaceDTO(BaseModel):
    id: UUID
    name: str
    created_at: datetime
    updated_at: datetime | None
    role: str | None = None  # Current user's role: owner, editor, viewer
    is_shared: bool | None = None  # True if workspace is shared with current user (not owned)
    storage_bytes: int | None = None  # Total storage used in bytes
    storage_gb: float | None = None  # Total storage used in GB
    document_count: int | None = None  # Number of documents in workspace

    model_config = {"from_attributes": True}


class WorkspaceCreateDTO(BaseModel):
    name: str


class WorkspaceUpdateDTO(BaseModel):
    name: str | None = None


class WorkspaceUserRole(str):
    OWNER = "owner"
    EDITOR = "editor"
    VIEWER = "viewer"


class WorkspaceUserDTO(BaseModel):
    id: UUID | None = None
    workspace_id: UUID
    user_id: UUID
    role: str  # owner, editor, viewer
    created_at: datetime | None = None
    updated_at: datetime | None = None

    # For response include user details
    username: str | None = None
    email: str | None = None

    model_config = {"from_attributes": True}


class ShareWorkspaceDTO(BaseModel):
    workspace_id: UUID
    user_email: str  # Email of the user to share with
    role: str = WorkspaceUserRole.VIEWER


class WorkspaceWithUsersDTO(WorkspaceDTO):
    users: list[WorkspaceUserDTO] = []
