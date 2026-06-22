"""
Shared fixtures for chapter detection tests.

These tests exercise `DocumentProcessor._detect_chapters_from_text` directly
with synthetic single-page inputs. No DB, no gateway, no LLM — pure regex /
heuristic logic under test. They serve as a regression set for the planned
chunking refactor (see docs/README_REFACTOR_PLAN_CHUNKING.md).
"""

from __future__ import annotations

from pathlib import Path

from langchain_core.documents import Document as LangchainDocument
import pytest

from src.main.service.document.document_processor import DocumentProcessor

_FIXTURE_DIR = Path(__file__).parent.parent.parent.parent / "fixtures" / "chunking"


def _load_fixture(name: str) -> str:
    path = _FIXTURE_DIR / name
    assert path.exists(), f"Fixture not found: {path}"
    return path.read_text()


def _detect(content: str) -> dict:
    """Wrap content in a single-page LangchainDocument and run chapter detection."""
    page_doc = LangchainDocument(page_content=content, metadata={"page": 0})
    return DocumentProcessor._detect_chapters_from_text([page_doc])


def _chapters(result: dict) -> list[tuple[int, str]]:
    """Pull the (num, title) list from `_detect_chapters_from_text` output."""
    return list(result.get("_chapters", []))


@pytest.fixture
def detect_chapters():
    """Function fixture that returns the chapter list for a fixture file name."""

    def _impl(fixture_name: str) -> list[tuple[int, str]]:
        return _chapters(_detect(_load_fixture(fixture_name)))

    return _impl
