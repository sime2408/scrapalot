"""
Parser comparison results.

One row per (document, parser): the deterministic quality score that backend
earned on that document, plus a ``is_winner`` flag. Lets us run pymupdf4llm in
production while LiteParse (and any future backend) parse in shadow, then decide
the real winner with a statistical query once enough documents have accumulated:

    SELECT parser_name,
           count(*) FILTER (WHERE is_winner) AS wins,
           count(*) AS total,
           avg(total_score) AS avg_score
    FROM parser_comparisons GROUP BY parser_name;
"""

from typing import Any
from uuid import UUID

from sqlalchemy import Boolean, Column, Float, ForeignKey, Index, Text
from sqlmodel import Field

from src.main.models.sqlite_compat import ScrapalotJSON
from src.main.models.sqlmodel_base import BaseModel, ScrapalotUUID


class ParserComparison(BaseModel, table=True, extend_existing=True):
    """Deterministic quality score for one parser backend on one document."""

    __tablename__ = "parser_comparisons"
    __table_args__ = (
        Index("ix_parser_comparisons_document_id", "document_id"),
        Index("ix_parser_comparisons_parser_name", "parser_name"),
        Index("ix_parser_comparisons_winner", "parser_name", "is_winner"),
        {"extend_existing": True},
    )

    document_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        )
    )

    parser_name: str = Field(max_length=32)
    is_winner: bool = Field(sa_column=Column(Boolean, nullable=False, server_default="false"))

    # Independently-detected chapter count (PDFChapterDetector reads the raw PDF),
    # the book-structure ground truth the structure score is graded against.
    expected_chapters: int | None = Field(default=None)

    total_score: float = Field(sa_column=Column(Float, nullable=False, server_default="0"))
    structure_score: float | None = Field(default=None, sa_column=Column(Float))
    completeness_score: float | None = Field(default=None, sa_column=Column(Float))
    cleanliness_score: float | None = Field(default=None, sa_column=Column(Float))

    page_count: int | None = Field(default=None)
    char_count: int | None = Field(default=None)
    header_count: int | None = Field(default=None)
    br_count: int | None = Field(default=None)
    parse_ms: float | None = Field(default=None, sa_column=Column(Float))

    metrics_json: dict[str, Any] | None = Field(default=None, sa_column=Column(ScrapalotJSON))
    error: str | None = Field(default=None, sa_column=Column(Text))
