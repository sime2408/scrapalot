from datetime import datetime
import json
from typing import Any
from uuid import UUID

from pydantic import BaseModel, field_serializer


class MessageDTO(BaseModel):
    id: UUID
    session_id: UUID
    role: str
    content: str
    created_at: datetime
    message_metadata: dict[str, Any] | None = None

    # tells Pydantic that it should allow creating model instances from ORM objects
    # noinspection PyUnusedName
    model_config = {"from_attributes": True}

    @field_serializer("message_metadata")
    def serialize_message_metadata(self, value: dict[str, Any] | None, _info) -> dict[str, Any] | None:
        """
        Ensure message_metadata is properly serialized to JSON-compatible dict.

        This prevents [object Object] issues when nested Python objects are not
        properly serialized before being sent to the frontend.
        """
        if value is None:
            return None

        # If it's already a dict, ensure it's JSON-serializable by round-tripping
        # This catches any nested non-serializable objects
        try:
            # Round-trip through JSON to ensure all nested objects are serializable
            json_str = json.dumps(value)
            return json.loads(json_str)
        except (TypeError, ValueError) as e:
            # If serialization fails, log warning and return None to prevent errors
            import logging

            logger = logging.getLogger(__name__)
            logger.warning("Failed to serialize message_metadata: %s, returning None", str(e))
            return None
