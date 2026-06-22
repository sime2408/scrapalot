"""
OCR-spaced title repair — regression tests.

Some EPUBs bake decorative CSS-style letter-spacing into heading text
itself, producing markup like `<h2>~F ARMACIST D ESK R EFERENCE</h2>`
(Don Tolman's Farmacist Desk Reference, e763b43d, 2026-05-14 audit).
Without a repair gate the chunker propagates the garbled string into
`chapter_title` chunk metadata, polluting RAG retrieval and document
hierarchy display.

The repair function `_repair_ocr_spaced_title` in
`chunking_enhanced_markdown.py` fires on two signals:
  - density >= 3 lone-letter-before-CAPS occurrences in the heading, OR
  - heading starts with `~` (visual decoration marker)

Verified against 8245 distinct chapter_title strings in pgvector cmetadata
(2026-05-14 corpus probe): 0 false positives, 2 true repairs (both Farmacist
Desk Reference Volume 3 H2 markers).

These tests pin the repair against:
  - True positives (Farmacist book H2 markers, generic `~`-prefixed OCR)
  - False positive rejection (contractions, possessives, Spanish/Portuguese
    conjunctions, Roman numerals, chemistry notation, product/code names)
  - Clean heading preservation (no-op on titles that don't trigger the gate)
"""

from __future__ import annotations

import pytest


@pytest.mark.integration
class TestOcrSpacedRepairTruePositives:
    """Headings that match the gate must be repaired and title-cased."""

    def test_farmacist_tilde_prefix_repaired(self):
        from src.main.service.rag.chunking.chunking_enhanced_markdown import _repair_ocr_spaced_title

        result = _repair_ocr_spaced_title("~F ARMACIST D ESK R EFERENCE ~ V OLUME #3")
        assert result == "~Farmacist Desk Reference ~ Volume #3", f"Got: {result!r}"

    def test_simply_human_tilde_prefix_repaired(self):
        from src.main.service.rag.chunking.chunking_enhanced_markdown import _repair_ocr_spaced_title

        result = _repair_ocr_spaced_title("~S IMPLY H UMAN ~ A B REAKTHROUGH TO H EALTH")
        assert result == "~Simply Human ~ a Breakthrough to Health", f"Got: {result!r}"

    def test_density_three_no_tilde_repaired(self):
        from src.main.service.rag.chunking.chunking_enhanced_markdown import _repair_ocr_spaced_title

        # Synthetic case: 3 lone-letter-before-CAPS occurrences should fire
        # the gate even without the `~` prefix
        result = _repair_ocr_spaced_title("S OIL P REPARATION G UIDE")
        assert result == "Soil Preparation Guide", f"Got: {result!r}"


@pytest.mark.integration
class TestOcrSpacedRepairFalsePositives:
    """Headings that look like one-off OCR but are real titles must NOT be repaired."""

    def test_contraction_with_apostrophe_skipped(self):
        from src.main.service.rag.chunking.chunking_enhanced_markdown import _repair_ocr_spaced_title

        # `'T USE` would be density 1 but the negative lookbehind on `'`
        # rejects the lone letter
        for title in ["DON'T USE", "DON'T USE"]:
            assert _repair_ocr_spaced_title(title) == title, f"Should not repair: {title!r}"

    def test_possessive_s_skipped(self):
        from src.main.service.rag.chunking.chunking_enhanced_markdown import _repair_ocr_spaced_title

        for title in ["NATION'S PRESENCE", "NATION'S PRESENCE", "AMERICA'S REUNION ON THE MALL"]:
            assert _repair_ocr_spaced_title(title) == title, f"Should not repair: {title!r}"

    def test_spanish_y_conjunction_skipped(self):
        from src.main.service.rag.chunking.chunking_enhanced_markdown import _repair_ocr_spaced_title

        # Spanish "Y" (and) followed by capitalized word produces 1-2 matches
        # but gate requires >= 3 OR `~`-prefix
        title = "Distribucion Y Ubicacion Actuales De Los Pueblos Tzeltales Y Tzotziles"
        assert _repair_ocr_spaced_title(title) == title

    def test_roman_numeral_part_letter_skipped(self):
        from src.main.service.rag.chunking.chunking_enhanced_markdown import _repair_ocr_spaced_title

        # `Part V Social Theory` looks like OCR-spaced but V is a Roman numeral
        for title in ["Part V Social Theory And Southwestern Communities", "V Conclusion", "X Retreat from Utopia"]:
            assert _repair_ocr_spaced_title(title) == title, f"Should not repair: {title!r}"

    def test_product_code_skipped(self):
        from src.main.service.rag.chunking.chunking_enhanced_markdown import _repair_ocr_spaced_title

        title = "THE MODEL C EXPERIMENTAL, GP, AND SPECIALS 39"
        assert _repair_ocr_spaced_title(title) == title

    def test_chemistry_notation_skipped(self):
        from src.main.service.rag.chunking.chunking_enhanced_markdown import _repair_ocr_spaced_title

        for title in ["Protein and the C:N Ratio", "Solid-State 13 C Nuclear Magnetic Resonance Characterisation"]:
            assert _repair_ocr_spaced_title(title) == title, f"Should not repair: {title!r}"

    def test_vocative_o_skipped(self):
        from src.main.service.rag.chunking.chunking_enhanced_markdown import _repair_ocr_spaced_title

        assert _repair_ocr_spaced_title("O JERUSALEM!") == "O JERUSALEM!"


@pytest.mark.integration
class TestOcrSpacedRepairCleanTitles:
    """Headings that don't match the gate must be returned UNCHANGED (no title-casing)."""

    def test_simple_clean_title_unchanged(self):
        from src.main.service.rag.chunking.chunking_enhanced_markdown import _repair_ocr_spaced_title

        for title in [
            "Plants Speak Sign Language",
            "Chapter 5: Soil and Plant Nutrition",
            "Introduction",
            "Farmacist Desk Reference Volume III",
            "An Introduction to Organic Farming",
        ]:
            assert _repair_ocr_spaced_title(title) == title, f"Clean title was modified: {title!r}"

    def test_empty_and_none_unchanged(self):
        from src.main.service.rag.chunking.chunking_enhanced_markdown import _repair_ocr_spaced_title

        assert _repair_ocr_spaced_title("") == ""
        assert _repair_ocr_spaced_title(None) is None
