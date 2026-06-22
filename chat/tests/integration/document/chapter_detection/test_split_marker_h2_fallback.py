"""
Split-marker H2 fallback — regression tests.

When the source uses `# N` + `## Title` as a split chapter header
(commit c50ee99), the chunker's auto-promotion path should prefer H2
as the chapter signal when H1 has fewer than 3 alphabetic characters.

The continuation backfill (commit 8ed155c) and pre-pass H1-frequency
detection (commit 131b965) complete the fix:
  - Backfill: continuation sub-sections inherit chapter_title from the
    first sub-section of the same chapter.
  - Pre-pass: H1 values that repeat across many sections (book title)
    are flagged so H2 is preferred regardless of position.

These tests pin canonical fixtures (e56b1cd1 Cultivation for Climate
Change Vol 2, f188d5cb Latest Technologies in Agriculture) so a refactor
that breaks the H2-fallback path fails the suite.

Note: these tests assert on `_detect_chapters_from_text` output (the
regex-based chapter detector, not the chunker's auto-promotion). The
auto-promotion path lives in `chunking_enhanced_markdown.py` and is
tested via the full reprocess pipeline (Cat-F audit).
"""

from __future__ import annotations

import pytest


@pytest.mark.integration
class TestSplitMarkerH2Fallback:
    """e56b1cd1 + f188d5cb — `# N` + `## Title` split-marker pattern."""

    def test_e56b1cd1_real_titles_detected(self, detect_chapters):
        chapters = detect_chapters("e56b1cd1_climate_change_v2_excerpt.md")
        titles = [title for _, title in chapters]
        # Pattern D should find the `## Implications of Climate Change` H2
        # heading (since `# 1` is too_short and rejected).
        all_titles_text = " ".join(titles).lower()
        assert any("implications" in t.lower() for t in titles) or "implications" in all_titles_text, (
            "Expected 'Implications of Climate Change' to be detected as a chapter title. Got: %r" % titles
        )

    def test_e56b1cd1_numeric_only_titles_not_promoted(self, detect_chapters):
        chapters = detect_chapters("e56b1cd1_climate_change_v2_excerpt.md")
        titles = [title for _, title in chapters]
        # Bare digit titles "1", "2", "3" should not appear — Pattern D's
        # too_short filter rejects `# 1` (1 char < 3 alpha minimum) so
        # only the `## Title` H2 reaches the chapter list.
        bare_digits = [t for t in titles if t.strip().isdigit()]
        assert not bare_digits, "Bare digit chapter titles %r should be filtered by Pattern D too_short rule" % bare_digits

    def test_f188d5cb_real_titles_detected(self, detect_chapters):
        chapters = detect_chapters("f188d5cb_latest_tech_excerpt.md")
        titles = [title for _, title in chapters]
        # At least 3 of these canonical chapter titles should be detected
        expected_substrings = {
            "advances in plant",
            "genomics",
            "recombinant",
            "microarray",
            "sustainable agriculture",
            "disease resistant",
            "plant breeding",
        }
        found = [exp for exp in expected_substrings if any(exp in t.lower() for t in titles)]
        assert len(found) >= 3, f"Expected ≥3 split-marker chapter titles, found {found!r} in {titles!r}"

    def test_f188d5cb_numeric_only_titles_not_promoted(self, detect_chapters):
        chapters = detect_chapters("f188d5cb_latest_tech_excerpt.md")
        titles = [title for _, title in chapters]
        bare_digits = [t for t in titles if t.strip().isdigit()]
        assert not bare_digits, "Bare digit chapter titles %r should not appear in f188d5cb" % bare_digits
