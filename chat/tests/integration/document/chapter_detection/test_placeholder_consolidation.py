"""
Placeholder chapter_title consolidation — regression tests.

When `_inline_chapter_detection` catches a standalone `CHAPTER N` body line
whose real title is on the NEXT line (EPUB typographic openers like Foley
2019 `Farming for the Long Haul` 1cd00ce9, Kleppel `Emergent Agriculture`
84ea0789), the fallback at `document_processor.py` ~1180 synthesizes
`f"Chapter {num}"` and writes it as `chapter_title`. Sibling chunks that
hit the H1 path get the real title (`Subsistence First!`). The result is
inconsistent: same chapter_number, two distinct titles, one placeholder
and one real.

The consolidation pass added to `_assign_cross_page_chapter_metadata`
(commit TBD, 2026-05-14) does a final post-processing scan: for each
chapter_number, build a Counter of non-placeholder titles seen; then for
each chunk whose chapter_title matches `^Chapter \\d+$`, replace with the
most-frequent real title (if any).

These tests pin the consolidation against:
- True positive: placeholder + real title same chapter_number → replaced
- No-op: all chunks have placeholders → unchanged (no real to use)
- No-op: all chunks have real titles → unchanged
- No-op: chapter_number=0 / Introduction → not consolidated (special case)
- Section_title fallback: section_title placeholder also replaced
"""

from __future__ import annotations

import pytest


def _make_doc(ch_num: int, ch_title: str, sec_title: str = ""):
    """Build a minimal LangchainDocument-compatible fake with chapter metadata."""

    class _FakeDoc:
        def __init__(self, num: int, title: str, sec: str):
            self.page_content = ""
            self.metadata = {
                "chapter_number": num,
                "chapter_title": title,
                "section_title": sec or title,
            }

    return _FakeDoc(ch_num, ch_title, sec_title)


@pytest.mark.integration
class TestPlaceholderConsolidation:
    """Placeholder titles get rewritten to real titles from sibling chunks."""

    def test_placeholder_replaced_by_real_sibling(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # 3 chunks with real title + 2 chunks with placeholder, same chapter_number=3
        docs = [
            _make_doc(3, "Subsistence First!"),
            _make_doc(3, "Subsistence First!"),
            _make_doc(3, "Subsistence First!"),
            _make_doc(3, "Chapter 3"),
            _make_doc(3, "Chapter 3"),
        ]
        # The consolidation runs as a sub-step of _assign_cross_page_chapter_metadata.
        # We invoke it via the post-pass by setting up the chunked_documents and
        # calling the function with empty page_documents (skips chapter detection
        # entirely, jumps to the consolidation step at the end).
        result = DocumentProcessor._consolidate_placeholder_chapter_titles(docs)
        titles = [d.metadata["chapter_title"] for d in result]
        assert all(t == "Subsistence First!" for t in titles), f"Got: {titles}"

    def test_consolidation_replaces_section_title_too(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # Section title placeholder should also be replaced
        docs = [
            _make_doc(7, "Woodlands and Wastes", "Woodlands and Wastes"),
            _make_doc(7, "Chapter 7", "Chapter 7"),
        ]
        result = DocumentProcessor._consolidate_placeholder_chapter_titles(docs)
        assert result[1].metadata["chapter_title"] == "Woodlands and Wastes"
        assert result[1].metadata["section_title"] == "Woodlands and Wastes"

    def test_all_placeholders_no_op(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # No real title exists → placeholders stay (no consolidation possible)
        docs = [
            _make_doc(1, "Chapter 1"),
            _make_doc(1, "Chapter 1"),
            _make_doc(2, "Chapter 2"),
        ]
        result = DocumentProcessor._consolidate_placeholder_chapter_titles(docs)
        titles = [d.metadata["chapter_title"] for d in result]
        assert titles == ["Chapter 1", "Chapter 1", "Chapter 2"], f"Got: {titles}"

    def test_all_real_titles_no_op(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # No placeholders → all chunks stay as-is
        docs = [
            _make_doc(1, "Introduction to Soil"),
            _make_doc(1, "Introduction to Soil"),
            _make_doc(2, "Crop Rotation"),
        ]
        result = DocumentProcessor._consolidate_placeholder_chapter_titles(docs)
        titles = [d.metadata["chapter_title"] for d in result]
        assert titles == ["Introduction to Soil", "Introduction to Soil", "Crop Rotation"], f"Got: {titles}"

    def test_chapter_zero_introduction_not_consolidated(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # chapter_number=0 ("Introduction") is special — never has a numeric
        # placeholder mate (placeholders are `Chapter N` where N >= 1)
        docs = [
            _make_doc(0, "Introduction"),
            _make_doc(0, "Introduction"),
            _make_doc(1, "Real Chapter 1 Title"),
            _make_doc(1, "Chapter 1"),
        ]
        result = DocumentProcessor._consolidate_placeholder_chapter_titles(docs)
        titles = [d.metadata["chapter_title"] for d in result]
        assert titles == ["Introduction", "Introduction", "Real Chapter 1 Title", "Real Chapter 1 Title"]

    def test_most_common_real_title_wins(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # When multiple real titles exist for same chapter_number, the most
        # common wins. (This shouldn't happen in practice but the consolidation
        # must be deterministic.)
        docs = [
            _make_doc(5, "Real Title A"),
            _make_doc(5, "Real Title A"),
            _make_doc(5, "Real Title A"),
            _make_doc(5, "Real Title B"),  # less common
            _make_doc(5, "Chapter 5"),
        ]
        result = DocumentProcessor._consolidate_placeholder_chapter_titles(docs)
        # The placeholder should be replaced by the most common real title
        assert result[4].metadata["chapter_title"] == "Real Title A"

    def test_negative_chapter_numbers_skipped(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # Negative or zero chapter_number doesn't qualify for consolidation
        docs = [
            _make_doc(-1, "Some Title"),
            _make_doc(-1, "Chapter -1"),  # not a real placeholder, just edge
        ]
        result = DocumentProcessor._consolidate_placeholder_chapter_titles(docs)
        titles = [d.metadata["chapter_title"] for d in result]
        # Both unchanged
        assert titles == ["Some Title", "Chapter -1"], f"Got: {titles}"


@pytest.mark.integration
class TestStrictRealTitleGate:
    """Real-title validation must reject body-text fragments and TOC artifacts."""

    def test_body_text_fragment_not_used_as_real_title(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # Chunk with a body-text fragment masquerading as chapter_title should
        # NOT be used to consolidate placeholders. The placeholder must stay.
        docs = [
            _make_doc(
                5,
                "an be applied to a depth of 2-4 inches around well-established plants. Be sure that there is adequate moisture in the soil before applying the mulch. Mulches such as sawdust, wood shavings, and corncobs can use up some of the soil nitrogen as they decompose.",
            ),
            _make_doc(5, "Chapter 5"),
        ]
        result = DocumentProcessor._consolidate_placeholder_chapter_titles(docs)
        # Both should be unchanged — the body text fails the strict gate
        # (>20 words, >150 chars, has multiple `. `), so no real title exists.
        assert result[1].metadata["chapter_title"] == "Chapter 5", f"Got: {result[1].metadata['chapter_title']}"

    def test_punctuation_only_not_used(self):
        from src.main.service.document.document_processor import DocumentProcessor

        docs = [_make_doc(3, ")."), _make_doc(3, "Chapter 3")]
        result = DocumentProcessor._consolidate_placeholder_chapter_titles(docs)
        assert result[1].metadata["chapter_title"] == "Chapter 3"

    def test_markdown_only_not_used(self):
        from src.main.service.document.document_processor import DocumentProcessor

        docs = [_make_doc(7, "**"), _make_doc(7, "Chapter 7")]
        result = DocumentProcessor._consolidate_placeholder_chapter_titles(docs)
        assert result[1].metadata["chapter_title"] == "Chapter 7"

    def test_lowercase_start_not_used(self):
        from src.main.service.document.document_processor import DocumentProcessor

        docs = [
            _make_doc(9, "an effectively substitute the in-feed antibiotics."),
            _make_doc(9, "Chapter 9"),
        ]
        result = DocumentProcessor._consolidate_placeholder_chapter_titles(docs)
        assert result[1].metadata["chapter_title"] == "Chapter 9"

    def test_page_num_chapter_toc_artifact_not_used(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # TOC entry `148  CHAPTER 13` (page number + chapter ref) should not
        # be promoted to a real title.
        docs = [
            _make_doc(13, "148  CHAPTER 13"),
            _make_doc(13, "Chapter 13"),
        ]
        result = DocumentProcessor._consolidate_placeholder_chapter_titles(docs)
        assert result[1].metadata["chapter_title"] == "Chapter 13"

    def test_valid_long_title_used(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # 20-word title still valid (under cap)
        title = "Modulation of soil microbiome and related alterations to physical structural composition"
        docs = [_make_doc(11, title), _make_doc(11, "Chapter 11")]
        result = DocumentProcessor._consolidate_placeholder_chapter_titles(docs)
        assert result[1].metadata["chapter_title"] == title
