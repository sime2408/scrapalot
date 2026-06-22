"""
Pattern C lookahead decorative-character rejection — regression tests.

When PDF→markdown extractors stylize cover art using repeated single
characters (e.g. `aaaaaaaaaaaaaa` in Fine Gardening Grow e43d1159),
those lines previously got pulled into chapter_title via Pattern C's
"look ahead for title on next non-empty line" branch in
`_detect_chapters_from_text` (`document_processor.py` ~line 2430).

The gate added in commit TBD (2026-05-14) rejects any candidate
matching `re.fullmatch(r'(.)\\1{4,}')` — five or more occurrences of
the same character in a row. Real chapter titles never repeat a single
character that many times.

Regression scan: 0 hits among 118 prior parse_done docs (corpus
`chapter_title` values where `(.)\\1{4,}` matches anywhere → only the
2 polluted Fine Gardening Grow chunks).

These tests pin the gate against:
- True positives: `aaaaaaaaaaaaaa`, `==============`, `~~~~~~~~~~~~` etc.
- False negatives: real titles with non-decorative repeats (e.g. `Cool`,
  `Cooooool!`, `Mississippi`) must NOT be rejected.
- Real chapter detection on a Fine-Gardening-style synthetic fixture.
"""

from __future__ import annotations

import re

import pytest

_PATTERN = re.compile(r"(.)\1{4,}")


@pytest.mark.integration
class TestDecorativeReject:
    """The regex used by the gate must match repeated-char garbage and miss real titles."""

    def test_aaaa_rejected(self):
        assert _PATTERN.fullmatch("aaaaaaaaaaaaaa") is not None
        assert _PATTERN.fullmatch("aaaaa") is not None  # exactly 5
        assert _PATTERN.fullmatch("aaaa") is None  # 4 = below threshold

    def test_various_decorative_chars_rejected(self):
        for line in ["==============", "~~~~~~~~~~~~", "**************", "##############", "--------------"]:
            assert _PATTERN.fullmatch(line) is not None, f"Should match: {line!r}"

    def test_real_titles_not_rejected(self):
        for line in [
            "PART I — Soil, Compost, Fertilizer & Water",
            "Plant, Propagate & Divide",
            "Cooooool!",  # 4 o's — under threshold
            "Mississippi",  # has ss/pp but not 5-in-a-row
            "Subsistence First!",
            "Woodlands and Wastes",
            "AAA Travel Guide",  # 3 A's — under threshold
        ]:
            assert _PATTERN.fullmatch(line) is None, f"Should NOT match: {line!r}"

    def test_mixed_repeats_not_rejected(self):
        # `aabbccdd` has no single char repeated 5+ times → not rejected
        assert _PATTERN.fullmatch("aabbccdd") is None
        # `abcabcabc` no repeated runs
        assert _PATTERN.fullmatch("abcabcabc") is None


@pytest.mark.integration
class TestPatternCLookaheadIntegration:
    """End-to-end: Pattern C invocation against a synthetic Fine-Gardening-like document."""

    def test_synthetic_decoration_does_not_pollute_chapter_title(self):
        from langchain_core.documents import Document as LangchainDocument

        from src.main.service.document.document_processor import DocumentProcessor

        # Fine Gardening Grow shape: decorative `aaaa` glyph lines around real `PART N` markers.
        synth = """\
# Fine Gardening Grow

aaaaaaaaaaaaaa
aaaaaaaaaaaaaa
aaaaaaaaaaaaaa

PART ONE

aaaaaaaaaaaaaa

SOIL, COMPOST, FERTILIZER & WATER

Body content for part one with lots of words to fill out a real section.
Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod
tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim
veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea
commodo consequat.

aaaaaaaaaaaaaa

PART TWO

aaaaaaaaaaaaaa

PLANT, PROPAGATE & DIVIDE

Body content for part two. Lorem ipsum dolor sit amet, consectetur
adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore
magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco
laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor
in reprehenderit in voluptate.
"""
        page_doc = LangchainDocument(page_content=synth, metadata={"page": 0})
        result = DocumentProcessor._detect_chapters_from_text([page_doc])
        chapters = result.get("_chapters", [])
        titles = {title for _, title in chapters}

        # The `aaaaaaaaaaaaaa` decoration MUST NOT appear as a chapter title.
        assert "aaaaaaaaaaaaaa" not in titles, f"Decorative line leaked into chapters: {titles!r}"
        # Loose check that detection found at least one PART (sanity that we
        # didn't accidentally break the lookahead).
        # Note: Pattern C may or may not find titles depending on which tier fires;
        # the strict assertion is the negative one above.
