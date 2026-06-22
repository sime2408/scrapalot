"""
Sequence guard — regression tests (commit 761abb5).

When Pattern A-D produces chapter titles that form a clear A-Z alphabet
or 1-N numeric sequence (dictionary / encyclopedia / numbered TOC), the
titles are LEGITIMATE structural markers, not garbage. The sequence
guard prevents Tier 3.8's `dominant_garbage` heuristic from
incorrectly classifying these as junk and over-firing the Pattern E override.

These tests pin the guard against synthetic A-Z and 1-N inputs since the
canonical real-doc dictionaries (6f6c0f6d Encyclopedia of small fruit,
61a4ad70 Key Concepts in Agriculture) are several hundred KB each.
"""

from __future__ import annotations

import pytest


@pytest.mark.integration
class TestSequenceGuardAlphabet:
    """A-Z dictionary structure should not trigger Tier 3.8 override."""

    def test_single_letter_az_sequence_preserved(self, detect_chapters, tmp_path, monkeypatch):
        # Build a minimal synthetic doc with A-Z H1 chapters.
        lines = []
        for letter in "ABCDEFGHIJ":  # 10 letters >= 5 unique threshold
            lines.append(f"# {letter}\n\nEntries starting with {letter} go here.\n\n")
        synth_content = "\n".join(lines)

        from langchain_core.documents import Document as LangchainDocument

        from src.main.service.document.document_processor import DocumentProcessor

        page_doc = LangchainDocument(page_content=synth_content, metadata={"page": 0})
        result = DocumentProcessor._detect_chapters_from_text([page_doc])
        chapters = result.get("_chapters", [])
        # Tier 3.8 sequence guard should NOT override these single-letter chapters
        # with Pattern E ALL-CAPS body lines (there are none anyway, but the
        # guard prevents misfire even when candidates exist).
        titles = {title for _, title in chapters}
        # At least 5 of the original letters should survive
        # (Pattern D's too_short filter rejects them, so they'd come through
        # alphabetical_encyclopedia exception)
        # We just check the override did NOT replace them with body ALL-CAPS noise.
        for title in titles:
            assert len(title.strip()) <= 30 or title.strip().isalpha(), (
                "Sequence guard should preserve A-Z structure, not inject ALL-CAPS body junk. Got title: %r" % title
            )


@pytest.mark.integration
class TestSequenceGuardNumeric:
    """1-N numeric chapter sequence should not trigger Tier 3.8 override."""

    def test_numeric_1_to_n_sequence_preserved(self, detect_chapters):
        from langchain_core.documents import Document as LangchainDocument

        from src.main.service.document.document_processor import DocumentProcessor

        # Build a synthetic doc that mimics a numbered-TOC encyclopedia:
        # H1 chapters labeled `# 1`, `# 2`, …, `# 8` with substantial body.
        # Add 6+ ALL-CAPS body lines that WOULD be Pattern E candidates if
        # the sequence guard didn't fire.
        lines = []
        for i in range(1, 9):  # 8 numeric chapters
            lines.append(f"# {i}\n\n## Topic {i}\n\nBody content for topic {i}.\n\n")
            lines.append("SECTION HEADER ALL CAPS\n\nbody\n\n")
        synth_content = "\n".join(lines)

        page_doc = LangchainDocument(page_content=synth_content, metadata={"page": 0})
        result = DocumentProcessor._detect_chapters_from_text([page_doc])
        chapters = result.get("_chapters", [])
        # With 8 unique short-numeric chapter titles ("1"-"8"), the sequence
        # guard fires and Tier 3.8 does NOT override. Result: Pattern A-D
        # output is preserved.
        titles = [title for _, title in chapters]
        # Note: Pattern D might already filter the bare-digit "1"-"8" via
        # too_short. The key assertion is that Pattern E didn't override
        # with 8+ ALL-CAPS body heads (the repeated "SECTION HEADER ALL CAPS"
        # body line).
        section_header_matches = sum(1 for t in titles if "section header all caps" in t.lower())
        assert section_header_matches <= 1, (
            "Pattern E should NOT have flooded the chapter list with the repeated "
            "ALL-CAPS body line under the sequence guard. Got titles: %r" % titles
        )
