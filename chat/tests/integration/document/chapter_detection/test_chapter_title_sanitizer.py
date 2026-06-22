"""
Defensive chapter-title sanitizer regression tests.

Upstream Tier 3 / 3.5 / 3.6 / 3.7 / 3.8 / Pattern A-E paths each have their
own `re.sub(r"[*_]+", "", ...)` strip. Across multi-run bold (`**the** **essentials**`),
malformed link tails (`Joy of Gardening](file.htm)`, no opening `[`), and
nested formatting, these per-Tier strips miss enough cases that polluted
titles propagate into pgvector chunk metadata and into document_hierarchy.

The boundary sanitizer at `document_processor._sanitize_chapter_title` is
applied in `_assign_cross_page_chapter_metadata` AFTER the chapter list is
read so every Tier benefits without per-Tier patching.

Canonical incidents (mass Cat-F sample-audit 2026-05-15):
- b0e44f64 (Sampling techniques for forest inventories): 266/304 chunks
  had `**` in chapter_title because H4 source was
  `#### **Sampling finite populations: the** **essentials**` (two bold
  runs spanning one title).
- 1987453b (Garden of Inspiration): chapter_title=
  `Joy of Gardening](Brie_9781578265558_epub_c01_r1.htm)` —
  splitter captured a markdown link's close bracket + URL.
"""

from __future__ import annotations

import pytest

from src.main.service.document.document_processor import _sanitize_chapter_title


@pytest.mark.integration
class TestChapterTitleSanitizer:
    """Sanitizer must strip orphan bold/italic/link remnants without losing real text."""

    def test_trailing_orphan_bold_stripped(self):
        assert _sanitize_chapter_title("Introduction and terminology**") == "Introduction and terminology"
        assert _sanitize_chapter_title("Geostatistics**") == "Geostatistics"

    def test_split_bold_runs_collapse_to_single_title(self):
        # H4 source with two `**...**` runs spanning a single title.
        # b0e44f64 canonical: `#### **Sampling finite populations: the** **essentials**`
        assert _sanitize_chapter_title("Sampling finite populations: the** **essentials**") == "Sampling finite populations: the essentials"
        assert _sanitize_chapter_title("Forest Inventory: two-phase sampling** **schemes**") == "Forest Inventory: two-phase sampling schemes"

    def test_malformed_link_tail_stripped(self):
        # Splitter captured link description but left the close-bracket + URL.
        # 1987453b canonical: `Joy of Gardening](Brie_9781578265558_epub_c01_r1.htm)`
        assert _sanitize_chapter_title("Joy of Gardening](Brie_9781578265558_epub_c01_r1.htm)") == "Joy of Gardening"

    def test_well_formed_link_keeps_description_drops_url(self):
        # Standard markdown link: `[text](url)` — keep `text`, drop `](url)`.
        # Note: opening `[` survives in our defensive regex (we only strip
        # the close-bracket-onwards). Acceptable trade-off: avoiding aggressive
        # `[` stripping prevents loss of legitimate bracketed text like
        # `[Notes]` section headers.
        assert _sanitize_chapter_title("Title [link](http://x.com) more") == "Title [link more"

    def test_plain_title_unchanged(self):
        assert _sanitize_chapter_title("The Cosmopolitan Fruit") == "The Cosmopolitan Fruit"
        assert _sanitize_chapter_title("Conclusion") == "Conclusion"

    def test_body_prose_fragment_passes_through(self):
        # Pattern E body-text-as-title leaks are out of scope for sanitizer —
        # the body-prose forward-reference guard in `_detect_chapters_in_chunks`
        # is the right path. Sanitizer must not mangle the body fragment.
        body = "In contrast, Figure 4.2 presents a systematic random sample (i.e."
        assert _sanitize_chapter_title(body) == body

    def test_empty_and_single_char_preserved(self):
        assert _sanitize_chapter_title("") == ""
        # Single-char titles (e.g. encyclopedia "A", "B" sections) should
        # survive — caller's `_valid_title` gate handles rejection separately.
        assert _sanitize_chapter_title("a") == "a"

    def test_multi_whitespace_collapses(self):
        assert _sanitize_chapter_title("Multiple   spaces") == "Multiple spaces"
        # Whitespace introduced by `**` strip also collapses:
        assert _sanitize_chapter_title("Bold  **Title**  After") == "Bold Title After"

    def test_underscore_only_stripped_at_word_boundary(self):
        # `_italic_` markers go, but underscore inside identifiers (filenames,
        # snake_case slugs) must survive.
        assert _sanitize_chapter_title("_italic_") == "italic"
        # Filename-fragment underscore inside word survives:
        assert _sanitize_chapter_title("epub_c01_r1") == "epub_c01_r1"

    def test_pattern_d_polluted_titles_from_corpus(self):
        # Direct from `_detect_chapters_from_text` output on b0e44f64 doc.
        cases = [
            ("Introduction and terminology**", "Introduction and terminology"),
            ("Sampling finite populations: the** **essentials**", "Sampling finite populations: the essentials"),
            ("Sampling finite populations: advanced** **topics**", "Sampling finite populations: advanced topics"),
            ("Forest Inventory: one-phase sampling** **schemes**", "Forest Inventory: one-phase sampling schemes"),
            ("Forest Inventory: two-phase sampling** **schemes**", "Forest Inventory: two-phase sampling schemes"),
            ("Forest Inventory: advanced topics**", "Forest Inventory: advanced topics"),
            ("Geostatistics**", "Geostatistics"),
            ("Case Study**", "Case Study"),
            ("Optimal sampling schemes for forest** **inventory**", "Optimal sampling schemes for forest inventory"),
            ("The Swiss National Forest Inventory**", "The Swiss National Forest Inventory"),
            ("Estimating change and growth**", "Estimating change and growth"),
            ("Transect-Sampling**", "Transect-Sampling"),
        ]
        for raw, expected in cases:
            assert _sanitize_chapter_title(raw) == expected, f"Mismatch on {raw!r}"


@pytest.mark.integration
class TestSanitizerWiringIntoAssignCrossPageChapterMetadata:
    """Pin that the sanitizer is actually called from the boundary."""

    def test_sanitizer_present_in_source(self):
        import inspect

        from src.main.service.document.document_processor import DocumentProcessor

        src = inspect.getsource(DocumentProcessor._assign_cross_page_chapter_metadata)
        assert "_sanitize_chapter_title" in src, "Sanitizer call missing from _assign_cross_page_chapter_metadata"
