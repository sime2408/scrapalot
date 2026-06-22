"""CLI argument parsing for the dataset generator."""

import argparse


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Book Knowledge Dataset Generator - Extract Q&A pairs from non-fiction books using Claude Code headless mode.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic usage
  python scripts/dataset_generator.py --input "E:\\_KNIGE" --output "./datasets/knowledge_qa.jsonl"

  # Dry run (scan files, estimate size, no Claude calls)
  python scripts/dataset_generator.py --input "E:\\_KNIGE" --dry-run

  # Process a subset
  python scripts/dataset_generator.py --input "E:\\_KNIGE" --output "./datasets/qa.jsonl" --batch-size 100

  # With OCR enabled (for scanned PDFs)
  python scripts/dataset_generator.py --input "E:\\_KNIGE" --output "./datasets/qa.jsonl" --ocr

  # Resume interrupted run
  python scripts/dataset_generator.py --input "E:\\_KNIGE" --output "./datasets/qa.jsonl" --resume

  # Verbose with custom target
  python scripts/dataset_generator.py --input "E:\\_KNIGE" --output "./datasets/qa.jsonl" \\
    --target-pairs-per-chapter 15 --min-quality-score 3.5 --skip-dedup --verbose
""",
    )

    parser.add_argument(
        "--input",
        required=True,
        help="Root directory containing book files (PDF/EPUB)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output JSONL file path (required unless --dry-run)",
    )
    parser.add_argument(
        "--state-db",
        default=None,
        help="SQLite state file path (default: {output_dir}/state.db)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Scan and estimate only, no Claude calls",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        default=True,
        help="Resume from last state (default: true)",
    )
    parser.add_argument(
        "--no-resume",
        action="store_true",
        default=False,
        help="Do not resume; reprocess all books",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=0,
        help="Process at most N books then stop (0 = all)",
    )
    parser.add_argument(
        "--ocr",
        action="store_true",
        default=False,
        help="Enable Docling OCR for scanned PDFs",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=None,
        help="Chunk size for EnhancedMarkdownChunkingStrategy (default: from config.yaml)",
    )
    parser.add_argument(
        "--target-pairs-per-chapter",
        type=int,
        default=None,
        help="Target Q&A pairs per chapter (default: from config.yaml)",
    )
    parser.add_argument(
        "--min-quality-score",
        type=float,
        default=None,
        help="Minimum self-scored quality 1-5 (default: from config.yaml)",
    )
    parser.add_argument(
        "--max-book-tokens",
        type=int,
        default=None,
        help="Max tokens for whole-book mode (default: from config.yaml)",
    )
    parser.add_argument(
        "--skip-dedup",
        action="store_true",
        default=False,
        help="Skip TF-IDF deduplication step",
    )
    parser.add_argument(
        "--skip-qa",
        action="store_true",
        default=False,
        help=(
            "Ingest-only mode: extract + chunk + DB/REST upload, then mark the book "
            "completed WITHOUT generating Q&A pairs (no Claude calls). Much faster "
            "when the goal is RAG ingestion, not dataset generation."
        ),
    )
    parser.add_argument(
        "--file-types",
        default="pdf,epub",
        help="Comma-separated file extensions to process (default: pdf,epub)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="Number of parallel worker processes (default: 1). Use with --gpu-ids for multi-GPU.",
    )
    parser.add_argument(
        "--gpu-ids",
        default=None,
        help="Comma-separated GPU device IDs to assign to workers (e.g. '0,1'). Worker 0 gets GPU 0, worker 1 gets GPU 1, etc.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        default=False,
        help="Enable debug logging",
    )

    # --- Scrapalot API upload (optional) ---
    parser.add_argument(
        "--upload-api",
        action="store_true",
        default=False,
        help="Upload extracted markdown to the Scrapalot REST API after text extraction",
    )
    parser.add_argument(
        "--api-base",
        default="https://api.scrapalot.app/api/v1",
        help="Scrapalot API base URL (default: https://api.scrapalot.app/api/v1)",
    )
    parser.add_argument(
        "--api-username",
        default=None,
        help="Scrapalot API username (required when --upload-api is set)",
    )
    parser.add_argument(
        "--api-password",
        default=None,
        help="Scrapalot API password (required when --upload-api is set)",
    )
    parser.add_argument(
        "--api-workspace",
        default="Books",
        help="Scrapalot workspace name to upload into (default: Books)",
    )

    # --- Direct database write (bypasses REST API, uses SSH tunnel) ---
    parser.add_argument(
        "--upload-db",
        action="store_true",
        default=False,
        help=(
            "Write extracted markdown + embeddings directly to PostgreSQL "
            "(bypasses REST API; faster and uses local GPU for embedding). "
            "Requires SSH tunnel: ssh -L 15432:localhost:5432 hetzner-scrapalot"
        ),
    )
    parser.add_argument(
        "--db-host",
        default="localhost",
        help="PostgreSQL host for direct DB writes (default: localhost)",
    )
    parser.add_argument(
        "--db-port",
        type=int,
        default=15432,
        help="PostgreSQL port for direct DB writes (default: 15432 = SSH tunnel)",
    )
    parser.add_argument(
        "--db-user",
        default="scrapalot",
        help="PostgreSQL username (default: scrapalot)",
    )
    parser.add_argument(
        "--db-password",
        default=None,
        help="PostgreSQL password (required when --upload-db is set; or set SCRAPALOT_DB_PASSWORD env var)",
    )
    parser.add_argument(
        "--db-kotlin",
        default="scrapalot_backend",
        help="Kotlin database name for workspace/collection data (default: scrapalot_backend)",
    )
    parser.add_argument(
        "--db-python",
        default="scrapalot",
        help="Python database name for documents and embeddings (default: scrapalot)",
    )
    parser.add_argument(
        "--db-workspace",
        default=None,
        help="Workspace name in the database (defaults to --api-workspace value)",
    )
    parser.add_argument(
        "--cover-ssh-host",
        default=None,
        help=(
            "SSH host alias (e.g. 'hetzner-scrapalot') to push generated cover "
            "thumbnails to the remote prod container's upload volume. When unset, "
            "no covers are pushed. Requires --upload-db."
        ),
    )

    args = parser.parse_args()

    # Handle --no-resume flag
    if args.no_resume:
        args.resume = False

    # Validate: --output is required unless --dry-run
    if not args.dry_run and not args.output:
        parser.error("--output is required when not using --dry-run")

    # Validate: --upload-api requires credentials
    if args.upload_api and not args.api_username:
        parser.error("--api-username is required when --upload-api is set")
    if args.upload_api and not args.api_password:
        parser.error("--api-password is required when --upload-api is set")

    # Validate: --upload-db requires password (env var fallback)
    if args.upload_db:
        if not args.db_password:
            import os

            args.db_password = os.environ.get("SCRAPALOT_DB_PASSWORD")
        if not args.db_password:
            parser.error("--db-password (or SCRAPALOT_DB_PASSWORD env var) is required when --upload-db is set")

    return args
