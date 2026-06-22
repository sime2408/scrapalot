"""Recursive file discovery for PDF and EPUB books."""

from __future__ import annotations

import os
from pathlib import Path

from scripts.dataset_generator.core.models import BookInfo, FileType
from scripts.dataset_generator.core.state import StateManager
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_MIN_FILE_SIZE_MB = 0.01

# Mapping from file extension (without leading dot) to its FileType.
_EXT_TO_TYPE: dict[str, FileType] = {
    "pdf": FileType.PDF,
    "epub": FileType.EPUB,
}


def _humanize_title(stem: str) -> str:
    """Convert a filename stem into a human-friendly title."""
    return stem.replace("_", " ").replace("-", " ").title()


def scan_books(
    input_dir: str,
    file_types: set[str],
    state: StateManager,
    resume: bool = True,
) -> list[BookInfo]:
    """Recursively discover book files and filter by processing state.

    Args:
        input_dir: Root directory to scan.
        file_types: Set of extensions (lowercase, no dot) to include — e.g. ``{"pdf", "epub"}``.
        state: StateManager for checking previous processing state.
        resume: If True, skip already-completed books.

    Returns:
        List of BookInfo for books that need processing.
    """
    root = Path(input_dir)
    if not root.is_dir():
        raise FileNotFoundError(f"Input directory does not exist: {input_dir}")

    books: list[BookInfo] = []
    skipped_completed = 0
    skipped_too_small = 0

    for path in root.rglob("*"):
        if not path.is_file():
            continue

        ext = path.suffix.lstrip(".").lower()
        if ext not in file_types or ext not in _EXT_TO_TYPE:
            continue

        try:
            size_mb = path.stat().st_size / (1024 * 1024)
        except OSError:
            logger.warning("Cannot access file: %s", path)
            continue

        if size_mb < _MIN_FILE_SIZE_MB:
            skipped_too_small += 1
            continue

        book = BookInfo(
            file_path=str(path),
            file_type=_EXT_TO_TYPE[ext],
            file_size_mb=round(size_mb, 2),
            title=_humanize_title(path.stem),
        )
        state.register_book(book)

        if resume and state.get_book_status(book.file_path) == "completed":
            skipped_completed += 1
            continue

        books.append(book)

    # Order: files inside sub-folders FIRST (the curated thematic collections),
    # loose files directly under the root LAST. `rglob` order is otherwise
    # arbitrary; this fills the organized sub-collections before the root dump.
    root_str = str(root)
    books.sort(key=lambda b: (os.path.dirname(b.file_path) == root_str, b.file_path.lower()))

    logger.info(
        "Scanned %s: found %d books to process, %d already completed, %d too small",
        input_dir,
        len(books),
        skipped_completed,
        skipped_too_small,
    )
    return books
