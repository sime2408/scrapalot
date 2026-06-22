from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, field_serializer


class SessionDTO(BaseModel):
    """DTO for sessions returned to clients"""

    id: UUID
    user_id: UUID
    collection_id: UUID | None = None
    conversation_name: str | None = None
    model_name: str | None = None  # Maps to last_model_used in database
    model_id: str | None = None  # Model UUID for reference
    created_at: datetime | str  # Accept either datetime or string
    updated_at: datetime | str  # Accept either datetime or string

    @field_serializer("created_at")
    def serialize_created_at(self, created_at: datetime | str) -> str:
        """Convert datetime to ISO string format during serialization"""
        if isinstance(created_at, datetime):
            return created_at.isoformat()
        return created_at

    @field_serializer("updated_at")
    def serialize_updated_at(self, updated_at: datetime | str) -> str:
        """Convert datetime to ISO string format during serialization"""
        if isinstance(updated_at, datetime):
            return updated_at.isoformat()
        return updated_at

    @classmethod
    def from_session(cls, session):
        """Create SessionDTO from a session dict or object.

        Accepts either a dict (from raw SQL query) or an object with attributes.
        ChatSession model has been moved to Kotlin backend.
        """
        if isinstance(session, dict):
            return cls(
                id=session["id"],
                user_id=session["user_id"],
                collection_id=session.get("collection_id"),
                conversation_name=session.get("conversation_name"),
                model_name=session.get("last_model_used") or session.get("model_name"),
                created_at=session.get("created_at") or "",
                updated_at=session.get("updated_at") or "",
            )
        return cls(
            id=session.id,
            user_id=session.user_id,
            collection_id=getattr(session, "collection_id", None),
            conversation_name=getattr(session, "conversation_name", None),
            model_name=getattr(session, "last_model_used", None) or getattr(session, "model_name", None),
            created_at=getattr(session, "created_at", None) or "",
            updated_at=getattr(session, "updated_at", None) or "",
        )

    # Configure model to work with SQLAlchemy attributes
    model_config = {"from_attributes": True}


class CreateSessionDTO(BaseModel):
    """DTO for creating a new session"""

    collection_id: UUID | None = None
    conversation_name: str | None = Field(None, min_length=1, max_length=255)
    model_name: str | None = None


class UpdateSessionDTO(BaseModel):
    """DTO for updating an existing session"""

    collection_id: UUID | None = None
    conversation_name: str | None = Field(None, min_length=1, max_length=255)
    model_name: str | None = None
