"""
Bold-as-headers limitation — xfail / regression documentation.

438692fd (Living at Nature's Pace) source has ZERO `#` markdown headers.
Chapter structure lives in **bold** markers (`**Living at Nature's Pace**`,
`**1991**`, `**Contents**`) plus bracketed TOC links.

The chunker normalization (`_normalize_chapter_markers`, 441 LOC) should
detect this pattern and inject `## YYYY` headers but currently doesn't
for this specific doc — single-book signal under Rule 11.4 hold-back.
Revisit when 3+ bold-as-headers EPUB-style docs hit the same limitation.

This test PINS the current limitation so a future bold-pattern detector
that lands as a real fix would CHANGE the assertion (chapter count
goes up, year markers appear). It also serves as a target spec for
that future fix.
"""

from __future__ import annotations

import pytest


@pytest.mark.integration
class TestBoldAsHeadersLimitation:
    @pytest.mark.xfail(
        reason="Bold-as-headers pattern not detected by current chunker (Rule 11.4 hold-back signal-1). "
        "Future fix: normalize **YYYY** / **TITLE** bold-only patterns to ## headers before chunking.",
        strict=False,
    )
    def test_bold_only_doc_detects_year_chapters(self, detect_chapters):
        chapters = detect_chapters("438692fd_bold_only_excerpt.md")
        titles = [title for _, title in chapters]
        # When the bold-as-headers fix lands, year markers should appear
        # as chapter titles ("1991", "1989", "1987", etc.).
        year_titles = [t for t in titles if t.strip().isdigit() and 1900 <= int(t.strip()) <= 2100]
        assert len(year_titles) >= 3, "Future bold-pattern fix should detect ≥3 year chapters. Got: %r" % titles

    def test_bold_only_doc_currently_few_chapters(self, detect_chapters):
        """Pin current behavior: very few chapters detected from bold-only source."""
        chapters = detect_chapters("438692fd_bold_only_excerpt.md")
        # Source has 0 `#` headers — chunker normalization isn't injecting
        # any from the bold pattern. Pattern A-D returns near-zero chapters.
        # Tier 3.8 might fire `<=2 chapters` path and produce some Pattern E
        # candidates, but the fixture has no ALL-CAPS body markers either.
        # Acceptable range while limitation persists: 0-3 chapters.
        assert len(chapters) <= 5, (
            "Bold-as-headers limitation: current chunker produces few chapters. "
            "Got %d chapters (expected ≤5 until fix lands): %r" % (len(chapters), chapters)
        )
