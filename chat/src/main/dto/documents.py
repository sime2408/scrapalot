from datetime import datetime
from typing import Any

from pydantic import BaseModel


class ThumbnailInfo(BaseModel):
    """Thumbnail metadata for a document."""

    has_thumbnail: bool = False
    has_custom: bool = False
    sizes: list[str] | None = None
    url_large: str | None = None  # Only large size is supported


class DocumentDTO(BaseModel):
    id: str
    title: str
    filename: str
    file_path: str
    file_metadata: dict[str, Any] | None = None
    collection_id: str
    created_at: datetime
    updated_at: datetime | None = None
    # Additional fields for view modes
    file_size: int | None = None
    file_type: str | None = None
    thumbnail: ThumbnailInfo | None = None
    # Processing status fields (required for frontend to show correct status)
    processing_status: str | None = None  # pending, processing, completed, failed
    job_status: str | None = None  # Status from the jobs table
    job_progress: float | None = None  # Progress percentage (0-100)
    job_message: str | None = None  # Status message
    job_errors: str | None = None  # Error information
    job_id: str | None = None  # Job ID for tracking

    # noinspection PyUnusedName
    model_config = {"from_attributes": True}
