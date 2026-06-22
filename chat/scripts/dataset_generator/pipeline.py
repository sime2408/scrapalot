"""Main orchestration entry point for the dataset generator.

The bulk of the work lives in dedicated subpackages — this module is just
the thin glue between them:

  * ``extract.scanner`` discovers books
  * ``extract.text`` + ``extract.chapters`` turn each book into chapter text
  * ``generate.qa`` turns chapter text into Q&A pairs via Claude
  * ``output.writer`` + ``output.dedup`` persist results to JSONL
  * ``targets.{rest,postgres}`` optionally ship the markdown elsewhere
  * ``runtime.{book_processor,parallel,dry_run,topic_focus}`` host the runtime
    glue (sequential loop, multi-process orchestration, dry-run reporting,
    topic-focus prompt enrichment)

``run_pipeline`` is the only public entry; it loads config, scans books,
dispatches to the sequential or parallel runner, then prints a summary.
"""

from __future__ import annotations

import os
import time

from scripts.dataset_generator.core.config import load_config
from scripts.dataset_generator.core.state import StateManager
from scripts.dataset_generator.extract.scanner import scan_books
from scripts.dataset_generator.output.dedup import deduplicate_jsonl
from scripts.dataset_generator.output.writer import OutputWriter
from scripts.dataset_generator.runtime.book_processor import process_single_book
from scripts.dataset_generator.runtime.dry_run import run_dry_run
from scripts.dataset_generator.runtime.parallel import build_target, configure_hf_env, run_parallel
from scripts.dataset_generator.runtime.topic_focus import fetch_collection_topic_focus
from scripts.dataset_generator.targets.postgres import DbWriteContext
from scripts.dataset_generator.targets.rest import UploadContext
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def run_pipeline(
    input_dir: str,
    output_path: str | None = None,
    state_db_path: str | None = None,
    dry_run: bool = False,
    resume: bool = True,
    batch_size: int = 0,
    ocr_enabled: bool = False,
    chunk_size: int | None = None,
    target_pairs_per_chapter: int | None = None,
    min_quality_score: float | None = None,
    max_book_tokens: int | None = None,
    skip_dedup: bool = False,
    skip_qa: bool = False,
    file_types: set[str] | None = None,
    verbose: bool = False,
    workers: int = 1,
    gpu_ids: list[int] | None = None,
    upload_context: UploadContext | None = None,
    db_write_context: DbWriteContext | None = None,
) -> None:
    """Run the full dataset generation pipeline.

    Args:
        input_dir: Root directory containing book files.
        output_path: Path to the output JSONL file.
        state_db_path: Path to the SQLite state database.
        dry_run: If True, scan and estimate only (no Claude calls).
        resume: If True, skip already-completed books.
        batch_size: Process at most N books then stop (0 = all).
        ocr_enabled: Whether to enable OCR for scanned PDFs.
        chunk_size: Override config.chunk_size.
        target_pairs_per_chapter: Override config.target_pairs_per_chapter.
        min_quality_score: Override config.min_quality_score.
        max_book_tokens: Override config.max_book_tokens.
        skip_dedup: If True, skip TF-IDF deduplication.
        file_types: Extensions to process — defaults to ``{"pdf", "epub"}``.
        verbose: If True, enable debug-level traceback logging.
        workers: Number of parallel worker processes (1 = sequential).
        gpu_ids: GPU device IDs to assign to workers — e.g. ``[0, 1]``.
        upload_context: Optional REST upload destination.
        db_write_context: Optional direct-DB destination (takes precedence over REST).
    """
    config = load_config()
    for attr, value in (
        ("chunk_size", chunk_size),
        ("target_pairs_per_chapter", target_pairs_per_chapter),
        ("min_quality_score", min_quality_score),
        ("max_book_tokens", max_book_tokens),
    ):
        if value is not None:
            setattr(config, attr, value)

    if db_write_context is not None:
        collection_name = os.path.basename(input_dir.rstrip("/\\"))
        config.topic_focus = fetch_collection_topic_focus(db_write_context, collection_name)

    file_types = file_types or {"pdf", "epub"}
    state_db_path = _resolve_state_db_path(state_db_path, output_path)

    state = StateManager(state_db_path)
    try:
        logger.info("Scanning books in %s ...", input_dir)
        books = scan_books(input_dir, file_types, state, resume=resume)
        if not books:
            print("No books to process.")
            return

        if batch_size > 0:
            books = books[:batch_size]
            logger.info("Batch size limited to %d books", batch_size)

        state.update_run_stats(scanned=len(books), processed=0, qa_pairs=0)

        if dry_run:
            run_dry_run(books, config, ocr_enabled=ocr_enabled)
            return

        if not output_path:
            print("Error: --output is required when not using --dry-run")
            return

        project_root = os.path.abspath(os.getcwd())
        configure_hf_env(project_root)

        # In sequential mode, expose all requested GPUs (no per-worker pinning).
        if workers == 1 and gpu_ids:
            os.environ.setdefault("CUDA_VISIBLE_DEVICES", ",".join(str(g) for g in gpu_ids))

        if workers > 1:
            total_qa, processed = _run_parallel_mode(
                books=books,
                workers=workers,
                gpu_ids=gpu_ids,
                output_path=output_path,
                state_db_path=state_db_path,
                config=config,
                ocr_enabled=ocr_enabled,
                skip_dedup=skip_dedup,
                skip_qa=skip_qa,
                verbose=verbose,
                project_root=project_root,
                upload_context=upload_context,
                db_write_context=db_write_context,
                state=state,
            )
        else:
            total_qa, processed = _run_sequential_mode(
                books=books,
                output_path=output_path,
                config=config,
                state=state,
                ocr_enabled=ocr_enabled,
                skip_dedup=skip_dedup,
                skip_qa=skip_qa,
                verbose=verbose,
                upload_context=upload_context,
                db_write_context=db_write_context,
            )

        if not skip_dedup and processed > 1:
            print("\nRunning cross-book deduplication...")
            removed = deduplicate_jsonl(output_path, config.dedup_similarity_threshold)
            if removed:
                total_qa -= removed
                print(f"  Removed {removed} cross-book duplicates")

        _print_final_summary(state, processed=processed, total_qa=total_qa, output_path=output_path)
    finally:
        state.close()


# ---------------------------------------------------------------------------
# Mode dispatch
# ---------------------------------------------------------------------------


def _run_parallel_mode(
    *,
    books,
    workers: int,
    gpu_ids: list[int] | None,
    output_path: str,
    state_db_path: str,
    config,
    ocr_enabled: bool,
    skip_dedup: bool,
    skip_qa: bool,
    verbose: bool,
    project_root: str,
    upload_context: UploadContext | None,
    db_write_context: DbWriteContext | None,
    state: StateManager,
) -> tuple[int, int]:
    print(f"Running in parallel mode ({workers} workers, GPUs: {gpu_ids or 'auto'})")
    total_qa = run_parallel(
        books=books,
        num_workers=workers,
        gpu_ids=gpu_ids,
        output_path=output_path,
        state_db_path=state_db_path,
        config=config,
        ocr_enabled=ocr_enabled,
        skip_dedup=skip_dedup,
        skip_qa=skip_qa,
        verbose=verbose,
        project_root=project_root,
        upload_context=upload_context,
        db_write_context=db_write_context,
    )
    processed = state.get_status_counts().get("completed", 0)
    return total_qa, processed


def _run_sequential_mode(
    *,
    books,
    output_path: str,
    config,
    state: StateManager,
    ocr_enabled: bool,
    skip_dedup: bool,
    skip_qa: bool,
    verbose: bool,
    upload_context: UploadContext | None,
    db_write_context: DbWriteContext | None,
) -> tuple[int, int]:
    writer = OutputWriter(output_path)
    target = build_target(upload_context, db_write_context)

    total_qa = 0
    processed = 0
    try:
        for idx, book in enumerate(books, 1):
            start = time.time()
            logger.info("Processing book %d/%d: %s", idx, len(books), book.title)
            try:
                written = process_single_book(
                    book, writer, state, config,
                    ocr_enabled=ocr_enabled, skip_dedup=skip_dedup, skip_qa=skip_qa, verbose=verbose,
                    uploader=target,
                )  # fmt: skip
            except KeyboardInterrupt:
                logger.info("Interrupted by user. Progress saved — resume with --resume.")
                break

            if written > 0:
                elapsed = time.time() - start
                total_qa += written
                processed += 1
                state.update_run_stats(scanned=len(books), processed=processed, qa_pairs=total_qa)
                logger.info(
                    "Completed '%s': %d Q&A pairs in %.1fs",
                    book.title,
                    written,
                    elapsed,
                )
    finally:
        if target is not None:
            target.close()
    return total_qa, processed


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_state_db_path(state_db_path: str | None, output_path: str | None) -> str:
    """Resolve the state-DB path: explicit > sibling-of-output > current-dir."""
    if state_db_path is not None:
        return state_db_path
    if output_path:
        return os.path.join(os.path.dirname(output_path) or ".", "state.db")
    return "state.db"


def _print_final_summary(
    state: StateManager,
    *,
    processed: int,
    total_qa: int,
    output_path: str,
) -> None:
    """Print the final processing summary block."""
    stats = state.get_status_counts()
    print("\n" + "=" * 60)
    print("PROCESSING COMPLETE")
    print("=" * 60)
    print(f"  Books processed:   {processed}")
    print(f"  Total Q&A pairs:   {total_qa}")
    print(f"  Output file:       {output_path}")
    print(f"  Status breakdown:  {stats}")
    print("=" * 60)
