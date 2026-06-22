"""Multi-process orchestration for parallel book processing.

Each worker:
  * pins itself to one GPU via ``CUDA_VISIBLE_DEVICES`` *before* PyTorch imports,
  * points HuggingFace at the project-local model cache (offline when warm),
  * opens its own StateManager (WAL handles cross-process write concurrency),
  * writes Q&A pairs to a per-worker temp JSONL — the main process merges them
    into the final output after every worker finishes.
"""

from __future__ import annotations

import concurrent.futures
import multiprocessing
import os
import sys
import time

from scripts.dataset_generator.core.config import DatasetGeneratorConfig
from scripts.dataset_generator.core.models import BookInfo
from scripts.dataset_generator.core.state import StateManager
from scripts.dataset_generator.output.writer import OutputWriter
from scripts.dataset_generator.runtime.book_processor import process_single_book
from scripts.dataset_generator.targets.base import UploadTarget
from scripts.dataset_generator.targets.postgres import DbWriteContext, ScrapalotDbWriter
from scripts.dataset_generator.targets.rest import ScrapalotUploader, UploadContext
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# HuggingFace environment
# ---------------------------------------------------------------------------


def configure_hf_env(project_root: str) -> None:
    """Point HuggingFace at the project-local model cache and enable offline mode when warm.

    MUST be called BEFORE any ``huggingface_hub`` / ``transformers`` imports;
    those libraries snapshot the cache path at import time.

    Setting ``HUGGINGFACE_HUB_CACHE`` directly (rather than via ``HF_HOME``)
    causes the library to store models as ``<cache_dir>/models--<org>--<name>/``
    with no intermediate ``hub/`` subdirectory.
    """
    hf_cache_dir = os.path.join(project_root, "data", "models", "huggingface")
    os.makedirs(hf_cache_dir, exist_ok=True)
    os.environ["HF_HOME"] = hf_cache_dir
    os.environ["HUGGINGFACE_HUB_CACHE"] = hf_cache_dir
    os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
    os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"

    # Enable offline mode only when at least one model repo is already cached.
    # Eliminates a per-run revision-check HTTP round-trip without blocking
    # the first-time download to the project directory.
    try:
        has_cached_models = any(entry.is_dir() and entry.name.startswith("models--") for entry in os.scandir(hf_cache_dir))
    except OSError:
        has_cached_models = False
    if has_cached_models:
        os.environ["HF_HUB_OFFLINE"] = "1"


# ---------------------------------------------------------------------------
# Target factory (REST vs PG)
# ---------------------------------------------------------------------------


def build_target(
    upload_context: UploadContext | None,
    db_write_context: DbWriteContext | None,
    *,
    gpu_id: int | None = None,
) -> UploadTarget | None:
    """Create the upload target. Direct-DB takes priority over the REST API."""
    if db_write_context is not None:
        # Embedder runs on the same device as text extraction.
        db_write_context.device = "cuda" if gpu_id is not None else "cpu"
        return ScrapalotDbWriter(db_write_context)
    if upload_context is not None:
        return ScrapalotUploader(upload_context)
    return None


# ---------------------------------------------------------------------------
# Worker entry point
# ---------------------------------------------------------------------------


def _worker_main(
    books: list[BookInfo],
    worker_output_path: str,
    state_db_path: str,
    config: DatasetGeneratorConfig,
    ocr_enabled: bool,
    skip_dedup: bool,
    skip_qa: bool,
    verbose: bool,
    gpu_id: int | None,
    project_root: str,
    upload_context: UploadContext | None = None,
    db_write_context: DbWriteContext | None = None,
) -> int:
    """Worker process: pin GPU, configure HF, process the assigned books."""
    # Pin to specific GPU BEFORE any CUDA/PyTorch initialisation.
    if gpu_id is not None:
        os.environ["CUDA_VISIBLE_DEVICES"] = str(gpu_id)

    # Configure HF cache BEFORE any HF imports so the path is picked up at
    # library initialisation time.
    configure_hf_env(project_root)

    if project_root not in sys.path:
        sys.path.insert(0, project_root)
    os.chdir(project_root)

    if sys.platform == "win32":
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")

    gpu_label = str(gpu_id) if gpu_id is not None else "auto"
    state = StateManager(state_db_path)
    writer = OutputWriter(worker_output_path)
    target = build_target(upload_context, db_write_context, gpu_id=gpu_id)

    total = 0
    try:
        for book in books:
            logger.info("[GPU %s] Processing: %s", gpu_label, book.title)
            start_time = time.time()
            written = process_single_book(
                book,
                writer,
                state,
                config,
                ocr_enabled=ocr_enabled,
                skip_dedup=skip_dedup,
                skip_qa=skip_qa,
                verbose=verbose,
                uploader=target,
            )
            elapsed = time.time() - start_time
            if written > 0:
                logger.info(
                    "[GPU %s] Completed '%s': %d pairs in %.1fs",
                    gpu_label,
                    book.title,
                    written,
                    elapsed,
                )
            total += written
    finally:
        state.close()
        if target is not None:
            target.close()

    return total


# ---------------------------------------------------------------------------
# Parallel orchestrator
# ---------------------------------------------------------------------------


def run_parallel(
    books: list[BookInfo],
    num_workers: int,
    gpu_ids: list[int] | None,
    output_path: str,
    state_db_path: str,
    config: DatasetGeneratorConfig,
    ocr_enabled: bool,
    skip_dedup: bool,
    skip_qa: bool,
    verbose: bool,
    project_root: str,
    upload_context: UploadContext | None = None,
    db_write_context: DbWriteContext | None = None,
) -> int:
    """Distribute ``books`` across ``num_workers`` worker processes.

    Books are split round-robin so workers see interleaved sizes; each worker
    writes to its own temp JSONL which we then concatenate into ``output_path``.
    """
    chunks = [c for c in (books[i::num_workers] for i in range(num_workers)) if c]
    actual_workers = len(chunks)

    gpu_assignments = [gpu_ids[i] if gpu_ids and i < len(gpu_ids) else None for i in range(actual_workers)]

    logger.info(
        "Parallel mode: %d workers, GPUs: %s, books: %s",
        actual_workers,
        gpu_assignments,
        [len(c) for c in chunks],
    )

    tmp_paths = [f"{output_path}.worker{i}.tmp" for i in range(actual_workers)]
    _recover_interrupted_temp_files(output_path, tmp_paths)

    # Spawn context so each worker starts with a fresh CUDA state.
    ctx = multiprocessing.get_context("spawn")
    with concurrent.futures.ProcessPoolExecutor(max_workers=actual_workers, mp_context=ctx) as executor:
        futures = {
            executor.submit(
                _worker_main,
                chunks[i],
                tmp_paths[i],
                state_db_path,
                config,
                ocr_enabled,
                skip_dedup,
                skip_qa,
                verbose,
                gpu_assignments[i],
                project_root,
                upload_context,
                db_write_context,
            ): i
            for i in range(actual_workers)
        }

        total = 0
        for future in concurrent.futures.as_completed(futures):
            worker_idx = futures[future]
            try:
                written = future.result()
                total += written
                logger.info("Worker %d finished: %d pairs written", worker_idx, written)
            except Exception as exc:
                logger.error("Worker %d raised an exception: %s", worker_idx, exc)

    _merge_temp_files(output_path, tmp_paths)
    return total


# ---------------------------------------------------------------------------
# Temp-file helpers
# ---------------------------------------------------------------------------


def _recover_interrupted_temp_files(output_path: str, tmp_paths: list[str]) -> None:
    """Merge any temp files left over from a previously interrupted parallel run.

    Temp files survive a kill; the state DB already marks those books as
    completed so they won't be re-processed — but without this merge their
    pairs would be missing from the output.
    """
    for tmp_path in tmp_paths:
        if os.path.exists(tmp_path):
            logger.info("Recovering interrupted parallel run — merging leftover temp file: %s", tmp_path)
            _append_file(src=tmp_path, dst=output_path)
            os.remove(tmp_path)


def _merge_temp_files(output_path: str, tmp_paths: list[str]) -> None:
    """Concatenate every worker's temp file into ``output_path``, deleting each."""
    for tmp_path in tmp_paths:
        if os.path.exists(tmp_path):
            _append_file(src=tmp_path, dst=output_path)
            os.remove(tmp_path)


def _append_file(*, src: str, dst: str) -> None:
    """Stream ``src`` line-by-line onto the end of ``dst``."""
    with open(dst, "a", encoding="utf-8") as out, open(src, encoding="utf-8") as inp:
        for line in inp:
            out.write(line)
