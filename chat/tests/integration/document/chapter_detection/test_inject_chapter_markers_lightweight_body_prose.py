"""
CHAPTER inline injection regex must not cross paragraph boundaries.

The `inline_re` at chunking_enhanced_markdown.py:_inject_chapter_markers_lightweight
matches `CHAPTER N. Title` body text and injects `## CHAPTER N. Title` headers
for books whose splitter sees no proper headers. The previous regex used `\\s+`
between `N.` and the title — `\\s` includes `\\n`, so a body footnote like
``in Chapter 11.\nIndeed, aspects of multifunctional...`` was matched as
``CHAPTER 11. Indeed, aspects...`` and injected as a fake H2 header. With the
`skip_content_match` gate downstream, these injections override real H1
chapters, collapsing 12-chapter books to 3 distinct chapter_numbers.

Canonical incident (2026-05-16): Cardwell/Grossman/Rodgers 2003 "Agriculture
and international trade" (3618fc43) — 3 body-prose injections shadowed all
12 real H1 chapters; 366 chunks ended up with chapter_number in {1, 9, 11}.

Cumulative signal from 2026-05-15 regression scan over 105 prior parse_done
docs: 13 docs affected. Top offenders:
  - d653d4fc (Encyclopedia of Organic Gardening): 18 false-positive injections
  - 604ae877 (Ruminants): 4
  - d99842c7 (Botany for Gardeners): 3
  - 3618fc43 (current): 3
  Every drop was a body footnote — zero real chapter headings lost in scan.

Fix (commit TBD 2026-05-16): tighten regex
  `\\s+` → `[ \\t]+` between `N.` and the title (no newlines)
  `[^.\\n]` → `[^.\\n\\r]` in title char class (also exclude CR)
"""

from __future__ import annotations

import re

import pytest

# Mirror the regex exactly so tests pin the production pattern.
INLINE_RE = re.compile(
    r"(?<!\n## )(?<!\n)\bCHAPTER\s+(\d{1,2}|[IVXLC]{1,5})\.[ \t]+([A-Z][^.\n\r]{4,80})",
    re.IGNORECASE,
)


@pytest.mark.integration
class TestBodyProseFootnoteRejected:
    """The fix: body footnotes that span a paragraph boundary must NOT match."""

    def test_canonical_cardwell_2003_footnote_rejected(self):
        # 3618fc43: "...in Chapter 11.\nIndeed, aspects of multifunctional..."
        text = "as discussed in Chapter 11.\nIndeed, aspects of multifunctional agriculture"
        assert INLINE_RE.search(text) is None

    def test_other_paragraph_boundary_footnotes_rejected(self):
        # Patterns observed across the 13-doc regression scan
        cases = [
            "see Chapter 5.\nA legislative advance came with the 1992 reform",
            "discussed in Chapter 3.\nThirdly, Council Regulation 1234/2007 introduced",
            "Chapter 7.\nIndeed, multifunctional rural policy",
            "in Chapter 12.\nAccordingly, the WTO panel concluded",
        ]
        for text in cases:
            assert INLINE_RE.search(text) is None, f"Should not match: {text!r}"

    def test_cr_after_period_rejected(self):
        # Windows line endings (CR + LF) also shouldn't match
        text = "see Chapter 11.\r\nIndeed, the panel ruled"
        assert INLINE_RE.search(text) is None


@pytest.mark.integration
class TestRealChapterHeadingsStillMatch:
    """The fix must preserve detection of real inline CHAPTER headings."""

    def test_single_line_chapter_with_title_matches(self):
        # Standard inline form: `CHAPTER N. Title` all on one line
        text = "CHAPTER 5. The Common Agricultural Policy"
        m = INLINE_RE.search(text)
        assert m is not None
        assert m.group(1) == "5"
        assert m.group(2).startswith("The Common Agricultural Policy")

    def test_roman_chapter_matches(self):
        text = "CHAPTER IV. Introduction to WTO Rules"
        m = INLINE_RE.search(text)
        assert m is not None
        assert m.group(1).upper() == "IV"

    def test_tab_between_number_and_title_matches(self):
        # The `[ \t]+` permits tab (some PDF→md emitters use tabs)
        text = "CHAPTER 3.\tThe Doha Round"
        m = INLINE_RE.search(text)
        assert m is not None
        assert m.group(2).startswith("The Doha Round")

    def test_two_digit_chapter_matches(self):
        text = "CHAPTER 12. Conclusion and Future Outlook"
        m = INLINE_RE.search(text)
        assert m is not None
        assert m.group(1) == "12"

    def test_chapter_in_paragraph_preceded_by_text_still_matches(self):
        # The (?<!\n## ) + (?<!\n) negative lookbehinds reject when the
        # match starts at line start (already-prefixed). But preceded by
        # SPACE in body text is fine — that's the intended injection
        # scenario for headerless books.
        text = "Some intro prose. CHAPTER 1. Background to the Reform"
        m = INLINE_RE.search(text)
        assert m is not None
        assert m.group(1) == "1"


@pytest.mark.integration
class TestRegressionSafety:
    """Ensure the fix doesn't introduce new false negatives."""

    def test_idempotency_preserved(self):
        # Already-prefixed `## CHAPTER 5. Title` on its own LINE must NOT
        # match (idempotent injection — production text always has newlines
        # around headings, so the `(?<!\n## )` lookbehind reliably blocks
        # re-matching). The lookbehind only protects when there IS a
        # preceding newline; a bare top-of-file `## CHAPTER...` (no leading
        # newline) is not a realistic production scenario.
        text = "Some intro prose paragraph here.\n## CHAPTER 5. The Trade Reform\nFollowing prose."
        assert INLINE_RE.search(text) is None

    def test_title_with_punctuation_in_middle_still_matches(self):
        # Title can have commas, colons — but no period (would end match)
        text = "CHAPTER 4. Subsidies, Tariffs and Quotas"
        m = INLINE_RE.search(text)
        assert m is not None
        assert "Subsidies, Tariffs and Quotas" in m.group(2)


@pytest.mark.integration
class TestSourceWiringPinned:
    """Pin the live regex string in the chunker source so future refactors
    can't silently revert the fix."""

    def test_chunker_uses_tightened_regex(self):
        import inspect

        from src.main.service.rag.chunking.chunking_enhanced_markdown import EnhancedMarkdownChunkingStrategy

        src = inspect.getsource(EnhancedMarkdownChunkingStrategy)
        # Pin the specific characters that changed
        assert r"CHAPTER\s+(\d{1,2}|[IVXLC]{1,5})\.[ \t]+" in src, (
            "Tightened regex (space/tab only) missing — \\s+ would let body footnotes cross newlines and inject fake headers."
        )
        assert r"[^.\n\r]{4,80}" in src, "Title char-class must exclude \\r in addition to \\n for Windows line endings"
