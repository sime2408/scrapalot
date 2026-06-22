"""Split book markdown into chapters for Q&A dataset generation."""

from __future__ import annotations

from functools import lru_cache
import re
from typing import Any

from scripts.dataset_generator.core.config import DatasetGeneratorConfig
from scripts.dataset_generator.core.models import ChapterData
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Roman numeral → integer mapping for chapter number parsing (I .. XXV).
_ROMAN_TO_INT = {
    "i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5,
    "vi": 6, "vii": 7, "viii": 8, "ix": 9, "x": 10,
    "xi": 11, "xii": 12, "xiii": 13, "xiv": 14, "xv": 15,
    "xvi": 16, "xvii": 17, "xviii": 18, "xix": 19, "xx": 20,
    "xxi": 21, "xxii": 22, "xxiii": 23, "xxiv": 24, "xxv": 25,
}  # fmt: skip


@lru_cache(maxsize=8)
def _compile_skip_regex(patterns: tuple[str, ...]) -> re.Pattern:
    """Build and cache a compiled regex from a tuple of skip patterns.

    Keying by ``tuple`` (hashable, value-based) instead of ``id(list)``
    ensures the cache is correct even when the caller passes a fresh list
    of identical patterns each call.
    """
    return re.compile("|".join(re.escape(p) for p in patterns), re.IGNORECASE)


def _get_skip_regex(patterns: list[str]) -> re.Pattern:
    """Return the compiled skip-regex for ``patterns`` (cached by value)."""
    return _compile_skip_regex(tuple(patterns))


def _preprocess_markdown_for_chapters(markdown: str) -> str:
    """
    Normalize markdown chapter headings before chunking.

    Some PDFs produce a structure where the chapter number and chapter title appear
    on separate heading lines at different levels, e.g.:

        ## **Chapter 1**       ← chapter number at H2
        # **INTRODUCTION**     ← chapter title at H1 (clears H2 in MarkdownHeaderTextSplitter!)

    When MarkdownHeaderTextSplitter processes this, the H1 header supersedes H2 and
    clears the chapter-number metadata, so every chunk ends up in "Chapter 1".

    This function normalizes to a single heading line:

        ## Chapter 1: INTRODUCTION

    Transformations applied:
    1. Strip bold/italic markers from heading lines (## **Title** → ## Title)
    2. Merge a bare "## Chapter N" heading with the immediately following heading title
    """
    # Step 1: Strip bold and italic markers from heading lines only.
    # Handles: ## **Bold** and ## *Italic* and ## ***Both***
    text = re.sub(
        r"^(#{1,6}[ \t]*)\*{1,3}([^*\n]+?)\*{1,3}[ \t]*$",
        r"\1\2",
        markdown,
        flags=re.MULTILINE,
    )

    # Step 2: Merge split-level chapter headings.
    # Match a heading that is ONLY "Chapter N" (no title after the number),
    # followed within 1-2 lines by another heading that serves as the title.
    #
    # Before:
    #   ## Chapter 1
    #   # INTRODUCTION
    #
    # After:
    #   ## Chapter 1: INTRODUCTION
    def _merge(m: re.Match) -> str:
        hashes = m.group(1)  # e.g. "##"
        number = m.group(2)  # e.g. "Chapter 1"
        title = m.group(4).strip()  # e.g. "INTRODUCTION"
        # Strip any residual bold/italic markers from the merged title
        # noinspection PyTypeChecker
        title = re.sub(r"\*{1,3}([^*\n]+?)\*{1,3}", r"\1", title).strip()
        if not title:
            return m.group(0)
        return f"{hashes} {number}: {title}"

    text = re.sub(
        r"^(#{1,3})[ \t]+(Chapter[ \t]+\d+)[ \t]*\n(?:[ \t]*\n)?(#{1,6})[ \t]+([^\n]+)$",
        _merge,
        text,
        flags=re.MULTILINE,
    )

    return text


def _parse_chapter_num(num_str: str) -> int | None:
    """Convert an arabic, roman, or spelled-out chapter number string to int."""
    s = num_str.strip().lower()
    if s.isdigit():
        return int(s)
    if s in _ROMAN_TO_INT:
        return _ROMAN_TO_INT[s]
    return None


def _split_chapters_by_regex(
    markdown: str,
    config: DatasetGeneratorConfig,
) -> list[ChapterData]:
    """
    Fallback: split markdown directly by chapter heading patterns using regex.

    Used when the chunking strategy fails to detect multiple chapters (e.g. returns
    everything as Chapter 1).  Handles patterns such as:

        ## Chapter 1: Title         (number + optional title, same line)
        # Chapter I                 (H1 with roman numeral)
        ### CHAPTER THREE           (any level, spelled-out number)
        ## I. Laying Plans          (roman numeral dot title)

    Returns a list of ChapterData sorted by chapter number, or an empty list if
    fewer than 2 chapters are found (so the caller can fall back further).
    """
    spelled = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty"
    # Pattern: heading line that starts a new chapter
    chapter_re = re.compile(
        r"^(#{1,4})[ \t]+"  # heading hashes
        r"(?:"
        r"Chapter[ \t]+([IVXLC]+|\d+|" + spelled + r")"  # "Chapter N"
        r"|([IVXLC]{1,5})\.[ \t]+"  # "IV. Title"
        r")"
        r"[:\s]*([^\n]*)",  # optional ": Title" or " Title"
        re.IGNORECASE | re.MULTILINE,
    )

    skip_re = _get_skip_regex(config.skip_patterns)

    # Find all chapter boundary positions
    matches = list(chapter_re.finditer(markdown))
    if len(matches) < 2:
        return []

    chapters: list[ChapterData] = []
    for idx, m in enumerate(matches):
        # Determine chapter number
        num_str = m.group(2) or m.group(3) or ""
        chapter_num = _parse_chapter_num(num_str)
        if chapter_num is None:
            chapter_num = idx + 1

        # Build title
        raw_title = (m.group(4) or "").strip().strip(":")
        if raw_title:
            chapter_title = raw_title
        elif m.group(3):
            chapter_title = "{}. {}".format(m.group(3).upper(), (m.group(4) or "").strip())
        else:
            chapter_title = "Chapter %d" % chapter_num

        # Skip front/back matter
        if skip_re.search(chapter_title.lower()):
            logger.debug("Skipping chapter by pattern: %s", chapter_title)
            continue

        # Extract text from this match to the next
        start = m.start()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(markdown)
        chapter_text = markdown[start:end].strip()

        if len(chapter_text) < config.min_chapter_chars:
            logger.debug("Skipping short chapter (%d chars): %s", len(chapter_text), chapter_title)
            continue

        chapters.append(
            ChapterData(
                number=chapter_num,
                title=chapter_title,
                text=chapter_text,
                chunk_count=1,
            )
        )

    logger.info("Regex-based chapter split found %d chapters", len(chapters))
    return chapters


def chunk_and_assemble_chapters(
    markdown: str,
    config: DatasetGeneratorConfig,
) -> tuple[list[ChapterData], dict[str, Any]]:
    """
    Split book markdown into chapter-level text blocks for Q&A generation.

    Uses regex-only splitting — fast and safe for the dataset generator's needs.
    EnhancedMarkdownChunkingStrategy is intentionally excluded: its C-backed regex
    patterns cause catastrophic backtracking on dense OCR text (200+ page books),
    hanging the process indefinitely with no reliable timeout mechanism.

    Strategy:
    1. Preprocess Markdown to normalize split-level chapter headings.
    2. Regex chapter split (_split_chapters_by_regex).
    3. If <2 chapters found, treat the whole book as a single chapter.

    Args:
        markdown: Full book Markdown text
        config: Configuration with skip_patterns, min_chapter_chars

    Returns:
        Tuple of (list of ChapterData, empty hierarchy dict)
    """
    if not markdown or not markdown.strip():
        return [], {}

    preprocessed = _preprocess_markdown_for_chapters(markdown)

    chapters = _split_chapters_by_regex(preprocessed, config)
    if chapters:
        logger.info("Chapter split found %d chapters", len(chapters))
        return chapters, {}

    # Whole-book fallback: no chapter markers detected — treat as one chapter
    text = preprocessed.strip()
    if len(text) >= config.min_chapter_chars:
        logger.info("No chapters detected — treating whole book as one chapter (%d chars)", len(text))
        return [ChapterData(number=1, title="Chapter 1", text=text, chunk_count=1)], {}

    logger.warning("Book text too short (%d chars < %d min) — skipping", len(text), config.min_chapter_chars)
    return [], {}
