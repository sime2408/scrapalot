"""
Regression test — healthy book with clean `# Chapter N: Title` headers.

The Tier 3.8 / sequence-guard / split-marker fixes should be NO-OPS on a
healthy book whose source already has proper markdown chapter headers.
This test guards against false positives where Tier 3.8 fires incorrectly and
overrides good Pattern A-D output with Pattern E noise.
"""

from __future__ import annotations

import pytest


@pytest.mark.integration
class TestHealthyChapterRegression:
    def test_clean_chapters_all_detected(self, detect_chapters):
        chapters = detect_chapters("healthy_chapters_synthetic.md")
        # Source has 10 explicit `# Chapter N: Title` headers
        # Pattern B (single-header `# Chapter N: Title`) should match them all.
        assert len(chapters) >= 8, "Expected ≥8 of 10 healthy chapters detected, got %d: %r" % (len(chapters), chapters)

    def test_real_titles_preserved(self, detect_chapters):
        chapters = detect_chapters("healthy_chapters_synthetic.md")
        titles = [title.lower() for _, title in chapters]
        expected_substrings = {
            "introduction to agriculture",
            "crop rotation",
            "soil management",
            "plant nutrition",
            "pest management",
            "water management",
            "harvest and storage",
            "market access",
            "sustainable practices",
            "conclusion",
        }
        found = [exp for exp in expected_substrings if any(exp in t for t in titles)]
        assert len(found) >= 6, f"Expected ≥6 healthy chapter titles preserved. Found {found!r} in {titles!r}"

    def test_no_tier_3_8_misfire(self, detect_chapters):
        chapters = detect_chapters("healthy_chapters_synthetic.md")
        titles = [title for _, title in chapters]
        # Healthy book has no ALL-CAPS body lines, so Pattern E should produce
        # zero candidates. Even if Tier 3.8 gate evaluated, override would NOT
        # fire (no candidates). All chapter titles should be from Pattern A-D.
        # Verify no chapter is an ALL-CAPS body marker.
        all_caps_chapter_count = sum(1 for t in titles if len(t) > 8 and t == t.upper() and not t.startswith("Chapter"))
        assert all_caps_chapter_count == 0, "Healthy book should not have any ALL-CAPS-body-style chapter titles. Got: %r" % titles

    def test_chapter_numbers_sequential(self, detect_chapters):
        chapters = detect_chapters("healthy_chapters_synthetic.md")
        numbers = [num for num, _ in chapters]
        assert numbers == sorted(numbers), "Chapter numbers should be detected in sequence. Got: %r" % numbers
