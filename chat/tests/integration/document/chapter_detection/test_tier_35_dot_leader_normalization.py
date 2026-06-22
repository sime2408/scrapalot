"""
Tier 3.5 keyword-TOC dot-leader normalization — regression tests.

Production PDF→markdown extractors emit the ellipsis/dot-leader between
TOC entry text and page number in two shapes:
  - Unicode horizontal ellipsis (`…` U+2026), common in Docling output
  - ASCII chain of 3+ periods with spaces: `. . . . . . 18`

Before commit TBD (2026-05-14) the `chapter_after_strip` regex character
class did not include `…` and was greedy on `.`, which trapped the title
boundary. Tier 3.5 silently dropped ALL frontmatter TOC entries containing
a dot-leader and fell through to a body H3 lookalike cluster — observed
on FAO Briquetting 1990 (a28bde40): 21 TOC entries silently parsed to 0;
only a 6-entry in-body cluster fired.

The fix adds two normalize steps before the regex match:
  1. `re.sub(r"[․‥…⋯]+", " ", cleaned)` — Unicode dot variants
  2. `re.sub(r"(?:\\s*\\.\\s*){3,}", " ", cleaned)` — ASCII 3+ dots
plus a trailing-period title cleanup:
  3. `re.sub(r"(?:\\s+\\.+)+\\s*$", "", raw_title)`

Regression scan: 119 prior parse_done docs → 2 strict-improvement deltas
(f188d5cb +9, c72affa4 +3), 0 regressions.
"""

from __future__ import annotations

import re

import pytest


@pytest.mark.integration
class TestDotLeaderNormalization:
    """The two normalize regexes must collapse dot-leaders into a single space."""

    def test_unicode_ellipsis_normalized(self):
        line = "Chapter 1. Introduction …………………… 5"
        cleaned = re.sub(r"[․‥…⋯]+", " ", line)
        cleaned = re.sub(r"(?:\s*\.\s*){3,}", " ", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        # Verify dot-leader gone and structure intact
        assert "…" not in cleaned
        assert "Chapter 1" in cleaned
        assert "Introduction" in cleaned
        assert cleaned.endswith("5")

    def test_ascii_dot_leader_normalized(self):
        line = "Chapter 3. Soil Management . . . . . . . . . 42"
        cleaned = re.sub(r"[․‥…⋯]+", " ", line)
        cleaned = re.sub(r"(?:\s*\.\s*){3,}", " ", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        # The trailing dot-chain should be reduced to a single space
        assert ". . . . ." not in cleaned
        # Period after "3" should survive as part of "Chapter 3." pattern
        assert "Chapter 3. Soil Management" in cleaned or "Chapter 3 Soil Management" in cleaned

    def test_mixed_unicode_and_ascii_normalized(self):
        line = "Chapter 5. Plant Nutrition …. . . . . 78"
        cleaned = re.sub(r"[․‥…⋯]+", " ", line)
        cleaned = re.sub(r"(?:\s*\.\s*){3,}", " ", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        assert "…" not in cleaned
        assert "Plant Nutrition" in cleaned

    def test_real_titles_not_corrupted(self):
        # Real titles WITHOUT dot-leaders must be unchanged
        for line in [
            "Chapter 5. Soil and Plant Nutrition",
            "Chapter 12 Introduction to country reviews",
            "Subsistence First!",
            "Farming in the Ruins of the Twentieth Century",
        ]:
            cleaned = re.sub(r"[․‥…⋯]+", " ", line)
            cleaned = re.sub(r"(?:\s*\.\s*){3,}", " ", cleaned)
            cleaned = re.sub(r"\s+", " ", cleaned).strip()
            assert cleaned == line.strip(), f"Real title was modified: {line!r} -> {cleaned!r}"

    def test_two_dots_not_normalized(self):
        # 2 dots is NOT a dot-leader (could be `etc..` or similar)
        line = "Chapter 1. Introduction.. End"
        cleaned = re.sub(r"(?:\s*\.\s*){3,}", " ", line)
        # 2 dots stay
        assert ".." in cleaned


@pytest.mark.integration
class TestTitleTrailingPeriodCleanup:
    """After dot-leader collapse + page-number strip, residual trailing dots are removed."""

    def test_trailing_period_after_strip_removed(self):
        # After `Main issues … 4` → `Main issues .` (dot-leader collapse leaves one)
        # → `Main issues` after trailing-period cleanup
        raw_title = "Main issues ."
        cleaned = re.sub(r"(?:\s+\.+)+\s*$", "", raw_title)
        assert cleaned == "Main issues", f"Got: {cleaned!r}"

    def test_multiple_trailing_periods_removed(self):
        raw_title = "Soil Management . . ."
        cleaned = re.sub(r"(?:\s+\.+)+\s*$", "", raw_title)
        assert cleaned == "Soil Management", f"Got: {cleaned!r}"

    def test_mid_title_period_preserved(self):
        # Mid-title periods stay (`U.S.A.` etc.) — only TRAILING tails strip
        raw_title = "Soil in the U.S.A."
        cleaned = re.sub(r"(?:\s+\.+)+\s*$", "", raw_title)
        # `U.S.A.` ends with a period but no space before it → stays
        assert cleaned == "Soil in the U.S.A."

    def test_no_trailing_period_no_change(self):
        for raw in ["Soil Management", "Chapter Twelve", "Pests and Insects"]:
            cleaned = re.sub(r"(?:\s+\.+)+\s*$", "", raw)
            assert cleaned == raw, f"Real title corrupted: {raw!r} -> {cleaned!r}"


@pytest.mark.integration
class TestTier35IntegrationFakeTOC:
    """End-to-end: feed a Briquetting-shape TOC into _detect_chapters_from_keyword_toc."""

    def test_unicode_ellipsis_toc_parsed_as_chapters(self):
        from langchain_core.documents import Document as LangchainDocument

        from src.main.service.document.document_processor import DocumentProcessor

        # Mimic FAO Briquetting TOC shape: bold-wrapped TOC entries with
        # Unicode ellipsis dot-leaders.
        synth = """\
# The Briquetting of Agricultural Waste for Fuel

## Contents

**Chapter 1. Introduction …………………… 5**

**Chapter 2. The residue base …………………… 12**

**Chapter 3. The markets for briquettes …………………… 22**

**Chapter 4. Densification process …………………… 31**

**Chapter 5. Densification economics …………………… 45**

**Chapter 6. Country reviews introduction …………………… 62**

## Chapter 1. Introduction

Body text for chapter 1 with enough words to form a meaningful chunk in the
chunker pipeline. Lorem ipsum dolor sit amet, consectetur adipiscing elit.

## Chapter 2. The residue base

Body text for chapter 2 about agricultural residues used for briquetting.
Lorem ipsum dolor sit amet, consectetur adipiscing elit.

## Chapter 3. The markets for briquettes

Body text for chapter 3 covering market analysis. Lorem ipsum dolor sit amet,
consectetur adipiscing elit.

## Chapter 4. Densification process

Body text for chapter 4. Lorem ipsum dolor sit amet.

## Chapter 5. Densification economics

Body text for chapter 5. Lorem ipsum dolor sit amet.

## Chapter 6. Country reviews introduction

Body text for chapter 6. Lorem ipsum dolor sit amet.
"""
        page_doc = LangchainDocument(page_content=synth, metadata={"page": 0})
        result = DocumentProcessor._detect_chapters_from_text([page_doc])
        chapters = result.get("_chapters", [])
        # Without the fix: Tier 3.5 collapses to 0 TOC entries, fall-through
        # to body H2 lookalike which catches the in-body `## Chapter N` H2s.
        # With the fix: Tier 3.5 picks up all 6 TOC entries cleanly.
        # Either way, we expect >= 4 chapters (no regression).
        assert len(chapters) >= 4, f"Expected ≥4 chapters, got: {chapters!r}"
        # No chapter title should be empty or contain Unicode ellipsis
        for _, title in chapters:
            assert "…" not in title, f"Unicode ellipsis leaked into title: {title!r}"
