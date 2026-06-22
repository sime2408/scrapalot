from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class CollectionDTO(BaseModel):
    id: UUID | str
    name: str
    workspace_id: UUID | str
    description: str | None = None
    created_at: datetime
    updated_at: datetime | None = None
    documentCount: int | None = None
    # noinspection PyUnusedName
    model_config = {"from_attributes": True}

    def dict(self, *, exclude_none: bool = False, **kwargs):
        # For Pydantic v1 compatibility
        return self.model_dump(exclude_none=exclude_none, **kwargs)

    def model_dump(self, **kwargs):
        data = super().model_dump(**kwargs)
        # Convert UUID to string for serialization
        if isinstance(data["id"], UUID):
            data["id"] = str(data["id"])
        if isinstance(data["workspace_id"], UUID):
            data["workspace_id"] = str(data["workspace_id"])
        return data


class CollectionSummaryDTO(BaseModel):
    collection_id: str
    collection_name: str
    workspace_id: str
    workspace_name: str
    document_count: int
    chunk_count: int = 0  # Number of chunks/embeddings in langchain_pg_embedding
    document_types: dict[str, int]
    avg_document_size_kb: float
    avg_processing_time_sec: float = 0
    model_config = {"from_attributes": True}

    def dict(self, *, exclude_none: bool = False, **kwargs):
        # For Pydantic v1 compatibility
        return self.model_dump(exclude_none=exclude_none, **kwargs)


class CollectionsResponseDTO(BaseModel):
    collections: list[CollectionDTO]
    model_config = {"from_attributes": True}

    def dict(self, *, exclude_none: bool = False, **kwargs):
        # For Pydantic v1 compatibility
        return self.model_dump(exclude_none=exclude_none, **kwargs)


class MessageDTO(BaseModel):
    id: str
    session_id: str
    sender: str
    content: str


class MessageResponseDTO(BaseModel):
    message: str
    model_config = {"from_attributes": True}

    def dict(self, *, exclude_none: bool = False, **kwargs):
        # For Pydantic v1 compatibility
        return self.model_dump(exclude_none=exclude_none, **kwargs)
