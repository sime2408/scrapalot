"""
Body-prose forward-reference reject in _detect_chapters_in_chunks — regression tests.

When `_detect_chapters_in_chunks` Pattern 1/2 captures a forward-reference
sentence from chapter N's narrative ("Chapter 6 draws together areas for
future research across the diverse case studies..."), the captured tail
"draws together areas for future research across the diverse case" gets
elevated to chapter_title, advancing current_ch_num and mislabeling every
subsequent chunk.

Canonical incident: Ferne Edwards 2023 Food Resistance Movements
(doc 9a296063-e676...) chunks 58-70 stamped with chapter_number=6 and
chapter_title="draws together areas for future research across the
diverse case" — actually bibliography content from chapter 1.

The gate added in commit TBD (2026-05-15) rejects the match when:
  - captured title starts with a lowercase alpha character, AND
  - captured title has more than 5 whitespace-separated words

Both conditions together prevent false positives on legitimate short
foreign-language titles (`prima parte`, `teológica fundamental`,
`appendix e`) and short slug-style headings (`sociality-in-wasps`).
Real Title Case titles (`Soil and Plant Nutrition`) pass through
because they start with an uppercase letter regardless of word count.
"""

from __future__ import annotations

import pytest


def _gate_rejects(title_raw: str) -> bool:
    """Reproduce the exact predicate used in the source patch."""
    if title_raw and title_raw[0].isalpha() and title_raw[0].islower() and len(title_raw.split()) > 5:
        return True
    return False


@pytest.mark.integration
class TestBodyProseForwardReferenceGate:
    """Gate must reject forward-reference body sentences and preserve legitimate titles."""

    def test_canonical_forward_reference_rejected(self):
        # The actual Edwards 2023 incident — chapter 1 prose referring to chapter 6.
        assert _gate_rejects("draws together areas for future research across the diverse case")

    def test_other_common_forward_reference_verbs_rejected(self):
        for fragment in [
            "looks back on these experiences over almost two decades",
            "examines the role of urban agriculture in modern society",
            "introduces the framework for analysing collective action movements",
            "discusses the methodology applied across the four case studies",
            "concludes by drawing together the threads from prior chapters",
            "explores how participatory governance shapes outcomes",
        ]:
            assert _gate_rejects(fragment), f"Expected reject: {fragment!r}"

    def test_short_foreign_language_titles_preserved(self):
        # Italian, Spanish, French, etc. — lowercase but short
        for title in [
            "prima parte",  # Italian — FAO Plant Breeding doc
            "secondaParte",  # Italian camel — same doc
            "teológica fundamental",  # Portuguese/Spanish
            "épigraphes",  # French
            "appendix e",  # English section name
            "back_cover",  # generic section slug
        ]:
            assert not _gate_rejects(title), f"Should not reject foreign/short title: {title!r}"

    def test_real_title_case_titles_preserved(self):
        for title in [
            "Soil and Plant Nutrition",
            "The Latest Technologies in Agriculture",
            "Description of the faunal remains by taxon",
            "Subsistence First!",
            "Building Climate Resilience in Agriculture: Theory, Practice and Future Outlook",
            "Chapter 5",
        ]:
            assert not _gate_rejects(title), f"Should not reject real title: {title!r}"

    def test_digit_or_punct_start_preserved(self):
        # Titles starting with digits or punctuation never qualify for the gate
        for title in [
            "1492 onwards",
            "1. Introduction",
            "(2) Methodology",
            "[Appendix A]",
        ]:
            assert not _gate_rejects(title), f"Should not reject digit/punct-start: {title!r}"

    def test_short_lowercase_3_words_preserved(self):
        # Border case — 3 words is below the >5 threshold, so even lowercase
        # body fragments survive. Acceptable trade-off: catches the
        # frequent-5-word+ body-prose case, leaves 1-5 word slugs alone.
        for title in ["in this volume).", "is the Foreword.", "and so on"]:
            assert not _gate_rejects(title)

    def test_empty_title_no_reject(self):
        assert not _gate_rejects("")


@pytest.mark.integration
class TestDetectChaptersInChunksIntegration:
    """End-to-end: confirm the gate is wired into _detect_chapters_in_chunks."""

    def test_gate_present_in_source(self):
        import inspect

        from src.main.service.document.document_processor import DocumentProcessor

        src = inspect.getsource(DocumentProcessor._detect_chapters_in_chunks)
        # Pin the exact predicate so a refactor can't silently drop it
        assert "title_raw[0].isalpha() and title_raw[0].islower()" in src, "Lowercase + isalpha predicate missing"
        assert "len(title_raw.split()) > 5" in src, "Word-count threshold missing"
        # Confirm comment trail so future readers know the incident
        assert "forward-reference" in src.lower() or "forward-pointer" in src.lower(), "Forward-reference rationale comment missing"

    def test_phantom_chapter_not_promoted_in_synthetic_doc(self):
        # Build a synthetic chunk list mirroring the Edwards 2023 shape:
        #   - chunk 0: contains "Chapter 5 looks back on..." narrative
        #   - chunk 1: contains "Chapter 6 draws together areas..." narrative
        #   - chunk 2: body of chapter 1 bibliography
        # The current_ch_num should NOT advance to 6 because of the gate.
        from langchain_core.documents import Document as LangchainDocument

        from src.main.service.document.document_processor import DocumentProcessor

        chunks = [
            LangchainDocument(
                page_content=(
                    "This is chapter 1 introducing the case studies. "
                    "Chapter 5 looks back on these experiences over almost two decades. "
                    "Chapter 6 draws together areas for future research across the diverse case "
                    "studies to identify the next steps."
                ),
                metadata={"chunk_index": 0},
            ),
            LangchainDocument(
                page_content="More chapter 1 body content discussing food resistance movements.",
                metadata={"chunk_index": 1},
            ),
            LangchainDocument(
                page_content="Even more chapter 1 narrative covering urban agriculture history.",
                metadata={"chunk_index": 2},
            ),
        ]

        DocumentProcessor._detect_chapters_in_chunks(chunks)
        # Possible outcomes: either NO chapters detected (returns []) because
        # the forward-references are rejected; or only chapter 5 is detected
        # (uppercase next token if any). The KEY assertion is the negative:
        # chunks must NOT carry chapter_title="draws together..."
        for chunk in chunks:
            title = chunk.metadata.get("_inline_chapter_title", "") or ""
            assert "draws together" not in title.lower(), f"Phantom forward-ref title leaked: {title!r}"
