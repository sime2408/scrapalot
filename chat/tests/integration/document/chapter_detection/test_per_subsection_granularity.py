"""
Per-subsection granularity — known-trade-off documentation.

d3f61aaf (John Deere Century) is a coffee-table book with structure:
    # **1**
    ## **The Early Years**
    ## **1903 Hand-pulled Plow**
    ## **1908 Steam Tractor**
    # **2**
    ## **The Refinement Era**
    ...

The split-marker H2 fallback (commit c50ee99) treats every `## **SubTitle**`
as its own chapter when the parent `# N` H1 is degenerate. For this doc
that produces ~91 fine-grained chapters instead of the 10 the user might
expect from `# **1**` … `# **10**`.

This is a deliberate trade-off: granular chapters improve RAG retrieval
(informative chapter_title per entry) at the cost of breaking the user's
mental model. Marked under Rule 11.4 hold-back (single-book signal) —
revisit when 3+ coffee-table docs hit the same pattern.

This test PINS the current behavior so a future refactor doesn't silently
change granularity. If the trade-off is revisited, update the assertion
range here.
"""

from __future__ import annotations

import pytest


@pytest.mark.integration
class TestPerSubsectionGranularity:
    def test_d3f61aaf_subsections_become_chapters(self, detect_chapters):
        chapters = detect_chapters("d3f61aaf_john_deere_excerpt.md")
        # Pattern D should pick up multiple `## **SubTitle**` H2 headings
        # (and reject the bare-numeric `# **N**` H1 via too_short).
        # We expect at least 3 chapter titles from the fixture.
        assert len(chapters) >= 3, "Coffee-table per-subsection granularity should produce ≥3 chapters. Got: %r" % chapters

    def test_d3f61aaf_real_subsection_titles_detected(self, detect_chapters):
        chapters = detect_chapters("d3f61aaf_john_deere_excerpt.md")
        titles = [title.lower() for _, title in chapters]
        # At least one canonical sub-section title should be present
        expected_substrings = {
            "the early years",
            "the refinement era",
            "model gp-o",
            "silver motor",
            "steam tractor",
            "models a and b",
        }
        found = [exp for exp in expected_substrings if any(exp in t for t in titles)]
        assert len(found) >= 1, f"Expected at least 1 sub-section title in d3f61aaf chapters. Found {found!r} in titles {titles!r}"

    def test_d3f61aaf_bare_numeric_h1_filtered(self, detect_chapters):
        chapters = detect_chapters("d3f61aaf_john_deere_excerpt.md")
        titles = [title.strip() for _, title in chapters]
        # Bare "1", "2", "3" etc. should be filtered by Pattern D too_short
        bare_digits = [t for t in titles if t.isdigit()]
        assert not bare_digits, "Bare digit chapter titles %r should be filtered" % bare_digits
