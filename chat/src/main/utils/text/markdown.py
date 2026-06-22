"""
Publisher-specific boilerplate strippers for markdown body text.

Some publishers embed legal / running-header text into every page (open-access
licence notices, ISBN / copyright running headers). pymupdf4llm extracts those
as body text and they end up inside chunks, consuming embedding space and
adding noise to vector search.

Patterns are strict (anchor on a literal phrase per publisher) so unrelated
prose can never match. Add a new compiled pattern when a new publisher's
running text shows up in chunk content.
"""

from __future__ import annotations

import re

# Each entry is a compiled regex covering one publisher's repeated text.
# Keep patterns ANCHORED on a publisher-unique substring so they cannot
# match unrelated prose. DOTALL is intentional — most footers wrap across
# lines after pymupdf4llm whitespace normalisation.
_BOILERPLATE_PATTERNS: tuple[re.Pattern[str], ...] = (
    # Oxford University Press open-access footer (~520 chars per page).
    # Verified on doc 9966bf26 (Agricultural Input Subsidies, OUP 2013).
    re.compile(
        r"This is an open access version of the publication.*?academic\.permissions@oup\.com\.?\s*",
        re.DOTALL | re.IGNORECASE,
    ),
    # OECD "AT A GLANCE" series running header (~80 chars per page).
    # Verified on doc 359ce993 (Agricultural Policies In OECD Countries
    # At A Glance, OECD 2004) — repeats 138 times across the book.
    re.compile(
        r"AGRICULTURAL POLICIES IN OECD COUNTRIES:\s*AT A GLANCE\s*[-–—]\s*ISBN\s*[\d-]+\s*[-–—]\s*©\s*OECD\s*\d{4}\s*",
        re.IGNORECASE,
    ),
)


def strip_publisher_boilerplate(text: str) -> str:
    """Strip per-page publisher running headers / open-access footers from markdown.

    Safe to call on any markdown text — patterns only match strict
    publisher-specific phrases. Returns ``text`` unchanged when no match.
    """
    if not text:
        return text
    for pat in _BOILERPLATE_PATTERNS:
        text = pat.sub("", text)
    return text
