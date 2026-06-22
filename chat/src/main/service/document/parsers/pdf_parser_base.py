"""
Abstract base + value objects for the pluggable PDF parser layer.

A ``PdfParser`` turns a PDF file into a normalised ``ParsedDocument`` (per-page
markdown/text + page geometry). It deliberately covers ONLY the raw extraction
step — the shared downstream pipeline (header reconstruction, chapter detection,
chunking, hierarchy) consumes the normalised output and is parser-agnostic.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class ParsedPage:
    """One page of extracted content."""

    text: str
    page_number: int  # 1-indexed
    width: float | None = None
    height: float | None = None


@dataclass
class ParsedDocument:
    """Normalised output of a parser, shared across backends."""

    parser_name: str
    pages: list[ParsedPage] = field(default_factory=list)
    parse_ms: float = 0.0
    error: str | None = None

    @property
    def full_text(self) -> str:
        return "\n\n".join(p.text for p in self.pages)

    @property
    def page_count(self) -> int:
        return len(self.pages)

    @property
    def ok(self) -> bool:
        return self.error is None and self.page_count > 0


class PdfParser(ABC):
    """A pluggable PDF extraction backend.

    Implementations must be cheap to construct (registered once at import) and
    must NOT raise from :meth:`parse` — return a ``ParsedDocument`` with ``error``
    set so the comparison harness can record the failure instead of crashing
    ingestion.
    """

    #: Stable identifier stored in the comparison table; keep it short + lowercase.
    name: str = "base"

    @abstractmethod
    def parse(self, file_path: str) -> ParsedDocument:
        """Extract ``file_path`` into a normalised :class:`ParsedDocument`."""

    def is_available(self) -> bool:
        """Whether the backend's runtime dependency is importable in this image."""
        return True
