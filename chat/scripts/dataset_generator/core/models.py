"""Pydantic data models for the dataset generator pipeline."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import Enum
from pathlib import Path

from pydantic import BaseModel, Field


class BookStatus(str, Enum):
    """Processing status for a book."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


class FileType(str, Enum):
    """Supported file types."""

    PDF = "pdf"
    EPUB = "epub"


class BookInfo(BaseModel):
    """Represents a discovered book file on disk."""

    file_path: str
    file_type: FileType
    file_size_mb: float
    title: str = ""
    page_count: int = 0

    @property
    def filename(self) -> str:
        """Filename stem (no extension) of the on-disk file."""
        return Path(self.file_path).stem


class ChapterData(BaseModel):
    """A chapter assembled from grouped chunks with hierarchy metadata."""

    number: int
    title: str
    text: str
    chunk_count: int = 0
    char_count: int = 0

    def model_post_init(self, __context) -> None:
        if not self.char_count:
            self.char_count = len(self.text)


class QAPair(BaseModel):
    """A single question-answer pair generated from book content."""

    question: str
    answer: str
    thinking: str | None = None
    topics: list[str] = Field(default_factory=list)
    quality_score: float = Field(ge=1.0, le=5.0)
    source_chapter: str = ""


class GenerationResult(BaseModel):
    """Result from a single Claude Code headless call."""

    qa_pairs: list[QAPair] = Field(default_factory=list)
    book_summary: str | None = None
    skipped_chapters: list[str] = Field(default_factory=list)


class QAOutput(BaseModel):
    """Final JSONL output format for a single Q&A pair."""

    question: str
    answer: str
    thinking: str | None = None
    metadata: QAMetadata


class QAMetadata(BaseModel):
    """Metadata attached to each Q&A pair in the output."""

    book_title: str
    chapter: str = ""
    topics: list[str] = Field(default_factory=list)
    quality_score: float
    source_file: str
    generated_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())


# Rebuild models that have forward references
QAOutput.model_rebuild()
