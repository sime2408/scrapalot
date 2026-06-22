"""
Registry for pluggable PDF parsers.

Plug-and-play: implement :class:`PdfParser`, register it here (or via
``register()`` from anywhere), and it joins the shadow-comparison harness. The
``production`` parser is the one whose output ingestion actually chunks; the
others run only in shadow until the accumulated comparison stats justify a flip.
"""

from __future__ import annotations

from src.main.service.document.parsers.liteparse_parser import LiteParseParser
from src.main.service.document.parsers.pdf_parser_base import PdfParser
from src.main.service.document.parsers.pymupdf_parser import PyMuPdf4LlmParser

# Insertion order = display order. The first available one is the default
# production parser unless overridden by config.
_REGISTRY: dict[str, PdfParser] = {}

#: Name of the backend whose output is used for production chunking today.
PRODUCTION_PARSER = "pymupdf4llm"


def register(parser: PdfParser) -> None:
    _REGISTRY[parser.name] = parser


def get_parser(name: str) -> PdfParser | None:
    return _REGISTRY.get(name)


def available_parsers() -> list[PdfParser]:
    """Registered parsers whose runtime dependency is importable in this image."""
    return [p for p in _REGISTRY.values() if p.is_available()]


def all_parser_names() -> list[str]:
    return list(_REGISTRY.keys())


# Default registrations.
register(PyMuPdf4LlmParser())
register(LiteParseParser())
