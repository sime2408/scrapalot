"""
Multimodal Element Database Models

Stores image / table / equation elements extracted from documents during
ingest. Each element gets:
- a row here (raw element + LLM description + metadata)
- a descriptive text chunk in pgvector (so vector retrieval surfaces it)
- a (:Entity {entity_type='image|table|equation'}) node in Neo4j
"""

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import Column, ForeignKey, Index, Integer, Text
from sqlmodel import Field

from src.main.models.sqlite_compat import ScrapalotJSON
from src.main.models.sqlmodel_base import BaseModel, ScrapalotUUID


class MultimodalElement(BaseModel, table=True, extend_existing=True):
    """
    Image / table / equation extracted from a document.

    The raw element data lives here (image path, table markdown, equation
    LaTeX). The LLM-generated `description` is also embedded into a text
    chunk so vector retrieval can surface this element.
    """

    __tablename__ = "multimodal_elements"
    __table_args__ = (
        Index("ix_multimodal_elements_document_id", "document_id"),
        Index("ix_multimodal_elements_element_type", "element_type"),
        Index("ix_multimodal_elements_status", "processing_status"),
        {"extend_existing": True},
    )

    document_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        )
    )

    element_type: str = Field(max_length=16)
    element_index: int = Field(sa_column=Column(Integer, nullable=False, server_default="0"))
    page_idx: int | None = Field(default=None)

    bbox_json: dict[str, Any] | None = Field(default=None, sa_column=Column(ScrapalotJSON))

    storage_path: str | None = Field(max_length=500, default=None)
    content_text: str | None = Field(default=None, sa_column=Column(Text))

    caption: str | None = Field(default=None, sa_column=Column(Text))
    footnotes: list[str] | None = Field(default=None, sa_column=Column(ScrapalotJSON))

    description: str | None = Field(default=None, sa_column=Column(Text))
    entity_name: str | None = Field(max_length=255, default=None)
    entity_subtype: str | None = Field(max_length=64, default=None)

    structured_data: dict[str, Any] | None = Field(default=None, sa_column=Column(ScrapalotJSON))
    derived_stats: dict[str, Any] | None = Field(default=None, sa_column=Column(ScrapalotJSON))
    symbol_map: dict[str, str] | None = Field(default=None, sa_column=Column(ScrapalotJSON))

    chunk_id: UUID | None = Field(
        default=None,
        sa_column=Column(ScrapalotUUID(), nullable=True),
    )
    neo4j_entity_id: str | None = Field(max_length=128, default=None)

    processing_status: str = Field(max_length=20, default="pending")
    processing_error: str | None = Field(default=None, sa_column=Column(Text))
    described_at: datetime | None = Field(default=None)
