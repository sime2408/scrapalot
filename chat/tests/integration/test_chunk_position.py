"""
Integration tests for chunk position propagation.

Verifies that PDF page-level extraction propagates `page_bbox` to page
metadata, and that `apply_chunking_and_return_documents_with_pages`
copies a `position_json` payload (page, char_offset_start/end, bbox)
into every chunk's metadata. No mocks — real Document chunkers run
against synthetic LangchainDocument inputs (chunking logic is the unit
under test, not Docling itself).
"""

from __future__ import annotations

from langchain_core.documents import Document as LangchainDocument
import pytest

from src.main.service.document.chunk_position import (
    chunk_position_json,
    page_bbox_from_docling_page,
    page_bbox_from_pymupdf_metadata,
)


@pytest.mark.integration
class TestChunkPositionHelpers:
    def test_chunk_position_json_locates_substring(self):
        page_text = "First sentence. Second sentence. Third sentence."
        chunk = "Second sentence."
        pos = chunk_position_json(
            page=4,
            page_text=page_text,
            chunk_text=chunk,
            page_bbox=[0.0, 0.0, 612.0, 792.0],
        )
        assert pos["page"] == 4
        assert pos["char_offset_start"] == 16
        assert pos["char_offset_end"] == 16 + len(chunk)
        assert pos["bbox"] == [0.0, 0.0, 612.0, 792.0]

    def test_chunk_position_json_falls_back_when_not_found(self):
        pos = chunk_position_json(
            page=2,
            page_text="A B C",
            chunk_text="ZZZ",
            page_bbox=None,
            fallback_offset=42,
        )
        assert pos["char_offset_start"] == 42
        assert pos["char_offset_end"] == 42 + len("ZZZ")
        assert pos["bbox"] is None

    def test_chunk_position_json_handles_empty_chunk(self):
        pos = chunk_position_json(
            page=1,
            page_text="hi",
            chunk_text="",
            page_bbox=None,
            fallback_offset=7,
        )
        assert pos["char_offset_start"] == 7
        assert pos["char_offset_end"] == 7

    def test_docling_page_bbox_extraction(self):
        class FakeSize:
            width = 612.0
            height = 792.0

        class FakePage:
            size = FakeSize()

        bbox = page_bbox_from_docling_page(FakePage())
        assert bbox == [0.0, 0.0, 612.0, 792.0]

    def test_docling_page_bbox_returns_none_when_no_size(self):
        class BarePage:
            pass

        assert page_bbox_from_docling_page(BarePage()) is None

    def test_pymupdf_page_bbox_extraction(self):
        bbox = page_bbox_from_pymupdf_metadata({"width": 595, "height": 842})
        assert bbox == [0.0, 0.0, 595.0, 842.0]

    def test_pymupdf_page_bbox_returns_none_when_missing(self):
        assert page_bbox_from_pymupdf_metadata({}) is None


@pytest.mark.integration
class TestChunkPositionInChunkingPipeline:
    def test_chunks_inherit_position_json_from_pages(self, tmp_path):
        """apply_chunking_and_return_documents_with_pages must copy a
        position_json payload into every chunk produced from a page that
        carries page_bbox metadata."""

        from src.main.service.document.document_processor import DocumentProcessor

        # Two synthetic pages with text long enough to chunk.
        page_one_text = "Introduction. " + ("A first body paragraph that explains background. " * 10) + "End of page one."
        page_two_text = "Methods. " + ("A second body paragraph describing how the experiment was run. " * 10) + "End of page two."

        pages = [
            LangchainDocument(
                page_content=page_one_text,
                metadata={
                    "source": "fake.pdf",
                    "page": 1,
                    "type": "pdf",
                    "page_bbox": [0.0, 0.0, 612.0, 792.0],
                },
            ),
            LangchainDocument(
                page_content=page_two_text,
                metadata={
                    "source": "fake.pdf",
                    "page": 2,
                    "type": "pdf",
                    "page_bbox": [0.0, 0.0, 612.0, 792.0],
                },
            ),
        ]

        fake_pdf = tmp_path / "fake.pdf"
        fake_pdf.write_bytes(b"%PDF-1.4\n%fake\n")

        chunks = DocumentProcessor.apply_chunking_and_return_documents_with_pages(
            page_documents=pages,
            file_path=str(fake_pdf),
            db=None,
            user_id=None,
            metadata_file_path=str(fake_pdf),
        )

        assert len(chunks) >= 2

        pages_seen = set()
        for chunk in chunks:
            pos = chunk.metadata.get("position_json")
            assert pos is not None, f"chunk missing position_json: {chunk.metadata}"
            assert pos["page"] in (1, 2)
            assert pos["bbox"] == [0.0, 0.0, 612.0, 792.0]
            assert pos["char_offset_start"] >= 0
            assert pos["char_offset_end"] >= pos["char_offset_start"]
            pages_seen.add(pos["page"])

        assert pages_seen == {1, 2}

    def test_chunk_position_json_absent_when_page_bbox_missing(self, tmp_path):
        """Pages without page_bbox still get position_json with bbox=None."""

        from src.main.service.document.document_processor import DocumentProcessor

        long_text = "Body. " + ("A body sentence. " * 30)
        pages = [
            LangchainDocument(
                page_content=long_text,
                metadata={"source": "fake.pdf", "page": 1, "type": "pdf"},
            ),
        ]

        fake_pdf = tmp_path / "fake.pdf"
        fake_pdf.write_bytes(b"%PDF-1.4\n%fake\n")

        chunks = DocumentProcessor.apply_chunking_and_return_documents_with_pages(
            page_documents=pages,
            file_path=str(fake_pdf),
            db=None,
            user_id=None,
            metadata_file_path=str(fake_pdf),
        )

        for chunk in chunks:
            pos = chunk.metadata.get("position_json")
            assert pos is not None
            assert pos["page"] == 1
            assert pos["bbox"] is None
            assert pos["char_offset_start"] >= 0


@pytest.mark.integration
class TestCitationPacketPosition:
    def test_citation_info_packet_carries_chunk_position(self):
        from src.main.dto.streaming import CitationInfoPacket

        position = {
            "page": 12,
            "char_offset_start": 100,
            "char_offset_end": 220,
            "bbox": [10.0, 20.0, 600.0, 780.0],
        }
        packet = CitationInfoPacket(
            citation_num=1,
            document_id="doc-1",
            document_title="Doc title",
            page=12,
            chunk_position_json=position,
        )
        round_tripped = packet.model_dump_json()
        assert '"chunk_position_json":' in round_tripped
        rebuilt = CitationInfoPacket.model_validate_json(round_tripped)
        assert rebuilt.chunk_position_json == position

    def test_citation_info_packet_without_position_serialises(self):
        from src.main.dto.streaming import CitationInfoPacket

        packet = CitationInfoPacket(
            citation_num=2,
            document_id="doc-2",
            document_title="Doc title",
        )
        rebuilt = CitationInfoPacket.model_validate_json(packet.model_dump_json())
        assert rebuilt.chunk_position_json is None
