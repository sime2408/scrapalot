"""Dry-run mode: extract + chunk every book, then print a cost-estimate report.

No Claude calls are made; this is purely for sizing an upcoming run.
"""

from __future__ import annotations

from scripts.dataset_generator.core.config import DatasetGeneratorConfig
from scripts.dataset_generator.core.models import BookInfo, ChapterData
from scripts.dataset_generator.extract.chapters import chunk_and_assemble_chapters
from scripts.dataset_generator.extract.text import extract_text
from scripts.dataset_generator.generate.claude import estimate_tokens


def run_dry_run(
    books: list[BookInfo],
    config: DatasetGeneratorConfig,
    *,
    ocr_enabled: bool = False,
) -> None:
    """Walk every book through text extraction + chunking and print a report."""
    chapter_counts: list[int] = []
    token_counts: list[int] = []
    call_counts: list[int] = []
    failed = 0

    for idx, book in enumerate(books, 1):
        if idx % 100 == 0:
            print(f"  Scanning {idx}/{len(books)}...")

        markdown, _ = extract_text(book, ocr_enabled=ocr_enabled)
        if not markdown:
            chapter_counts.append(0)
            token_counts.append(0)
            call_counts.append(0)
            failed += 1
            continue

        chapters, _ = chunk_and_assemble_chapters(markdown, config)
        ch_count = len(chapters)
        tokens = _estimate_book_tokens(chapters)
        calls = 1 if tokens <= config.max_book_tokens else ch_count

        chapter_counts.append(ch_count)
        token_counts.append(tokens)
        call_counts.append(calls)

    if failed > 0:
        print(f"\n  ({failed} books failed text extraction)")

    _print_dry_run_report(books, chapter_counts, token_counts, call_counts)


def _estimate_book_tokens(chapters: list[ChapterData]) -> int:
    """Estimate total tokens across all chapters of a book."""
    return sum(estimate_tokens(ch.text) for ch in chapters)


def _print_dry_run_report(
    books: list[BookInfo],
    chapter_counts: list[int],
    token_counts: list[int],
    call_counts: list[int],
) -> None:
    """Print a summary report for dry-run mode."""
    total_books = len(books)
    total_chapters = sum(chapter_counts)
    total_tokens = sum(token_counts)
    total_calls = sum(call_counts)
    whole_book_count = sum(1 for c in call_counts if c == 1)
    per_chapter_count = total_books - whole_book_count
    total_size_mb = sum(b.file_size_mb for b in books)

    print("\n" + "=" * 60)
    print("DRY RUN REPORT")
    print("=" * 60)
    print(f"  Books found:            {total_books:,}")
    print(f"  Total size:             {total_size_mb:,.1f} MB")
    print(f"  Total chapters:         {total_chapters:,}")
    print(f"  Estimated tokens:       {total_tokens:,}")
    print()
    print(f"  Whole-book calls:       {whole_book_count:,} books (< max_book_tokens)")
    print(f"  Per-chapter calls:      {per_chapter_count:,} books")
    print(f"  Total Claude calls:     {total_calls:,}")
    print("=" * 60)

    if not books:
        return
    sorted_books = sorted(zip(books, token_counts), key=lambda x: x[1], reverse=True)
    print("\nTop 10 largest books by estimated tokens:")
    for i, (book, tokens) in enumerate(sorted_books[:10], 1):
        print(f"  {i:2d}. {tokens:>8,} tokens  {book.file_size_mb:6.1f} MB  {book.title[:60]}")
    print()
