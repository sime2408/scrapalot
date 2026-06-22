"""
Pluggable PDF parser framework.

A small Strategy layer so the raw "PDF -> per-page markdown" step can be swapped
or compared across backends (pymupdf4llm-layout, LiteParse, ...) without touching
the shared downstream pipeline (chapter detection, chunking, hierarchy). New
backends register themselves in ``parser_registry`` and become available to the
shadow-comparison harness.
"""

from src.main.service.document.parsers.pdf_parser_base import (
    ParsedDocument,
    ParsedPage,
    PdfParser,
)

__all__ = ["ParsedDocument", "ParsedPage", "PdfParser"]
