"""Integration tests for annotation color filtering / re-scoring.

The unit under test is `annotation_color_filter.filter_and_rescore_documents`
plus the page-extraction helpers. We do not call the Kotlin gRPC client
(that path is exercised end-to-end in chat tests); we instead inject a
`ColorPageIndex` directly so the pure filter logic is verifiable without
requiring annotations on the cloud DB during CI.
"""

from __future__ import annotations

from langchain_core.documents import Document
import pytest

from src.main.service.rag.annotation_color_filter import (
    ColorFilterResult,
    _document_id,
    _document_page,
    _selected_text_page_index,
    filter_and_rescore_documents,
)


@pytest.mark.integration
class TestAnnotationPageExtractor:
    def test_extracts_page_index_from_pdf_position_json(self):
        ann = {"position_json": '{"type":"pdf","page_index":5,"rects":[]}'}
        assert _selected_text_page_index(ann) == 5

    def test_returns_none_for_non_pdf_position(self):
        ann = {"position_json": '{"type":"epub","cfi":"epubcfi(/6/4!/4/2)"}'}
        assert _selected_text_page_index(ann) is None

    def test_returns_none_for_invalid_json(self):
        ann = {"position_json": "not-json"}
        assert _selected_text_page_index(ann) is None

    def test_returns_none_when_no_position_json(self):
        assert _selected_text_page_index({}) is None


@pytest.mark.integration
class TestDocumentMetadataExtractors:
    def test_resolves_doc_id_from_metadata(self):
        doc = Document(page_content="x", metadata={"document_id": "abc-123"})
        assert _document_id(doc) == "abc-123"

    def test_resolves_page_from_position_json(self):
        doc = Document(
            page_content="x",
            metadata={"position_json": {"page": 4, "char_offset_start": 0}},
        )
        # 1-based page 4 -> 0-based page index 3
        assert _document_page(doc) == 3

    def test_resolves_page_from_legacy_metadata_field(self):
        doc = Document(page_content="x", metadata={"page": 7})
        assert _document_page(doc) == 6

    def test_returns_none_when_neither_field_present(self):
        doc = Document(page_content="x", metadata={"document_id": "abc"})
        assert _document_page(doc) is None


@pytest.mark.integration
class TestFilterAndRescore:
    def _docs(self) -> list[Document]:
        return [
            Document(
                page_content="A",
                metadata={"document_id": "doc-A", "page": 1, "score": 0.7},
            ),
            Document(
                page_content="B",
                metadata={"document_id": "doc-A", "page": 4, "score": 0.6},
            ),
            Document(
                page_content="C",
                metadata={"document_id": "doc-B", "page": 1, "score": 0.5},
            ),
        ]

    def test_drops_documents_outside_color_index(self):
        # Index covers only doc-A page 1 (page_index = 0 since metadata.page=1)
        index = {("doc-A", 0): 1.5}
        out = filter_and_rescore_documents(self._docs(), index)
        assert len(out) == 1
        assert out[0].page_content == "A"
        # Boost applied: 0.7 * 1.5 = 1.05
        assert pytest.approx(out[0].metadata["score"], rel=1e-6) == 0.7 * 1.5
        assert out[0].metadata["annotation_color_boost"] == 1.5

    def test_empty_index_is_passthrough(self):
        out = filter_and_rescore_documents(self._docs(), {})
        assert out == self._docs()

    def test_sorts_by_boosted_score_desc(self):
        # Two docs match; one with bigger boost should sort first
        index = {("doc-A", 0): 1.2, ("doc-A", 3): 1.5}
        out = filter_and_rescore_documents(self._docs(), index)
        assert len(out) == 2
        # doc-A page 4 (0.6 * 1.5 = 0.9) ranks above doc-A page 1 (0.7 * 1.2 = 0.84)
        assert out[0].metadata["document_id"] == "doc-A"
        assert out[0].metadata["page"] == 4
        assert out[1].metadata["page"] == 1


@pytest.mark.integration
class TestColorFilterResultDataclass:
    def test_default_construction(self):
        r = ColorFilterResult(index={}, matched_colors=set(), matched_annotations=0)
        assert r.index == {}
        assert r.matched_colors == set()
        assert r.matched_annotations == 0
