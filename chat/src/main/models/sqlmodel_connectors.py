"""
SQLModel models for external data connectors (Google Drive, Dropbox, etc.).
"""

from typing import Any
from uuid import UUID

from sqlalchemy import ForeignKey
from sqlmodel import JSON, Column, Field, Relationship, Text

from src.main.models.sqlmodel_base import BaseModel, ScrapalotUUID

# Import Job at module level to resolve relationships
from src.main.models.sqlmodel_jobs import Job

# =============================================================================
# CONNECTOR MODELS
# =============================================================================


class ConnectorCredential(BaseModel, table=True):
    """
    Encrypted OAuth and API credentials for external connectors.

    Stores authentication tokens and keys needed to access external services
    like Google Drive, Dropbox, SharePoint, etc.
    """

    __tablename__ = "connector_credentials"

    # Credential identification
    name: str = Field(max_length=100, unique=True)  # Unique credential name
    connector_type: str = Field(max_length=50)  # google_drive, dropbox, sharepoint, etc.

    # Encrypted credential data
    credential_json: str | None = Field(default=None, sa_column=Column(Text))  # Encrypted JSON
    access_token: str | None = Field(max_length=1000, default=None)  # Encrypted access token
    refresh_token: str | None = Field(max_length=1000, default=None)  # Encrypted refresh token

    # Token metadata
    token_expires_at: str | None = Field(default=None)  # ISO datetime string
    scope: str | None = Field(max_length=500, default=None)  # OAuth scopes

    # Credential status
    is_active: bool = Field(default=True)
    last_validated_at: str | None = Field(default=None)  # ISO datetime string
    validation_error: str | None = Field(default=None)

    # Additional metadata (renamed from 'metadata' to avoid SQLAlchemy reserved name conflict)
    credential_metadata: dict[str, Any] | None = Field(default=None, sa_column=Column("metadata", JSON))

    # Relationships
    connectors: list["Connector"] = Relationship(back_populates="credential", cascade_delete=True)


class Connector(BaseModel, table=True):
    """
    Workspace-level connector configurations.

    Links workspaces to external data sources with specific sync settings
    and destination configurations.
    """

    __tablename__ = "connectors"

    # Foreign keys
    workspace_id: UUID = Field(sa_column=Column(ScrapalotUUID(), nullable=False, index=True))
    credential_id: UUID = Field(sa_column=Column(ScrapalotUUID(), ForeignKey("connector_credentials.id", ondelete="CASCADE"), nullable=False))

    # Connector identification
    name: str = Field(max_length=100)  # User-friendly connector name
    connector_type: str = Field(max_length=50)  # google_drive, dropbox, etc.

    # Sync configuration
    sync_enabled: bool = Field(default=True)
    sync_frequency: str | None = Field(max_length=50, default="daily")  # manual, hourly, daily, weekly
    auto_sync: bool = Field(default=False)  # Enable automatic background sync

    # Source configuration
    source_path: str | None = Field(max_length=500, default=None)  # Root folder/path to sync
    file_filters: list[str] | None = Field(default=None, sa_column=Column(JSON))  # File extensions to include
    exclude_patterns: list[str] | None = Field(default=None, sa_column=Column(JSON))  # Patterns to exclude

    # Sync status
    last_sync_at: str | None = Field(default=None)  # ISO datetime string
    next_sync_at: str | None = Field(default=None)  # ISO datetime string
    sync_status: str = Field(max_length=20, default="idle")  # idle, running, completed, failed
    sync_error: str | None = Field(default=None)

    # Statistics
    total_files: int = Field(default=0)
    synced_files: int = Field(default=0)
    failed_files: int = Field(default=0)
    total_size_bytes: int = Field(default=0)

    # Configuration metadata
    config: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))

    # Relationships
    credential: ConnectorCredential = Relationship(back_populates="connectors")
    sync_destinations: list["ConnectorSyncDestination"] = Relationship(back_populates="connector", cascade_delete=True)
    file_syncs: list["ConnectorFileSync"] = Relationship(back_populates="connector", cascade_delete=True)
    sync_jobs: list["ConnectorSyncJob"] = Relationship(back_populates="connector", cascade_delete=True)
    oauth_states: list["ConnectorOAuthState"] = Relationship(back_populates="connector", cascade_delete=True)


class ConnectorSyncDestination(BaseModel, table=True):
    """
    Sync target configurations for connectors.

    Defines where synced files should be stored (collections, folders, etc.)
    and how they should be processed.
    """

    __tablename__ = "connector_sync_destinations"

    # Foreign keys
    connector_id: UUID = Field(sa_column=Column(ScrapalotUUID(), ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False, index=True))
    collection_id: UUID | None = Field(sa_column=Column(ScrapalotUUID(), nullable=True), default=None)

    # Destination configuration
    destination_type: str = Field(max_length=50)  # collection, folder, archive
    destination_path: str | None = Field(max_length=500, default=None)  # Target path/folder

    # Processing configuration
    auto_process: bool = Field(default=True)  # Auto-process synced files
    chunking_strategy: str | None = Field(max_length=50, default=None)  # Override collection chunking

    # File handling
    overwrite_existing: bool = Field(default=True)
    preserve_structure: bool = Field(default=False)  # Maintain folder hierarchy

    # Filtering and transformation
    file_filters: list[str] | None = Field(default=None, sa_column=Column(JSON))
    transform_rules: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))

    # Relationships
    connector: Connector = Relationship(back_populates="sync_destinations")


class ConnectorFileSync(BaseModel, table=True):
    """
    Individual file sync tracking.

    Tracks the sync status of each file from external sources,
    including version history and error handling.
    """

    __tablename__ = "connector_file_syncs"

    # Foreign keys
    connector_id: UUID = Field(sa_column=Column(ScrapalotUUID(), ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False, index=True))
    document_id: UUID | None = Field(sa_column=Column(ScrapalotUUID(), ForeignKey("documents.id", ondelete="SET NULL"), nullable=True), default=None)

    # External file identification
    external_file_id: str = Field(max_length=255, index=True)  # External system file ID
    external_file_path: str = Field(max_length=1000)  # Full path in external system
    file_name: str = Field(max_length=255)

    # File metadata
    file_size: int | None = Field(default=None)
    file_type: str | None = Field(max_length=50, default=None)
    external_modified_at: str | None = Field(default=None)  # ISO datetime string
    external_checksum: str | None = Field(max_length=100, default=None)  # MD5/SHA hash

    # Sync status
    sync_status: str = Field(max_length=20, default="pending")  # pending, syncing, completed, failed, skipped
    last_sync_attempt: str | None = Field(default=None)  # ISO datetime string
    last_successful_sync: str | None = Field(default=None)  # ISO datetime string
    sync_error: str | None = Field(default=None)
    retry_count: int = Field(default=0)

    # Local file information
    local_file_path: str | None = Field(max_length=500, default=None)
    local_checksum: str | None = Field(max_length=100, default=None)

    # Sync metadata
    sync_metadata: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))

    # Relationships
    connector: Connector = Relationship(back_populates="file_syncs")


class ConnectorSyncJob(BaseModel, table=True):
    """
    Background sync job tracking for connectors.

    Tracks batch sync operations, including progress, performance metrics,
    and detailed error information.
    """

    __tablename__ = "connector_sync_jobs"

    # Foreign keys
    connector_id: UUID = Field(sa_column=Column(ScrapalotUUID(), ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False, index=True))
    job_id: UUID | None = Field(sa_column=Column(ScrapalotUUID(), ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True), default=None)

    # Job identification
    sync_type: str = Field(max_length=50)  # full, incremental, manual
    trigger: str = Field(max_length=50)  # scheduled, manual, webhook

    # Job status
    status: str = Field(max_length=20, default="pending")  # pending, running, completed, failed
    progress: float = Field(default=0.0)  # Progress percentage

    # Timing information
    started_at: str | None = Field(default=None)  # ISO datetime string
    completed_at: str | None = Field(default=None)  # ISO datetime string
    duration_seconds: int | None = Field(default=None)

    # Sync statistics
    files_discovered: int = Field(default=0)
    files_new: int = Field(default=0)
    files_updated: int = Field(default=0)
    files_deleted: int = Field(default=0)
    files_failed: int = Field(default=0)
    files_skipped: int = Field(default=0)

    # Data transfer
    bytes_transferred: int = Field(default=0)
    transfer_rate_mbps: float | None = Field(default=None)

    # Error handling
    error_summary: str | None = Field(default=None)
    error_details: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))

    # Job metadata (renamed from 'metadata' to avoid SQLAlchemy reserved name conflict)
    sync_job_metadata: dict[str, Any] | None = Field(default=None, sa_column=Column("metadata", JSON))

    # Relationships
    connector: Connector = Relationship(back_populates="sync_jobs")
    job: Job | None = Relationship()


class ConnectorOAuthState(BaseModel, table=True):
    """
    OAuth flow state management for secure authentication.

    Tracks OAuth authentication flows to prevent CSRF attacks
    and manage multistep authentication processes.
    """

    __tablename__ = "connector_oauth_states"

    # Foreign key
    connector_id: UUID | None = Field(sa_column=Column(ScrapalotUUID(), ForeignKey("connectors.id", ondelete="CASCADE"), nullable=True), default=None)

    # OAuth state tracking
    state: str = Field(max_length=255, unique=True, index=True)  # OAuth state parameter
    provider: str = Field(max_length=50)  # OAuth provider name

    # Flow metadata
    redirect_uri: str | None = Field(max_length=500, default=None)
    scope: str | None = Field(max_length=500, default=None)

    # Security
    expires_at: str = Field()  # ISO datetime string - when state expires
    is_used: bool = Field(default=False)  # Whether state has been consumed

    # Additional OAuth data
    credentials: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    flow_data: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))

    # Relationships
    connector: Connector | None = Relationship(back_populates="oauth_states")


# Update forward references
ConnectorCredential.model_rebuild()
Connector.model_rebuild()
ConnectorSyncDestination.model_rebuild()
ConnectorFileSync.model_rebuild()
ConnectorSyncJob.model_rebuild()
ConnectorOAuthState.model_rebuild()
