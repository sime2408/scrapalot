from pydantic import BaseModel

from src.main.models.enums import JobStatus


class JobProgressUpdateDTO(BaseModel):
    """DTO for WebSocket job progress updates."""

    job_id: str
    document_id: str | None = None  # Optional if the update is general
    collection_id: str | None = None  # Optional field for the collection
    progress: float
    message: str
    status: JobStatus  # Use the enum for status
    errors: str | None = None  # Optional field for errors
    last_update_time: float | None = None  # Optional timestamp for the last update
    timestamp: float | None = None  # Optional field for tracking when the event occurred

    model_config = {
        "from_attributes": True,  # Allows creating DTO from ORM models if needed
        "use_enum_values": True,  # Serialize enums to their values
    }
