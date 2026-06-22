"""Connector data models for document ingestion."""

from datetime import UTC, datetime
from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class ConnectorSource(str, Enum):
    """Supported connector sources."""

    # Cloud Storage
    GOOGLE_DRIVE = "google_drive"
    DROPBOX = "dropbox"
    ONEDRIVE = "onedrive"

    # Productivity & Collaboration
    NOTION = "notion"
    CONFLUENCE = "confluence"
    SLACK = "slack"

    # Note-taking
    ONENOTE = "onenote"

    # Academic / Research
    ZOTERO = "zotero"

    # Other (not yet implemented)
    FILE = "file"  # Local file upload
    WEB = "web"  # Web scraping
    YOUTUBE = "youtube"  # YouTube transcripts
    MCP = "mcp"  # Model Context Protocol


class Section(BaseModel):
    """Base section class with common attributes."""

    link: str | None = None
    text: str | None = None
    image_file_id: str | None = None


class TextSection(Section):
    """Section containing text content."""

    text: str  # Required for text sections


class ImageSection(Section):
    """Section containing an image reference."""

    image_file_id: str  # Required for image sections


class DocumentMetadata(BaseModel):
    """Metadata for a document."""

    connector_id: str
    file_name: str

    # Optional source information (some connectors don't require workspace/collection at metadata level)
    source: ConnectorSource | None = None
    workspace_id: str | None = None
    collection_id: str | None = None

    # File information
    file_id: str | None = None  # External file ID (Drive file ID, Notion page ID, etc.)
    file_path: str | None = None  # Display path
    file_type: str | None = None  # MIME type or extension
    file_size: int | None = None

    # Timestamps
    created_at: datetime | None = None
    updated_at: datetime | None = None
    last_modified: datetime | None = None

    # Ownership
    created_by: str | None = None
    modified_by: str | None = None

    # Academic paper metadata (for scholarly connectors)
    title: str | None = None
    authors: list[str] | None = None
    year: int | None = None
    citations: int | None = None
    url: str | None = None
    pdf_url: str | None = None
    source_type: str | None = None  # e.g., "academic_paper", "preprint"
    venue: str | None = None  # Conference or journal name
    publication_types: list[str] | None = None
    categories: list[str] | None = None  # arXiv categories
    primary_category: str | None = None  # arXiv primary category
    published_date: str | None = None  # ISO format date string
    updated_date: str | None = None
    comment: str | None = None  # arXiv comment
    journal_ref: str | None = None  # Journal reference
    doi: str | None = None  # Digital Object Identifier

    # Additional connector-specific metadata
    extra: dict[str, Any] = Field(default_factory=dict)


class DocumentBase(BaseModel):
    """Base document model."""

    id: str | None = None
    sections: list[Section] = Field(default_factory=list)
    source: ConnectorSource
    semantic_identifier: str  # Display name (e.g., "My Document.pdf")
    metadata: DocumentMetadata

    # Content
    title: str | None = None
    doc_updated_at: datetime | None = None

    def get_text_content(self) -> str:
        """Get all text content from sections."""
        texts = []
        for section in self.sections:
            if (isinstance(section, TextSection) and section.text) or (hasattr(section, "text") and section.text):
                texts.append(section.text)
        return " ".join(texts)

    def get_title_for_indexing(self) -> str:
        """Get the title for indexing purposes."""
        if self.title:
            return self.title
        return self.semantic_identifier


class Document(DocumentBase):
    """Complete document with required ID."""

    id: str  # Required for indexed documents
    source: ConnectorSource


class ConnectorCheckpoint(BaseModel):
    """Checkpoint for resumable connector sync."""

    checkpoint_id: str | None = None
    last_sync_time: datetime | None = None
    page_token: str | None = None  # For pagination
    cursor: str | None = None  # For cursor-based pagination
    processed_files: list[str] = Field(default_factory=list)
    has_more: bool = True
    metadata: dict[str, Any] = Field(default_factory=dict)


class ConnectorFailure(BaseModel):
    """Record of a connector failure."""

    connector_id: str
    file_id: str
    file_name: str
    error_type: str
    error_message: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    metadata: dict[str, Any] = Field(default_factory=dict)


class SyncStatus(str, Enum):
    """Status of file sync operation."""

    PENDING = "pending"
    SYNCING = "syncing"
    SYNCED = "synced"
    FAILED = "failed"


class DestinationType(str, Enum):
    """Type of sync destination."""

    WORKSPACE = "workspace"  # Available workspace-wide
    COLLECTION = "collection"  # Specific to a collection


class ConnectorFileSync(BaseModel):
    """File-level sync tracking."""

    id: UUID
    sync_destination_id: UUID
    file_id: str  # External file ID
    file_path: str | None = None
    file_name: str
    file_type: str | None = None
    file_size: int | None = None
    file_metadata: dict[str, Any] = Field(default_factory=dict)
    sync_status: SyncStatus
    error_message: str | None = None
    document_id: UUID | None = None  # Link to indexed document
    last_synced_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class ConnectorSyncDestination(BaseModel):
    """Sync destination configuration."""

    id: UUID
    connector_id: UUID
    destination_type: DestinationType
    destination_id: UUID | None = None  # Collection ID if type=collection, None if type=workspace
    sync_enabled: bool = True
    auto_sync: bool = False
    sync_frequency_minutes: int | None = None  # None = manual only
    last_synced_at: datetime | None = None
    next_sync_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
