"""
Stale section_heading at chapter-boundary clear — regression tests.

When a doc's first chunk of a new chapter inherits `section_heading =
UPPER(prev_chapter_title)` via the chunker's per-page H1 stamping, the
post-loop pass `_clear_stale_section_heading_at_chapter_boundary` (commit
TBD, 2026-05-15) clears it.

Strict gate (Hypothesis B chosen by user-override of Rule 11.4 after
8-doc cross-corpus signal):
  - chunk.section_heading != ""
  - chunk.chapter_number > prev_chunk.chapter_number (chapter advanced)
  - UPPER(chunk.section_heading) == UPPER(prev_chunk.chapter_title)

False-positive surface kept narrow by requiring EXACT case-folded match
plus monotonic chapter advance. Legitimate forward-references to other
chapter titles inside body text never survive both gates.

Canonical incident: Art of War 87b1967f had 11 affected chunks (idx
47, 51, 57, 61, 67, 86, 95, 108, 115, 144, 151 — every Sun Tzu chapter
transition from 6→13).
"""

from __future__ import annotations

import pytest


def _make_doc(ch_num: int, ch_title: str, section_heading: str = ""):
    """Build a minimal LangchainDocument-compatible fake."""

    class _FakeDoc:
        def __init__(self, num, title, sec):
            self.page_content = ""
            self.metadata = {
                "chapter_number": num,
                "chapter_title": title,
                "section_heading": sec,
            }

    return _FakeDoc(ch_num, ch_title, section_heading)


@pytest.mark.integration
class TestStaleHeadingClear:
    """The strict gate must clear UPPER-match stale headings at chapter advance."""

    def test_canonical_art_of_war_transition_cleared(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # Mimic Art of War ci=46 → ci=47 transition: ch_num goes 5→6,
        # ch_title goes 'Laying Plans' → 'Waging War', but section_heading
        # on the new chapter's first chunk is still 'LAYING PLANS'.
        docs = [
            _make_doc(5, "Laying Plans", "LAYING PLANS"),
            _make_doc(5, "Laying Plans", "LAYING PLANS"),
            _make_doc(6, "Waging War", "LAYING PLANS"),  # ci=47 stale
            _make_doc(6, "Waging War", "WAGING WAR"),
        ]
        result = DocumentProcessor._clear_stale_section_heading_at_chapter_boundary(docs)
        assert result[2].metadata["section_heading"] == "", "Stale section_heading should be cleared"
        # Surrounding chunks unchanged
        assert result[0].metadata["section_heading"] == "LAYING PLANS"
        assert result[1].metadata["section_heading"] == "LAYING PLANS"
        assert result[3].metadata["section_heading"] == "WAGING WAR"

    def test_multi_chapter_chain_all_cleared(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # Chain: 4→5→6 with stale bleed at every transition.
        docs = [
            _make_doc(4, "Attack by Stratagem", "ATTACK BY STRATAGEM"),
            _make_doc(5, "Tactical Dispositions", "ATTACK BY STRATAGEM"),  # stale
            _make_doc(5, "Tactical Dispositions", "TACTICAL DISPOSITIONS"),
            _make_doc(6, "Energy", "TACTICAL DISPOSITIONS"),  # stale
            _make_doc(6, "Energy", "ENERGY"),
        ]
        result = DocumentProcessor._clear_stale_section_heading_at_chapter_boundary(docs)
        assert result[1].metadata["section_heading"] == ""
        assert result[3].metadata["section_heading"] == ""

    def test_case_insensitive_match(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # Lowercase chunk_title with UPPER section_heading
        docs = [
            _make_doc(1, "introduction", "INTRODUCTION"),
            _make_doc(2, "next chapter", "INTRODUCTION"),  # stale
        ]
        result = DocumentProcessor._clear_stale_section_heading_at_chapter_boundary(docs)
        assert result[1].metadata["section_heading"] == ""


@pytest.mark.integration
class TestStaleHeadingClearFalsePositiveRejection:
    """Sections that legitimately differ from previous chapter title must survive."""

    def test_unrelated_section_heading_preserved(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # Real sub-section heading, NOT a copy of prev chapter title
        docs = [
            _make_doc(1, "Introduction", "OVERVIEW"),
            _make_doc(2, "Methodology", "DATA COLLECTION"),  # legit, not stale
        ]
        result = DocumentProcessor._clear_stale_section_heading_at_chapter_boundary(docs)
        assert result[1].metadata["section_heading"] == "DATA COLLECTION", "Legit sub-section heading should be preserved"

    def test_same_chapter_number_preserved(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # Two chunks in same chapter — even if section_heading matches a
        # previous chapter's title, no chapter advance → gate doesn't fire
        docs = [
            _make_doc(2, "Chapter Two", "INTRODUCTION"),
            _make_doc(2, "Chapter Two", "INTRODUCTION"),  # same ch_num
        ]
        result = DocumentProcessor._clear_stale_section_heading_at_chapter_boundary(docs)
        assert result[1].metadata["section_heading"] == "INTRODUCTION", "Same-chapter heading should be preserved"

    def test_backward_chapter_jump_preserved(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # Backward chapter jump (rare but possible in misordered chunks)
        # — gate requires ch_num > prev_ch_num, so backward stays untouched
        docs = [
            _make_doc(5, "Chapter Five", "CHAPTER FOUR"),
            _make_doc(4, "Chapter Four", "CHAPTER FIVE"),  # backward, NOT stale per gate
        ]
        result = DocumentProcessor._clear_stale_section_heading_at_chapter_boundary(docs)
        assert result[1].metadata["section_heading"] == "CHAPTER FIVE"

    def test_empty_prev_chapter_title_no_op(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # No prev_chapter_title yet — first chunk's section_heading survives
        docs = [
            _make_doc(1, "First Chapter", "INTRODUCTION"),
            _make_doc(2, "Second Chapter", "FIRST CHAPTER"),  # stale
        ]
        result = DocumentProcessor._clear_stale_section_heading_at_chapter_boundary(docs)
        # The first chunk should still have INTRODUCTION (no prev to compare)
        assert result[0].metadata["section_heading"] == "INTRODUCTION"
        # The second chunk should be cleared (matches prev_ch_title 'First Chapter')
        assert result[1].metadata["section_heading"] == ""

    def test_no_chapter_number_skipped(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # Chunks without chapter_number (None) skip the gate entirely
        class _NoChapDoc:
            def __init__(self, sec):
                self.metadata = {"section_heading": sec, "chapter_title": "x"}

        docs = [_NoChapDoc("INTRODUCTION"), _NoChapDoc("INTRODUCTION")]
        result = DocumentProcessor._clear_stale_section_heading_at_chapter_boundary(docs)
        assert result[0].metadata["section_heading"] == "INTRODUCTION"
        assert result[1].metadata["section_heading"] == "INTRODUCTION"

    def test_empty_section_heading_no_op(self):
        from src.main.service.document.document_processor import DocumentProcessor

        docs = [
            _make_doc(1, "First Chapter", "FIRST CHAPTER"),
            _make_doc(2, "Second Chapter", ""),  # empty — nothing to clear
        ]
        result = DocumentProcessor._clear_stale_section_heading_at_chapter_boundary(docs)
        assert result[1].metadata["section_heading"] == ""  # stays empty


@pytest.mark.integration
class TestStaleHeadingClearChainedWithConsolidation:
    """Verify the strict-gate clear runs as part of the consolidate-then-clear chain."""

    def test_consolidation_calls_strict_clear(self):
        from src.main.service.document.document_processor import DocumentProcessor

        # Setup: chapter 5 has both placeholder `Chapter 5` and real title `Energy`
        # → consolidation replaces placeholder. Chapter 6 inherits stale section_heading
        # from chapter 5. After consolidate-then-clear, chapter 6 first chunk should
        # have empty section_heading.
        docs = [
            _make_doc(5, "Energy", "ENERGY"),
            _make_doc(5, "Chapter 5", "ENERGY"),  # placeholder → consolidates to Energy
            _make_doc(6, "Weak Points and Strong", "ENERGY"),  # stale at boundary
        ]
        result = DocumentProcessor._consolidate_placeholder_chapter_titles(docs)
        # After consolidation chunk[1] has chapter_title='Energy'
        assert result[1].metadata["chapter_title"] == "Energy"
        # And chunk[2] section_heading was cleared (prev_chapter_title='Energy' upper matches 'ENERGY')
        assert result[2].metadata["section_heading"] == "", f"Got: {result[2].metadata['section_heading']!r}"
