#!/usr/bin/env python3
"""Backfill UFO books into the production DB without re-running Q&A generation.

Reads state.db for completed/skipped books, checks which are missing from the
ufo collection in the prod DB, then re-runs text extraction + chapter assembly
+ DB write (embeddings + document_hierarchy) for each missing book.

Usage:
    python scripts/backfill/backfill_ufo.py --input E:/_KNJIGE/ufo --state-db datasets/ufo_state.db
    python scripts/backfill/backfill_ufo.py --input E:/_KNJIGE/ufo --state-db datasets/ufo_state.db --dry-run
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sqlite3
import sys

# Ensure project root on sys.path and set working directory.
# File now lives at scripts/backfill/backfill_ufo.py — go up 2 levels to project root.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.abspath(os.path.join(_SCRIPT_DIR, "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)
os.chdir(_PROJECT_ROOT)

if sys.platform == "win32":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from scripts.dataset_generator.core.config import DatasetGeneratorConfig
from scripts.dataset_generator.core.models import BookInfo, FileType
from scripts.dataset_generator.extract.chapters import chunk_and_assemble_chapters
from scripts.dataset_generator.extract.text import extract_text
from scripts.dataset_generator.targets.postgres import DbWriteContext, ScrapalotDbWriter
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

UFO_COLLECTION_ID = "804edc35-98b2-4642-a176-a7b2e6d53d66"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill UFO books into prod DB (no Q&A).")
    parser.add_argument("--input", required=True, help="Root dir with book files (E:/_KNJIGE/ufo)")
    parser.add_argument("--state-db", required=True, help="Path to ufo_state.db")
    parser.add_argument("--db-host", default="localhost")
    parser.add_argument("--db-port", type=int, default=15432)
    parser.add_argument("--db-user", default="scrapalot")
    parser.add_argument("--db-password", default=None)
    parser.add_argument("--db-kotlin", default="scrapalot_backend")
    parser.add_argument("--db-python", default="scrapalot")
    parser.add_argument("--db-workspace", default="books")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done, no writes")
    parser.add_argument("--statuses", default="completed,skipped", help="Comma-separated statuses to backfill (default: completed,skipped)")
    args = parser.parse_args()
    if not args.db_password:
        args.db_password = os.environ.get("SCRAPALOT_DB_PASSWORD")
    if not args.db_password:
        parser.error("--db-password or SCRAPALOT_DB_PASSWORD env var required")
    return args


def get_state_books(state_db_path: str, statuses: list[str]) -> list[dict]:
    """Return all books from state.db with given statuses."""
    conn = sqlite3.connect(state_db_path)
    conn.row_factory = sqlite3.Row
    placeholders = ",".join("?" * len(statuses))
    rows = conn.execute(
        f"SELECT file_path, status FROM books WHERE status IN ({placeholders}) ORDER BY file_path",
        statuses,
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_existing_filenames_in_collection(ctx: DbWriteContext) -> set[str]:
    """Fetch filenames already present in the UFO collection from Python DB."""
    import psycopg2
    import psycopg2.extras

    conn = psycopg2.connect(
        host=ctx.db_host,
        port=ctx.db_port,
        dbname=ctx.python_db,
        user=ctx.db_user,
        password=ctx.db_password,
    )
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cur.execute(
        "SELECT title FROM documents WHERE collection_id = %s",
        (UFO_COLLECTION_ID,),
    )
    # title is stored as stem (filename without extension)
    filenames = {row["title"] for row in cur.fetchall()}
    conn.close()
    logger.info("Found %d existing docs in UFO collection", len(filenames))
    return filenames


def make_book_info(file_path: str) -> BookInfo | None:
    """Construct BookInfo from a file path, returns None if file not found."""
    p = Path(file_path)
    if not p.exists():
        logger.warning("File not found, skipping: %s", file_path)
        return None
    ext = p.suffix.lower().lstrip(".")
    try:
        ft = FileType(ext)
    except ValueError:
        logger.warning("Unsupported file type '%s', skipping: %s", ext, file_path)
        return None
    return BookInfo(
        file_path=str(p),
        file_type=ft,
        file_size_mb=p.stat().st_size / 1_048_576,
        title=p.stem,
    )


def main() -> None:
    args = parse_args()
    statuses = [s.strip() for s in args.statuses.split(",")]

    ctx = DbWriteContext(
        db_host=args.db_host,
        db_port=args.db_port,
        db_user=args.db_user,
        db_password=args.db_password,
        kotlin_db=args.db_kotlin,
        python_db=args.db_python,
        workspace_name=args.db_workspace,
        input_dir=args.input,
    )
    config = DatasetGeneratorConfig()

    logger.info("Loading state DB: %s (statuses: %s)", args.state_db, statuses)
    books = get_state_books(args.state_db, statuses)
    logger.info("Found %d books in state with status in %s", len(books), statuses)

    if args.dry_run:
        logger.info("DRY RUN — no writes will be performed")

    db_writer = ScrapalotDbWriter(ctx)

    # Fetch existing filenames to avoid duplicates
    existing = get_existing_filenames_in_collection(ctx)

    missing = []
    for b in books:
        p = Path(b["file_path"])
        stem = p.stem
        if stem not in existing:
            missing.append(b)

    logger.info("%d books missing from UFO collection (out of %d total)", len(missing), len(books))

    if args.dry_run:
        for b in missing:
            logger.info("  WOULD backfill: %s", Path(b["file_path"]).name)
        return

    ok = 0
    failed = 0
    skipped = 0

    for i, b in enumerate(missing, 1):
        file_path = b["file_path"]
        name = Path(file_path).name
        logger.info("[%d/%d] Backfilling: %s", i, len(missing), name)

        book = make_book_info(file_path)
        if book is None:
            skipped += 1
            continue

        # Extract text
        markdown, _ = extract_text(book, ocr_enabled=False)
        if not markdown:
            logger.warning("  Text extraction failed, skipping")
            skipped += 1
            continue

        # Assemble chapters
        chapters, _ = chunk_and_assemble_chapters(markdown, config)
        if not chapters:
            logger.warning("  No chapters found, skipping")
            skipped += 1
            continue

        # Write to DB (embeddings + hierarchy)
        success = db_writer.register_markdown(file_path, markdown, chapters=chapters)
        if success:
            logger.info("  OK — written to DB")
            ok += 1
        else:
            logger.warning("  DB write failed")
            failed += 1

    logger.info(
        "Backfill complete: %d written, %d failed, %d skipped (file missing/unsupported)",
        ok,
        failed,
        skipped,
    )


if __name__ == "__main__":
    main()
