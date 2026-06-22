"""LiteParse backend (Apache-2.0, model-free, Rust-backed; shadow candidate)."""

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


class LiteParseParser(PdfParser):
    name = "liteparse"

    def is_available(self) -> bool:
        return importlib.util.find_spec("liteparse") is not None

    def parse(self, file_path: str) -> ParsedDocument:
        start = perf_counter()
        try:
            import liteparse

            # OCR off for parity with the production pymupdf text path (scanned
            # docs route to Docling/RapidOCR, not here). LiteParse pages are
            # 1-indexed; get_page(0) is always None.
            lp = liteparse.LiteParse(output_format="markdown", ocr_enabled=False, quiet=True)
            result = lp.parse(file_path)
            pages: list[ParsedPage] = []
            for i in range(1, result.num_pages + 1):
                page = result.get_page(i)
                if page is None:
                    continue
                pages.append(
                    ParsedPage(
                        text=page.text,
                        page_number=getattr(page, "page_num", i),
                        width=getattr(page, "width", None),
                        height=getattr(page, "height", None),
                    )
                )
            return ParsedDocument(self.name, pages=pages, parse_ms=(perf_counter() - start) * 1000)
        except Exception as e:
            logger.warning("liteparse parse failed for %s: %s", file_path, e)
            return ParsedDocument(self.name, parse_ms=(perf_counter() - start) * 1000, error=str(e))
