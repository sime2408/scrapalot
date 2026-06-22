"""pymupdf4llm-layout backend (the current production parser)."""

from __future__ import annotations

import importlib.util
from time import perf_counter

from src.main.service.document.parsers.pdf_parser_base import (
    ParsedDocument,
    ParsedPage,
    PdfParser,
)
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class PyMuPdf4LlmParser(PdfParser):
    name = "pymupdf4llm"

    def is_available(self) -> bool:
        return importlib.util.find_spec("pymupdf4llm") is not None

    @classmethod
    def from_raw_result(cls, result: list, parse_ms: float = 0.0) -> ParsedDocument:
        """Build a ParsedDocument from an ALREADY-COMPUTED ``to_markdown(page_chunks=
        True)`` result. Lets the production path (which already parses once) hand its
        raw output to the shadow comparison instead of re-parsing — the costly part."""
        pages: list[ParsedPage] = []
        # page_chunks=True -> list of {"text", "metadata"} dicts.
        for idx, page in enumerate(result or []):
            meta = page.get("metadata", {}) if isinstance(page, dict) else {}
            page_num = int(meta.get("page", meta.get("page_number", idx + 1)) or (idx + 1))
            pages.append(
                ParsedPage(
                    text=page.get("text", "") if isinstance(page, dict) else str(page),
                    page_number=page_num,
                    width=meta.get("width"),
                    height=meta.get("height"),
                )
            )
        return ParsedDocument(cls.name, pages=pages, parse_ms=parse_ms)

    def parse(self, file_path: str) -> ParsedDocument:
        start = perf_counter()
        try:
            import pymupdf4llm

            result = pymupdf4llm.to_markdown(file_path, page_chunks=True, show_progress=False)
            return self.from_raw_result(result, parse_ms=(perf_counter() - start) * 1000)
        except Exception as e:
            logger.warning("pymupdf4llm parse failed for %s: %s", file_path, e)
            return ParsedDocument(self.name, parse_ms=(perf_counter() - start) * 1000, error=str(e))
