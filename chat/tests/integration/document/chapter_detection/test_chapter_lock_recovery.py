"""
Chapter-lock recovery: post-assignment guard in `_assign_cross_page_chapter_metadata`.

When upstream chapter detection (Tier 3 / 3.5 / 3.6 / Pattern A-E) returns a list
of titles extracted from a TOC region that DON'T match the body's actual header
format, the content matcher finds the first title once and locks every
subsequent chunk on it. Symptom: one chapter_number swallows >70% of chunks.

Canonical incident (CHUNKER_CHAPTER_TITLE_LOCK_POST_PATCHES, signal=21 docs,
2026-05-16): DK Garden Plants (46e467fd) — Tier 3 extracted 9 chapter titles
from the TOC region ("Marginals and Water Plants", "Gardens in Shade", etc.),
but the body uses ALL-CAPS H5/H6 like `###### GARDENS in SHADE` and `##### PLANTS
for SPECIAL EFFECTS`. Substring matching of TOC titles in body content failed
for most chunks → 404/488 chunks (82.8%) all stamped with chapter_number=5
"Marginals and Water Plants" and section_heading="PLANTS" (the H1).

Fix (commit TBD 2026-05-16): post-assignment lock detector +
LLM Tier 0 fallback + linear redistribution by chunk_index. Gate: ≥50 chunks,
≥3 distinct nonzero chapter_numbers, top chapter swallows >70%.
"""

from __future__ import annotations

import pytest


@pytest.mark.integration
class TestLockRecoveryWired:
    """Pin the lock detection + LLM fallback into _assign_cross_page_chapter_metadata."""

    def test_lock_detector_present_in_source(self):
        import inspect

        from src.main.service.document.document_processor import DocumentProcessor

        src = inspect.getsource(DocumentProcessor._assign_cross_page_chapter_metadata)
        # Pin the lock-detection conditions
        assert "Chapter lock detected" in src, "Lock detection log message missing"
        assert "lock_pct" in src, "lock_pct variable for lock threshold missing"
        assert "_detect_chapters_via_llm" in src, "LLM Tier 0 fallback call missing"
        # Pin the 70% threshold + 50-chunk minimum + 3-chapter minimum gates
        assert "lock_pct > 0.70" in src, "70% lock threshold missing"
        assert "total_chunks >= 50" in src, "50-chunk minimum gate missing"
        assert "distinct_nonzero >= 3" in src, "3-distinct-chapter gate missing"

    def test_linear_redistribution_present(self):
        import inspect

        from src.main.service.document.document_processor import DocumentProcessor

        src = inspect.getsource(DocumentProcessor._assign_cross_page_chapter_metadata)
        assert "lock-recovery: redistributed" in src, "Lock-recovery redistribution log line missing"
        assert "chunks_per_chap" in src, "Linear redistribution variable missing"


@pytest.mark.integration
class TestLockDetectionLogic:
    """Pure-logic test of the threshold gates (no chunker invocation)."""

    @staticmethod
    def _would_trigger(ch_dist: dict[int, int]) -> bool:
        """Replicate the gate condition from the source patch."""
        total = sum(ch_dist.values())
        if total < 50:
            return False
        distinct_nonzero = sum(1 for k in ch_dist if k > 0)
        if distinct_nonzero < 3:
            return False
        from collections import Counter

        top_ch, top_count = Counter(ch_dist).most_common(1)[0]
        if top_ch <= 0:
            return False
        return (top_count / total) > 0.70

    def test_canonical_dk_garden_plants_pattern_triggers(self):
        # DK Garden Plants: 488 chunks, 5 distinct ch, ch=5 has 404 (83%)
        ch_dist = {0: 0, 3: 2, 5: 404, 7: 4, 8: 38, 9: 40}
        assert self._would_trigger(ch_dist)

    def test_healthy_distribution_doesnt_trigger(self):
        # Carleton 2021 post-fix: ~250 chunks across 16 chapters, balanced
        ch_dist = {1: 20, 2: 15, 3: 12, 4: 14, 5: 37, 6: 25, 7: 18, 8: 22, 9: 30, 10: 15, 11: 12, 12: 10, 13: 8, 14: 6, 15: 4, 16: 2}
        assert not self._would_trigger(ch_dist)

    def test_small_doc_doesnt_trigger(self):
        # Doc with <50 chunks shouldn't trigger
        ch_dist = {1: 30, 2: 2, 3: 1}
        assert not self._would_trigger(ch_dist)

    def test_two_chapters_doesnt_trigger(self):
        # Only 2 distinct chapters — could legitimately have one dominant
        ch_dist = {1: 100, 2: 50}
        assert not self._would_trigger(ch_dist)

    def test_zero_chapter_dominant_doesnt_trigger(self):
        # If ch=0 dominates, it means most chunks unlabeled — not a lock
        ch_dist = {0: 300, 1: 50, 2: 30, 3: 20}
        assert not self._would_trigger(ch_dist)

    def test_60_percent_doesnt_trigger(self):
        # Just under threshold — keep current assignment
        ch_dist = {1: 60, 2: 20, 3: 15, 4: 5}
        assert not self._would_trigger(ch_dist)

    def test_75_percent_triggers(self):
        # Above threshold
        ch_dist = {1: 75, 2: 12, 3: 8, 4: 5}
        assert self._would_trigger(ch_dist)
