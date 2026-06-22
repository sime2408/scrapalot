"""Data Transfer Objects for notes API"""

from uuid import UUID

from pydantic import BaseModel, EmailStr, field_validator

# Note role constants
NOTE_ROLE_OWNER = "owner"
NOTE_ROLE_EDITOR = "editor"
NOTE_ROLE_VIEWER = "viewer"
SHAREABLE_ROLES = [NOTE_ROLE_EDITOR, NOTE_ROLE_VIEWER]


class CreateNoteRequest(BaseModel):
    workspace_id: UUID
    session_id: UUID | None = None
    title: str | None = None
    content: dict = {}


class UpdateNoteRequest(BaseModel):
    title: str | None = None
    content: dict | None = None


class ShareNoteRequest(BaseModel):
    email: EmailStr
    role: str  # editor, viewer

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        """Validate that the role is either 'editor' or 'viewer'."""
        if v not in SHAREABLE_ROLES:
            raise ValueError(f"Role must be one of: {', '.join(SHAREABLE_ROLES)}")
        return v


class CreateCommentRequest(BaseModel):
    content: str
    parent_comment_id: UUID | None = None
    position: dict | None = None


class UpdateCommentRequest(BaseModel):
    content: str


class RestoreVersionRequest(BaseModel):
    pass  # No body needed, version_id is in URL.
