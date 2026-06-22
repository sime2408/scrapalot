"""
Python-only database models for data that Kotlin never owns.

These tables replace Kotlin-owned tables (notes, sessions, collections, workspaces)
with lightweight Python-specific storage:
- yjs_collaboration_state: Y.js CRDT state for real-time note collaboration
- conversation_summaries: Compressed conversation context for Python memory optimization
- collection_workspace_map: Workspace/collection metadata cache (replaces JOINs)
- graph_sync_status: Per-document checkpoint for Neo4j graph rebuild (restart resilience)
"""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import Column, DateTime, Index, Integer, LargeBinary, SmallInteger, String, Text, func
from sqlmodel import Field, SQLModel

from src.main.models.sqlmodel_base import ScrapalotUUID


class YjsCollaborationState(SQLModel, table=True):
    """Y.js CRDT binary state for real-time note collaboration.

    Persists Y.js document state across server restarts so that
    collaborative editing sessions can be resumed.
    """

    __tablename__ = "yjs_collaboration_state"
    __table_args__ = {"extend_existing": True}

    note_id: UUID = Field(
        sa_column=Column(ScrapalotUUID(), primary_key=True),
    )
    yjs_state: bytes | None = Field(
        default=None,
        sa_column=Column(LargeBinary, nullable=True),
    )
    updated_at: datetime | None = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(
            DateTime(timezone=True),
            server_default=func.now(),
            onupdate=func.now(),
            nullable=False,
        ),
    )


class ConversationSummary(SQLModel, table=True):
    """Compressed conversation context for Python memory optimization.

    Stores rolling summaries of conversations so that Python can maintain
    context without querying the full message history from Kotlin.
    """

    __tablename__ = "conversation_summaries"
    __table_args__ = {"extend_existing": True}

    session_id: UUID = Field(
        sa_column=Column(ScrapalotUUID(), primary_key=True),
    )
    summary: str | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
    )
    updated_at: datetime | None = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(
            DateTime(timezone=True),
            server_default=func.now(),
            onupdate=func.now(),
            nullable=False,
        ),
    )


class CollectionWorkspaceMap(SQLModel, table=True):
    """Workspace/collection metadata cache.

    Replaces direct JOINs through the dropped workspaces and collections tables.
    Populated via gRPC context when Kotlin sends workspace/collection info.
    """

    __tablename__ = "collection_workspace_map"
    __table_args__ = (
        Index("ix_cwm_workspace", "workspace_id"),
        Index("ix_cwm_owner", "owner_user_id"),
        {"extend_existing": True},
    )

    collection_id: UUID = Field(
        sa_column=Column(ScrapalotUUID(), primary_key=True),
    )
    workspace_id: UUID = Field(
        sa_column=Column(ScrapalotUUID(), nullable=False),
    )
    owner_user_id: UUID = Field(
        sa_column=Column(ScrapalotUUID(), nullable=False),
    )
    collection_name: str | None = Field(
        default=None,
        sa_column=Column(String(255), nullable=True),
    )
    description: str | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
    )
    workspace_name: str | None = Field(
        default=None,
        sa_column=Column(String(255), nullable=True),
    )
    parent_collection_id: UUID | None = Field(
        default=None,
        sa_column=Column(ScrapalotUUID(), nullable=True),
    )
    depth: int = Field(
        default=0,
        sa_column=Column(SmallInteger, nullable=False, server_default="0"),
    )
    # Knowledge-graph build tier replicated from Kotlin: 0=none, 1=light, 2=full.
    # NULL = inherit from the parent collection (resolve_graph_tier walks the
    # parent chain; a root NULL resolves to 0). Drives how much graph each book
    # in this collection builds at ingestion.
    graph_tier: int | None = Field(
        default=None,
        sa_column=Column(SmallInteger, nullable=True),
    )
    updated_at: datetime | None = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(
            DateTime(timezone=True),
            server_default=func.now(),
            onupdate=func.now(),
            nullable=False,
        ),
    )


class GraphSyncStatus(SQLModel, table=True):
    """Per-document checkpoint for Neo4j graph rebuild.

    Tracks which documents have completed hierarchy creation and entity
    extraction so that RebuildGraph can resume after a container restart
    without re-processing already-completed documents.

    Status flow: pending → hierarchy_done → entity_running → completed / failed
    """

    __tablename__ = "graph_sync_status"
    __table_args__ = (
        Index("ix_gss_collection", "collection_id"),
        Index("ix_gss_status", "status"),
        {"extend_existing": True},
    )

    document_id: str = Field(
        sa_column=Column(String(36), primary_key=True),
    )
    collection_id: str = Field(
        sa_column=Column(String(36), nullable=False),
    )
    status: str = Field(
        default="pending",
        sa_column=Column(String(20), nullable=False),
    )
    chunks_expected: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False, server_default="0"),
    )
    chunks_created: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False, server_default="0"),
    )
    entities_extracted: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False, server_default="0"),
    )
    error_message: str | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
    )
    started_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    completed_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    updated_at: datetime | None = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(
            DateTime(timezone=True),
            server_default=func.now(),
            onupdate=func.now(),
            nullable=False,
        ),
    )
