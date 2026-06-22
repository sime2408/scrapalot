"""
Plain-text formatting helpers (no external dependencies).

Title-case that respects English typography, word-boundary truncation,
HTML tag stripping, and a deterministic conversation-summary fallback
used when LLM-based summarisation is unavailable.
"""

from __future__ import annotations

import re

# Roman numerals that should stay uppercase when applying title case
_ROMAN_NUMERAL_RE = re.compile(r"^[IVXLCDM]+$", re.IGNORECASE)

# Function words rendered lowercase in proper title case
# (except when they sit at first or last position).
_TITLE_LOWERCASE_WORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "as",
        "at",
        "but",
        "by",
        "for",
        "from",
        "in",
        "into",
        "is",
        "no",
        "nor",
        "not",
        "of",
        "on",
        "or",
        "the",
        "to",
        "vs",
        "with",
    }
)

# HTML / JATS tag pattern shared by ``strip_html_tags`` and ``strip_html_tags_str``.
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")


def normalize_whitespace(text: str) -> str:
    """Collapse any run of whitespace to a single space and strip the ends.

    Equivalent to ``re.sub(r"\\s+", " ", text).strip()`` — the idiom that
    was duplicated across the document, chunking, and connector layers.
    """
    return _WHITESPACE_RE.sub(" ", text).strip()


def _fix_apostrophe_case(word: str) -> str:
    """Lowercase the character that follows an apostrophe.

    Python's ``.title()`` capitalises after every word boundary, so
    ``beekeeper's`` becomes ``Beekeeper'S``. Real titles want ``Beekeeper's``.
    """
    if "'" not in word and "’" not in word:
        return word
    return re.sub(r"([’']\s*)([A-Z])", lambda m: m.group(1) + m.group(2).lower(), word)


def smart_title_case(text: str) -> str:
    """Title-case ``text`` with English-style typography.

    - Roman numerals (``II``, ``III``, ``IV``, ...) stay uppercase.
    - Period-bearing abbreviations (``B.C.``, ``U.S.A.``) are preserved as-is.
    - Common function words (``a``, ``the``, ``of``, ``and``, ``with``, ...)
      are rendered lowercase except at first or last position.
    - Apostrophe-s and similar contractions stay lowercase after the
      apostrophe (``Beekeeper's``, not ``Beekeeper'S``).
    """
    if not text:
        return text

    titled = text.title()
    original_words = text.split()
    titled_words = titled.split()
    n = len(titled_words)

    result: list[str] = []
    for idx, (orig, tw) in enumerate(zip(original_words, titled_words, strict=False)):
        stripped = orig.strip(".,;:!?\"'()-")
        if _ROMAN_NUMERAL_RE.match(stripped) and len(stripped) >= 2:
            result.append(tw.replace(tw.strip(".,;:!?\"'()-"), stripped.upper()))
            continue
        if "." in stripped:
            result.append(orig)
            continue

        word = _fix_apostrophe_case(tw)
        if 0 < idx < n - 1 and word.lower() in _TITLE_LOWERCASE_WORDS:
            word = word.lower()
        result.append(word)

    return " ".join(result)


def truncate_at_word_boundary(text: str, max_chars: int) -> str:
    """Shrink ``text`` to at most ``max_chars`` without cutting a word or token.

    A naive ``text[:N]`` slice splits on BPE sub-word tokens, producing
    previews like "…alchemical and che" (the word "chemistry" sliced at its
    BPE prefix). This helper prefers a sentence terminator inside the
    window, falls back to the last whitespace, and only cuts hard when the
    window has no spaces at all. A trailing ellipsis is appended whenever
    truncation actually occurs.
    """
    if not text or max_chars <= 0:
        return ""
    if len(text) <= max_chars:
        return text

    window = text[:max_chars]
    last_sentence = max(window.rfind(". "), window.rfind("! "), window.rfind("? "))
    if last_sentence >= max_chars * 0.5:
        return window[: last_sentence + 1].rstrip() + " …"

    last_space = window.rfind(" ")
    if last_space >= max_chars * 0.5:
        return window[:last_space].rstrip() + " …"

    return window.rstrip() + "…"


def strip_html_tags(text: str | None) -> str | None:
    """Strip HTML/JATS tags from ``text`` and collapse whitespace.

    Returns ``None`` when the input was ``None`` or empty after stripping.
    Use ``strip_html_tags_str`` when a guaranteed ``str`` return type is
    needed.
    """
    if not text:
        return None
    no_tags = _HTML_TAG_RE.sub(" ", text)
    collapsed = _WHITESPACE_RE.sub(" ", no_tags).strip()
    return collapsed or None


def strip_html_tags_str(text: str | None) -> str:
    """``strip_html_tags`` variant that always returns a ``str`` (empty on no input)."""
    if not text:
        return ""
    no_tags = _HTML_TAG_RE.sub(" ", text)
    return _WHITESPACE_RE.sub(" ", no_tags).strip()


def truncate_conversation_summary(
    conversation_text: str,
    max_lines: int = 6,
    max_chars: int = 500,
) -> str:
    """Truncate conversation text via simple heuristics.

    A lightweight fallback for conversation summary when LLM-based
    summarisation is unavailable: keep the first ``max_lines`` lines, then
    hard-cap the result at ``max_chars`` characters (adding ``...`` when a
    cut occurs).
    """
    lines = conversation_text.split("\n")
    summary_lines = lines[:max_lines] if len(lines) > max_lines else lines
    summary = "\n".join(summary_lines)
    if len(summary) > max_chars:
        summary = summary[:max_chars] + "..."
    return summary
