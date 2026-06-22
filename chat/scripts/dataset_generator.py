#!/usr/bin/env python3
"""
Book Knowledge Dataset Generator - Entry point.

Extract wisdom-focused Q&A pairs from non-fiction books (PDF/EPUB) as JSONL
using Claude Code headless mode. Run from the scrapalot-chat directory
(project root).

Examples:
    # Basic
    python scripts/dataset_generator.py --input "E:\\_KNIGE" --output "./datasets/knowledge_qa.jsonl"

    # Dry-run: scan files, estimate size, no Claude calls
    python scripts/dataset_generator.py --input "E:\\_KNIGE" --dry-run

    # Process at most 5 books then stop
    python scripts/dataset_generator.py --input "E:\\_KNIGE" --output "./datasets/qa.jsonl" --batch-size 5

    # OCR for scanned PDFs
    python scripts/dataset_generator.py --input "E:\\_KNIGE" --output "./datasets/qa.jsonl" --ocr

    # Quality knobs + skip dedup + verbose
    python scripts/dataset_generator.py --input "E:\\_KNIGE" --output "./datasets/qa.jsonl" \\
        --target-pairs-per-chapter 15 --min-quality-score 3.5 --skip-dedup --verbose

    # Multi-GPU: 2 workers, GPUs 0 and 1
    python scripts/dataset_generator.py --input "E:\\_KNIGE" --output "./datasets/qa.jsonl" \\
        --workers 2 --gpu-ids 0,1

    # Also upload extracted markdown to the Scrapalot REST API
    python scripts/dataset_generator.py --input "E:\\_KNIGE" --output "./datasets/qa.jsonl" \\
        --upload-api --api-username admin --api-password '***' --api-workspace Books

    # Write extracted markdown + embeddings straight to PostgreSQL (faster)
    # Requires:  ssh -L 15432:localhost:5432 hetzner-scrapalot
    python scripts/dataset_generator.py --input "E:\\_KNIGE" --output "./datasets/qa.jsonl" \\
        --upload-db --db-password '***'

Arguments (mirrors scripts/dataset_generator/cli.py; full help: --help):

  Core:
    --input PATH                Root directory containing book files (required)
    --output PATH               Output JSONL file path (required unless --dry-run)
    --state-db PATH             SQLite state file (default: <output_dir>/state.db)
    --dry-run                   Scan + estimate only, no Claude calls
    --resume                    Resume from last state (default: on)
    --no-resume                 Disable resume; reprocess everything
    --batch-size N              Process at most N books then stop (0 = all)

  Extraction:
    --ocr                       Enable Docling OCR for scanned PDFs
    --file-types LIST           Comma-separated extensions (default: pdf,epub)
    --chunk-size N              Markdown chunk size (default: config.yaml)

  Quality:
    --target-pairs-per-chapter N    Target Q&A pairs per chapter (default: config.yaml)
    --min-quality-score F           Minimum self-scored quality 1-5 (default: config.yaml)
    --max-book-tokens N             Max tokens for whole-book mode (default: config.yaml)
    --skip-dedup                    Skip TF-IDF deduplication step

  Parallelism:
    --workers N                 Number of parallel worker processes (default: 1)
    --gpu-ids LIST              Comma-separated GPU ids per worker, e.g. 0,1

  Logging:
    --verbose                   Enable debug logging

  Scrapalot REST upload (optional):
    --upload-api                Upload extracted markdown via REST after extraction
    --api-base URL              API base URL (default: https://api.scrapalot.app/api/v1)
    --api-username USER         API username (required with --upload-api)
    --api-password PASS         API password (required with --upload-api)
    --api-workspace NAME        Workspace to upload into (default: Books)

  Direct PostgreSQL write (optional, bypasses REST):
    --upload-db                 Write markdown + embeddings straight to PG
                                (requires SSH tunnel on --db-port)
    --db-host HOST              PG host (default: localhost)
    --db-port PORT              PG port (default: 15432 = SSH tunnel)
    --db-user USER              PG username (default: scrapalot)
    --db-password PASS          PG password (or SCRAPALOT_DB_PASSWORD env var)
    --db-kotlin NAME            Kotlin DB name (default: scrapalot_backend)
    --db-python NAME            Python DB name (default: scrapalot)
    --db-workspace NAME         Workspace name in DB (defaults to --api-workspace)
"""

import logging
import os
import sys

# Force UTF-8 for stdout/stderr on Windows (avoid cp1250 UnicodeEncodeError)
if sys.platform == "win32":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Ensure the project root is on sys.path for imports
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.abspath(os.path.join(_SCRIPT_DIR, ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

# Change working directory to project root so config loading works
os.chdir(_PROJECT_ROOT)

from scripts.dataset_generator.cli import parse_args  # noqa: E402
from scripts.dataset_generator.pipeline import run_pipeline  # noqa: E402
from scripts.dataset_generator.scrapalot_uploader import UploadContext  # noqa: E402


def main():
    args = parse_args()

    # Configure logging level
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Parse file types
    file_types = {ft.strip().lower() for ft in args.file_types.split(",")}

    # Parse GPU IDs (e.g. "0,1" -> [0, 1])
    gpu_ids = None
    if args.gpu_ids:
        gpu_ids = [int(g.strip()) for g in args.gpu_ids.split(",")]

    # Build upload context if API upload is requested
    upload_context = None
    if args.upload_api:
        upload_context = UploadContext(
            api_base=args.api_base,
            username=args.api_username,
            password=args.api_password,
            workspace_name=args.api_workspace,
            input_dir=args.input,
        )

    # Build DB write context if direct DB write is requested (takes priority over API)
    db_write_context = None
    if args.upload_db:
        from scripts.dataset_generator.scrapalot_db_writer import DbWriteContext

        db_write_context = DbWriteContext(
            db_host=args.db_host,
            db_port=args.db_port,
            db_user=args.db_user,
            db_password=args.db_password,
            kotlin_db=args.db_kotlin,
            python_db=args.db_python,
            workspace_name=args.db_workspace or args.api_workspace,
            input_dir=args.input,
            cover_ssh_host=args.cover_ssh_host,
        )

    run_pipeline(
        input_dir=args.input,
        output_path=args.output,
        state_db_path=args.state_db,
        dry_run=args.dry_run,
        resume=args.resume,
        batch_size=args.batch_size,
        ocr_enabled=args.ocr,
        chunk_size=args.chunk_size,
        target_pairs_per_chapter=args.target_pairs_per_chapter,
        min_quality_score=args.min_quality_score,
        max_book_tokens=args.max_book_tokens,
        skip_dedup=args.skip_dedup,
        skip_qa=args.skip_qa,
        file_types=file_types,
        verbose=args.verbose,
        workers=args.workers,
        gpu_ids=gpu_ids,
        upload_context=upload_context,
        db_write_context=db_write_context,
    )


if __name__ == "__main__":
    main()
