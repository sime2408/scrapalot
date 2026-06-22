"""
SQLModel models for the Scrapalot application.

This module contains SQLModel models for Python-owned tables.
Kotlin-owned tables (workspaces, collections, sessions, messages, notes,
note_shares, note_versions, note_comments, session_documents, chat_conversations)
have been removed — Kotlin backend is the single source of truth for those.
"""

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Optional
from uuid import UUID, uuid4

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    func,
)
from sqlmodel import JSON, Column, Field, Relationship

# Import Python-only replacement models to ensure they're in the shared registry
from src.main.models.python_only_models import (  # noqa: F401
    CollectionWorkspaceMap,
    ConversationSummary,
    YjsCollaborationState,
)
from src.main.models.sqlmodel_base import (
    BaseModel,
    ScrapalotUUID,
)
from src.main.models.sqlmodel_connectors import Connector  # noqa: F401
from src.main.models.sqlmodel_multimodal import MultimodalElement  # noqa: F401
from src.main.models.sqlmodel_parser_comparison import ParserComparison  # noqa: F401
from src.main.models.sqlmodel_providers import ModelProvider  # noqa: F401
from src.main.models.sqlmodel_research import (
    ResearchPlan,
    ResearchSource,
    ResearchSynthesis,
    ResearchTask,
    ResearchTemplate,
)

# =============================================================================
# USER SETTINGS (user_id is plain UUID, no FK to users table)
# =============================================================================


class UserSetting(BaseModel, table=True, extend_existing=True):
    """
    User-specific settings and preferences.

    Stores key-value pairs for user preferences, configurations,
    and application state.
    """

    __tablename__ = "user_settings"

    # User ID (plain UUID, no FK constraint)
    user_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            nullable=False,
            index=True,
        )
    )

    # Setting identification - matching actual database columns
    setting_key: str = Field(max_length=100, index=True)  # Database uses setting_key, not key

    # Setting value (JSON for flexibility) - matching actual database columns
    setting_value: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))  # Database uses setting_value, not value


# =============================================================================
# CONTENT STORE (content-addressable file storage with deduplication)
# =============================================================================


class ContentStore(BaseModel, table=True, extend_existing=True):
    """
    Content-addressable file storage for deduplication.

    Files are stored once by SHA-256 hash and shared across documents.
    Reference counting tracks how many documents point to each file.
    """

    __tablename__ = "content_store"

    file_hash: str = Field(max_length=64, index=True)
    content_hash: str | None = Field(max_length=64, default=None)
    file_path: str = Field(max_length=500)
    file_size: int = Field(sa_column=Column(Integer, nullable=False))
    file_type: str | None = Field(max_length=255, default=None)
    original_filename: str = Field(max_length=255)
    page_count: int | None = Field(default=None)
    word_count: int | None = Field(default=None)
    processing_status: str = Field(max_length=20, default="pending")
    ref_count: int = Field(default=1, sa_column=Column(Integer, nullable=False, server_default="1"))

    # Relationship to documents referencing this content
    documents: list["Document"] = Relationship(back_populates="content_store")


# =============================================================================
# DOCUMENT MODEL (collection_id is plain UUID, no FK to collections table)
# =============================================================================


class Document(BaseModel, table=True, extend_existing=True):
    """
    Document model for file metadata and processing status.
    """

    __tablename__ = "documents"

    # Collection ID (plain UUID, no FK constraint — collections table dropped)
    collection_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            nullable=False,
            index=True,
        )
    )

    # Document information
    title: str = Field(max_length=255)
    filename: str = Field(max_length=255)
    file_path: str = Field(max_length=500)
    file_size: int | None = Field(default=None)
    file_type: str | None = Field(max_length=255, default=None)

    # Content processing
    content: str | None = Field(default=None, sa_column=Column(Text))
    page_count: int | None = Field(default=None)
    word_count: int | None = Field(default=None)

    # Year the source document was originally published (NOT ingestion year).
    # Populated by the metadata resolvers (Google Books, OpenLibrary) when
    # they find a `publishedDate`. Lifted out of `extracted_metadata` JSON
    # into a dedicated column so temporal-graph queries and per-collection
    # date filters can index on it without parsing JSON every row.
    publication_year: int | None = Field(default=None, index=True)

    # Processing status
    processing_status: str = Field(max_length=20, default="pending")  # pending, processing, completed, failed
    processing_error: str | None = Field(default=None)
    processing_progress: float = Field(default=0.0)

    # Number of automatic retries the JobRecoveryService has already
    # consumed for this document. Bumped only when a worker died
    # mid-flight without producing artifacts; capped by
    # ``JobRecoveryService.MAX_AUTO_RETRIES``. Reset to 0 by manual
    # reprocess so the next death gets a fresh quota.
    process_retry_count: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False, server_default="0"),
    )

    # Metadata
    file_metadata: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    processing_stats: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    extracted_metadata: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    # Context Expansion: Document hierarchy
    # `none_as_null=True` so Python ``None`` writes SQL NULL instead of the
    # JSON literal ``null``. Without that flag, SQLAlchemy's default JSON
    # serialiser turns ``doc.document_hierarchy = None`` into the JSONB
    # value ``"null"``, which then has to be specifically distinguished
    # from absence in every query (`document_hierarchy IS NULL` doesn't
    # catch the literal). Cleaned up in production on 2026-05-04 — 625
    # rows had the literal stored before this fix landed.
    document_hierarchy: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON(none_as_null=True)))

    # Content hash for cache-aware reprocessing (SHA-256 of parsed content)
    content_hash: str | None = Field(max_length=64, default=None)

    # Content-addressable storage reference (deduplication)
    content_store_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            ScrapalotUUID(),
            ForeignKey("content_store.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
    )

    # Relationship to content store
    content_store: Optional["ContentStore"] = Relationship(back_populates="documents")

    # Whether the physical file is retained on disk (False = embeddings-only, temp file deleted after processing)
    file_stored: bool = Field(
        default=True,
        sa_column=Column(Boolean, nullable=False, server_default="true"),
    )

    # Job tracking
    celery_task_id: str | None = Field(max_length=100, default=None)

    # Soft delete (Trash)
    deleted_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True, index=True),
    )


class DocumentSummary(BaseModel, table=True, extend_existing=True):
    """
    Document summary model for storing chapter-level and document-level summaries.

    Summaries are generated during document processing and used for context expansion
    in RAG queries. Supports hierarchical summarization: chapters -> book.
    """

    __tablename__ = "document_summaries"
    __table_args__ = {"extend_existing": True}

    # Primary key
    id: UUID = Field(
        default_factory=uuid4,
        sa_column=Column(ScrapalotUUID(), primary_key=True),
    )

    # Foreign keys
    document_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        )
    )
    user_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            nullable=False,
            index=True,
        )
    )

    # Summary content
    summary_type: str = Field(max_length=50)  # 'chapter', 'book', 'section'
    summary_text: str = Field(sa_column=Column(Text))

    # Chapter/section identification — TEXT (no length cap). Polluted hierarchy
    # keys from flat-markdown EPUBs concatenated body text into the title and
    # blew past varchar(500), crashing chapter-summary inserts with
    # StringDataRightTruncation. Defensive truncation in
    # document_summary_service still trims to a soft limit, but the column
    # itself is no longer the choke point.
    chapter_title: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    chapter_index: int | None = Field(default=None)
    section_heading: str | None = Field(default=None, sa_column=Column(Text, nullable=True))

    # Chunk range for this summary
    chunk_start_index: int | None = Field(default=None)
    chunk_end_index: int | None = Field(default=None)

    # Semantic embedding (384-dim) for cosine similarity search
    # Populated on save; enables rag_hybrid_summary_search to rank by relevance
    embedding: list | None = Field(
        default=None,
        sa_column=Column(Vector(384), nullable=True),
    )

    # Metadata
    token_count: int | None = Field(default=None)
    model_used: str | None = Field(default=None, max_length=100)
    generation_cost: Decimal | None = Field(default=None, sa_column=Column(Numeric(10, 6)))

    # Timestamps
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), server_default=func.now(), nullable=False),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), server_default=func.now(), nullable=False),
    )


class ReadingPosition(BaseModel, table=True, extend_existing=True):
    """
    Stores user reading positions for documents (PDFs and EPUBs).

    Tracks where a user stopped reading in a document, including page number,
    scroll position, EPUB CFI string, and TTS character index for resuming text-to-speech.
    """

    __tablename__ = "reading_positions"
    __table_args__ = (
        UniqueConstraint("user_id", "document_id", name="uq_reading_position_user_document"),
        {"extend_existing": True},
    )

    # User ID (plain UUID, no FK constraint)
    user_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            nullable=False,
            index=True,
        )
    )
    document_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        )
    )

    # Reading position data
    page_number: int = Field(default=1)  # Current page (1-indexed) for PDFs
    scroll_position: float | None = Field(default=0.0)  # Scroll offset within page for PDFs
    epub_cfi: str | None = Field(default=None)  # EPUB Canonical Fragment Identifier for EPUBs
    last_tts_char_index: int | None = Field(default=None)  # TTS resume point
    total_pages: int | None = Field(default=None)  # Total pages in document

    # Relationships
    document: "Document" = Relationship()


# Update forward references
ContentStore.model_rebuild()
Document.model_rebuild()
ResearchTemplate.model_rebuild()
ResearchPlan.model_rebuild()
ResearchTask.model_rebuild()
ResearchSource.model_rebuild()
ResearchSynthesis.model_rebuild()
ReadingPosition.model_rebuild()
