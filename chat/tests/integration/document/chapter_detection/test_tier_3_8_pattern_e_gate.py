"""
Tier 3.8 Pattern E gate relaxation — regression tests.

Tier 3.8 (commit ccfbb5f) extends Pattern E override to fire on two
additional signals beyond the original `len(chapters) <= 2`:

  - `dominant_garbage`: >50% of Pattern A-D chapters look like junk
    (figure captions, code fences, <3 alpha chars).
  - `has_garbage AND weak_coverage`: any garbage chapter AND all
    Pattern A-D chapter lines clustered in first 25% of doc.

These tests pin the canonical fixtures (ca53083a Sumerian Bulletin,
60074d20 Emergence of Agriculture) so a refactor that drops either
signal will fail the suite.
"""

from __future__ import annotations

import pytest


@pytest.mark.integration
class TestTier38WeakCoverage:
    """ca53083a Sumerian Agriculture Bulletin — weak_coverage path."""

    def test_pattern_e_override_fires_on_weak_coverage(self, detect_chapters):
        chapters = detect_chapters("ca53083a_sumerian_bulletin_excerpt.md")
        assert len(chapters) >= 5, (
            "Pattern E should override Pattern A-D '5' degenerate chapter with ≥5 ALL-CAPS body heads (weak_coverage gate). Got: %r" % chapters
        )

    def test_garbage_chapter_5_replaced(self, detect_chapters):
        chapters = detect_chapters("ca53083a_sumerian_bulletin_excerpt.md")
        titles = {title for _, title in chapters}
        # The stray `# 5` H1 should NOT appear as a real chapter title
        # after Tier 3.8 override.
        assert "5" not in titles, "Degenerate chapter '5' should be replaced by Tier 3.8 override. Found titles: %r" % titles

    def test_real_section_heads_detected(self, detect_chapters):
        chapters = detect_chapters("ca53083a_sumerian_bulletin_excerpt.md")
        titles = {title.lower() for _, title in chapters}
        # At least 2 of the canonical ALL-CAPS body markers should be detected
        expected_any = {
            "sieving of seed grain",
            "pulses and oil crop plants",
            "pulses recorded from ancient iraq",
            "a note on the vegetation on the uruk vase",
            "summary and conclusions",
        }
        found = expected_any & titles
        assert len(found) >= 2, f"Expected at least 2 canonical ALL-CAPS body markers, found {found!r} in {titles!r}"


@pytest.mark.integration
class TestTier38DominantGarbage:
    """60074d20 Emergence of Agriculture — dominant_garbage path."""

    def test_pattern_e_override_fires_on_dominant_garbage(self, detect_chapters):
        chapters = detect_chapters("60074d20_emergence_agriculture_excerpt.md")
        assert len(chapters) >= 5, (
            "Pattern E should override Pattern A-D junk (Page captions + bib refs) "
            "with ≥5 ALL-CAPS body heads (dominant_garbage gate). Got: %r" % chapters
        )

    def test_figure_captions_dropped(self, detect_chapters):
        chapters = detect_chapters("60074d20_emergence_agriculture_excerpt.md")
        titles = [title for _, title in chapters]
        # No chapter title should START with "Page N:" pattern (figure caption)
        for title in titles:
            assert not title.lower().startswith("page "), "Figure caption '%s' should not survive Tier 3.8 override" % title

    def test_no_bibliography_refs_as_chapters(self, detect_chapters):
        chapters = detect_chapters("60074d20_emergence_agriculture_excerpt.md")
        titles = [title for _, title in chapters]
        # Bibliography refs ("Bar-Yosef, Offer", "Crawford, Gary") should not
        # appear as chapter titles after override.
        for title in titles:
            assert not (title.startswith("Bar-Yosef") or title.startswith("Crawford")), (
                "Bibliography ref '%s' should not survive Tier 3.8 override" % title
            )
