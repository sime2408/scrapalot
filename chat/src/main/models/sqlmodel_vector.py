"""
SQLModel models for vector search and embeddings (pgvector integration).

LangChain's pgvector tables are used for all vector storage:
- langchain_pg_collection: Collection metadata
- langchain_pg_embedding: Document chunks with embeddings
"""

from typing import Any
from uuid import UUID

from sqlalchemy import ForeignKey, LargeBinary
from sqlmodel import JSON, Column, Field, Relationship, Text

from src.main.models.sqlmodel_base import BaseModel, ScrapalotUUID

# =============================================================================
# VECTOR SEARCH MODELS (LangChain pgvector)
# =============================================================================


class CollectionStore(BaseModel, table=True):
    """
    LangChain collection metadata for vector search.

    Stores collection-level metadata for vector search operations
    using LangChain's pgvector integration.
    """

    __tablename__ = "langchain_pg_collection"

    # Collection identification
    name: str = Field(max_length=255, unique=True)  # Collection name for LangChain
    cmetadata: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))  # Collection metadata

    # UUID field (keeping LangChain compatibility)
    uuid: UUID | None = Field(default=None, unique=True, index=True)

    # Relationships
    embeddings: list["EmbeddingStore"] = Relationship(back_populates="collection", cascade_delete=True)


class EmbeddingStore(BaseModel, table=True):
    """
    Vector embeddings storage for semantic search.

    Stores document chunk embeddings with metadata for pgvector-based
    similarity search operations. This is the primary storage for document
    chunks - metadata is stored in the cmetadata JSON column.

    Metadata fields available in cmetadata:
    - document_id: UUID of the source document
    - chunk_index: Position in document
    - section_heading: Section/heading name
    - header_path: Hierarchical path of headers
    - chapter_title: Chapter title if applicable
    - heading_level: H1, H2, H3, etc.
    """

    __tablename__ = "langchain_pg_embedding"

    # Foreign key to collection (references langchain_pg_collection.uuid per LangChain schema)
    collection_id: UUID | None = Field(
        sa_column=Column(ScrapalotUUID(), ForeignKey("langchain_pg_collection.uuid"), nullable=True, index=True),
        default=None,
    )

    # Document content and metadata
    document: str | None = Field(default=None, sa_column=Column(Text))  # Original text content
    cmetadata: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))  # Chunk metadata

    # Vector embedding (stored as bytes for pgvector compatibility)
    embedding: bytes | None = Field(default=None, sa_column=Column(LargeBinary))  # Vector embedding

    # Additional fields for enhanced search
    custom_id: str | None = Field(max_length=255, default=None, index=True)  # Custom document ID

    # Relationships
    collection: CollectionStore | None = Relationship(back_populates="embeddings")


# Update forward references
CollectionStore.model_rebuild()
EmbeddingStore.model_rebuild()
