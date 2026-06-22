"""Per-book pipeline: extract → chapters → upload → Q&A → dedup → write."""

from __future__ import annotations

from scripts.dataset_generator.core.config import DatasetGeneratorConfig
from scripts.dataset_generator.core.models import BookInfo
from scripts.dataset_generator.core.state import StateManager
from scripts.dataset_generator.extract.chapters import chunk_and_assemble_chapters
from scripts.dataset_generator.extract.text import extract_text
from scripts.dataset_generator.generate.claude import ClaudeTimeoutError
from scripts.dataset_generator.generate.qa import generate_qa_for_book
from scripts.dataset_generator.output.dedup import deduplicate_pairs
from scripts.dataset_generator.output.writer import OutputWriter
from scripts.dataset_generator.targets.base import UploadTarget
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def process_single_book(
    book: BookInfo,
    writer: OutputWriter,
    state: StateManager,
    config: DatasetGeneratorConfig,
    *,
    ocr_enabled: bool,
    skip_dedup: bool,
    skip_qa: bool = False,
    verbose: bool,
    uploader: UploadTarget | None = None,
) -> int:
    """Run the full pipeline for one book and return the number of pairs written.

    On any failure the book is marked failed/skipped in ``state`` and ``0`` is
    returned. ``KeyboardInterrupt`` is recorded then re-raised so the surrounding
    loop can break.
    """
    state.mark_in_progress(book.file_path)
    try:
        markdown, page_count = extract_text(book, ocr_enabled=ocr_enabled)
        if not markdown:
            state.mark_skipped(book.file_path, "Text extraction returned empty content")
            return 0

        chapters, _hierarchy = chunk_and_assemble_chapters(markdown, config)
        if not chapters:
            state.mark_skipped(book.file_path, "No chapters found after chunking and assembly")
            return 0

        # Upload extracted markdown *before* Q&A generation so the document
        # exists remotely even if Claude later times out on a chapter.
        uploaded = False
        if uploader is not None:
            if uploader.register_markdown(book.file_path, markdown, chapters=chapters):
                state.mark_uploaded(book.file_path)
                uploaded = True
            else:
                logger.warning("Upload failed for '%s'%s", book.title, "" if skip_qa else " — continuing with Q&A generation")

        # Ingest-only mode: document is now in the DB with chunks + embeddings;
        # skip Q&A generation (no Claude calls) and mark the book completed.
        if skip_qa:
            if uploader is not None and not uploaded:
                state.mark_failed(book.file_path, "Upload failed (skip-qa ingest-only mode)")
                return 0
            state.mark_completed(book.file_path, 0, len(chapters), page_count)
            logger.info("[skip-qa] Ingested '%s' (%d chapters, %d pages) — no Q&A", book.title, len(chapters), page_count)
            return 0

        result = generate_qa_for_book(book.title, chapters, config, state=state, book_file_path=book.file_path)
        pairs = result.qa_pairs
        if not pairs:
            state.mark_failed(book.file_path, "No Q&A pairs generated after quality filtering")
            return 0

        if not skip_dedup:
            pairs = deduplicate_pairs(pairs, config.dedup_similarity_threshold)

        written = writer.write_pairs(pairs=pairs, book_title=book.title, source_file=book.file_path)
        state.mark_completed(book.file_path, written, len(chapters), page_count)
        return written

    except ClaudeTimeoutError as e:
        logger.warning("Claude timed out processing '%s': %s", book.title, e)
        state.mark_failed(book.file_path, str(e))
        return 0
    except KeyboardInterrupt:
        state.mark_failed(book.file_path, "Interrupted by user")
        raise
    except Exception as e:
        logger.error("Failed to process '%s': %s", book.title, e, exc_info=verbose)
        state.mark_failed(book.file_path, str(e))
        return 0
