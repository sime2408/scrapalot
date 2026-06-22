"""High-level Q&A generation orchestration.

Takes a book's chapters, walks them through Claude (whole-book mode when the
content fits, per-chapter mode otherwise), and returns a ``GenerationResult``.
Per-chapter checkpointing to the state DB is handled here so the surrounding
pipeline stays free of Claude implementation details.
"""

from __future__ import annotations

import json
import re

from scripts.dataset_generator.core.config import DatasetGeneratorConfig, load_qa_prompt
from scripts.dataset_generator.core.models import ChapterData, GenerationResult, QAPair
from scripts.dataset_generator.generate.claude import (
    ClaudeTimeoutError,
    call_claude_headless,
    estimate_tokens,
    split_text_for_claude,
)
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Title cleaning
# ---------------------------------------------------------------------------


_LEADING_YEAR_RE = re.compile(r"^[\(\[]\d{4}[\)\]]\s*")


def _clean_title_for_prompt(book_title: str) -> str:
    """Derive a clean topic title from a filename-based title for use in prompts.

    Strips common filename conventions so Claude focuses on the content, not metadata:
      * Leading year: ``"(1987) Author - Title"`` → ``"Title"``
      * Author prefix: ``"Author - Title"``       → ``"Title"``
    """
    title = _LEADING_YEAR_RE.sub("", book_title.strip())
    if " - " in title:
        title = title.rsplit(" - ", 1)[-1].strip()
    return title or book_title


# ---------------------------------------------------------------------------
# Result parsing
# ---------------------------------------------------------------------------


def _parse_generation_result(raw: dict, min_quality: float) -> GenerationResult:
    """Parse raw Claude output into a GenerationResult, filtering by quality score."""
    raw_pairs = raw.get("qa_pairs", [])
    pairs: list[QAPair] = []
    filtered_low_quality = 0

    for item in raw_pairs:
        try:
            score = float(item.get("quality_score", 0))
            if score < min_quality:
                filtered_low_quality += 1
                continue
            pairs.append(
                QAPair(
                    question=item["question"],
                    answer=item["answer"],
                    thinking=item.get("thinking"),
                    topics=item.get("topics", []),
                    quality_score=score,
                )
            )
        except (KeyError, ValueError, TypeError) as exc:
            logger.debug("Skipping malformed Q&A pair: %s", exc)
            continue

    if raw_pairs and not pairs:
        logger.warning(
            "All %d Q&A pairs were filtered out (min_quality=%.1f, low_quality_count=%d)",
            len(raw_pairs),
            min_quality,
            filtered_low_quality,
        )
    elif not raw_pairs:
        skipped = raw.get("skipped_chapters", [])
        summary = raw.get("book_summary", "") or ""
        if skipped:
            logger.debug("Claude returned empty qa_pairs — skipped chapters: %s", skipped)
        else:
            preview = (summary[:80] + "...") if len(summary) > 80 else summary or "(none)"
            logger.debug(
                "Claude returned empty qa_pairs list (no skipped_chapters reason given). book_summary: %s",
                preview,
            )

    return GenerationResult(
        qa_pairs=pairs,
        book_summary=raw.get("book_summary"),
        skipped_chapters=raw.get("skipped_chapters", []),
    )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def generate_qa_for_book(
    book_title: str,
    chapters: list[ChapterData],
    config: DatasetGeneratorConfig,
    state=None,
    book_file_path: str | None = None,
) -> GenerationResult:
    """Generate Q&A pairs for an entire book.

    If the book fits within ``config.max_book_tokens``, all chapters are sent
    in a single Claude call (whole-book mode). Otherwise each chapter is
    processed independently with per-chapter checkpointing.

    Args:
        book_title: Title of the book.
        chapters: Chapter texts assembled by ``extract.chapters``.
        config: Pipeline configuration.
        state: Optional StateManager for per-chapter checkpointing.
        book_file_path: Book file path key used with ``state`` for chapter lookup.
    """
    total_text = "\n\n".join(ch.text for ch in chapters)
    total_tokens = estimate_tokens(total_text)
    prompt_template = load_qa_prompt()
    prompt_title = _clean_title_for_prompt(book_title)

    if total_tokens <= config.max_book_tokens:
        return _generate_whole_book(
            prompt_template=prompt_template,
            prompt_title=prompt_title,
            chapters=chapters,
            total_text=total_text,
            total_tokens=total_tokens,
            config=config,
            book_title=book_title,
        )

    return _generate_per_chapter(
        prompt_template=prompt_template,
        prompt_title=prompt_title,
        chapters=chapters,
        total_tokens=total_tokens,
        config=config,
        book_title=book_title,
        state=state,
        book_file_path=book_file_path,
    )


# ---------------------------------------------------------------------------
# Whole-book mode
# ---------------------------------------------------------------------------


def _generate_whole_book(
    *,
    prompt_template: str,
    prompt_title: str,
    chapters: list[ChapterData],
    total_text: str,
    total_tokens: int,
    config: DatasetGeneratorConfig,
    book_title: str,
) -> GenerationResult:
    """Send the entire book to Claude in one call."""
    logger.info("Processing '%s' in whole-book mode (%d estimated tokens)", book_title, total_tokens)

    chapters_info = "Chapters: " + ", ".join(f"{ch.number}. {ch.title}" for ch in chapters)
    # Scale target pairs by chapter count, but also ensure a minimum based on
    # token density (1 pair per ~600 tokens) so short-chapter books aren't under-sampled.
    chapter_based = config.target_pairs_per_chapter * len(chapters)
    token_based = max(10, total_tokens // 600)
    target_pairs = max(chapter_based, token_based)

    prompt = prompt_template.format(
        book_title=prompt_title,
        chapter_info=chapters_info,
        topic_focus=config.topic_focus,
        target_pairs=target_pairs,
        text=total_text,
    )

    raw = call_claude_headless(prompt)
    if not raw:
        logger.warning("Failed to generate Q&A for '%s' (whole-book mode)", book_title)
        return GenerationResult()

    result = _parse_generation_result(raw, config.min_quality_score)
    # Tag pairs with "All chapters" since we can't attribute them to specific ones.
    for pair in result.qa_pairs:
        pair.source_chapter = "All chapters"
    logger.info("Generated %d Q&A pairs for '%s'", len(result.qa_pairs), book_title)
    return result


# ---------------------------------------------------------------------------
# Per-chapter mode (with checkpointing)
# ---------------------------------------------------------------------------


def _generate_per_chapter(
    *,
    prompt_template: str,
    prompt_title: str,
    chapters: list[ChapterData],
    total_tokens: int,
    config: DatasetGeneratorConfig,
    book_title: str,
    state,
    book_file_path: str | None,
) -> GenerationResult:
    """Process each chapter independently, resuming from any saved checkpoints."""
    logger.info(
        "Processing '%s' per-chapter (%d chapters, %d estimated tokens)",
        book_title,
        len(chapters),
        total_tokens,
    )

    completed: dict[int, list[dict]] = {}
    if state and book_file_path:
        completed = state.get_completed_chapter_pairs(book_file_path)
        if completed:
            logger.info(
                "Resuming '%s': %d/%d chapters already completed",
                book_title,
                len(completed),
                len(chapters),
            )

    all_pairs: list[QAPair] = []
    skipped: list[str] = []
    book_summary: str | None = None

    for ch in chapters:
        if ch.number in completed:
            restored = [QAPair(**item) for item in completed[ch.number]]
            for pair in restored:
                pair.source_chapter = ch.title
            all_pairs.extend(restored)
            logger.debug(
                "Chapter %d '%s': restored %d pairs from checkpoint",
                ch.number,
                ch.title,
                len(restored),
            )
            continue

        if state and book_file_path:
            state.mark_chapter_started(book_file_path, ch.number, ch.title)

        chapter_pairs, chapter_skipped, chapter_summary = _process_chapter(
            chapter=ch,
            prompt_template=prompt_template,
            prompt_title=prompt_title,
            config=config,
            book_title=book_title,
        )

        if not chapter_pairs and not chapter_skipped:
            skipped.append(ch.title)
            continue

        all_pairs.extend(chapter_pairs)
        skipped.extend(chapter_skipped)
        if chapter_summary and not book_summary:
            book_summary = chapter_summary

        if state and book_file_path:
            pairs_json = json.dumps([p.model_dump() for p in chapter_pairs], ensure_ascii=False)
            state.save_chapter_result(book_file_path, ch.number, ch.title, pairs_json)

    logger.info("Generated %d Q&A pairs for '%s'", len(all_pairs), book_title)
    return GenerationResult(qa_pairs=all_pairs, book_summary=book_summary, skipped_chapters=skipped)


def _process_chapter(
    *,
    chapter: ChapterData,
    prompt_template: str,
    prompt_title: str,
    config: DatasetGeneratorConfig,
    book_title: str,
) -> tuple[list[QAPair], list[str], str | None]:
    """Run one chapter through Claude, handling sub-chunk splitting and timeouts.

    Returns ``(pairs, skipped_chapter_titles, chapter_summary)``. If a chunk
    times out or fails, the remaining sub-chunks are abandoned and any
    already-collected pairs are still returned.
    """
    text_chunks = split_text_for_claude(chapter.text)
    n_chunks = len(text_chunks)
    if n_chunks > 1:
        logger.info(
            "Chapter '%s' split into %d sub-chunks (%d estimated tokens)",
            chapter.title,
            n_chunks,
            estimate_tokens(chapter.text),
        )

    pairs: list[QAPair] = []
    skipped: list[str] = []
    summary: str | None = None

    for chunk_idx, chunk_text in enumerate(text_chunks):
        chunk_label = f"{chapter.title} (part {chunk_idx + 1}/{n_chunks})" if n_chunks > 1 else chapter.title
        # Scale pairs by token density: ~1 pair per 500 tokens (≈1 page), min 2.
        chunk_tokens = estimate_tokens(chunk_text)
        chunk_target = max(2, min(config.target_pairs_per_chapter, chunk_tokens // 500))

        prompt = prompt_template.format(
            book_title=prompt_title,
            chapter_info=f"Chapter {chapter.number}: {chunk_label}",
            topic_focus=config.topic_focus,
            target_pairs=chunk_target,
            text=chunk_text,
        )

        try:
            raw = call_claude_headless(prompt)
        except ClaudeTimeoutError:
            logger.warning(
                "Timed out on '%s' in '%s' — skipping remaining sub-chunks",
                chunk_label,
                book_title,
            )
            break

        if not raw:
            logger.warning("Failed to generate Q&A for '%s' in '%s'", chunk_label, book_title)
            break

        result = _parse_generation_result(raw, config.min_quality_score)
        for pair in result.qa_pairs:
            pair.source_chapter = chapter.title
        pairs.extend(result.qa_pairs)
        skipped.extend(result.skipped_chapters)
        if result.book_summary and not summary:
            summary = result.book_summary

    return pairs, skipped, summary
