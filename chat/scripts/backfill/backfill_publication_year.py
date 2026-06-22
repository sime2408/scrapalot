"""One-shot backfill of documents.publication_year from existing JSON metadata.

Reads ``extracted_metadata.resolved.year``, ``extracted_metadata.publishedDate``,
``extracted_metadata.publication_date``, ``file_metadata.year``, and
``file_metadata.publishedDate`` in that priority order. First 4-digit year in
[1500, 2100] wins. Only updates rows where ``publication_year IS NULL`` so the
script is safe to re-run.

Run inside the scrapalot-chat container so it picks up the production
database credentials::

    docker exec scrapalot-chat python scripts/backfill/backfill_publication_year.py
    docker exec scrapalot-chat python scripts/backfill/backfill_publication_year.py --dry-run

The 4-digit-year regex (``\\b(1[5-9][0-9]{2}|20[0-9]{2}|2100)\\b``) bounds
the captured value to the historical-publication range; bad metadata rows
(e.g. ISBN fragments, page counts) get filtered out instead of writing
nonsense into the new column.
"""

import argparse
import json
import re

from sqlalchemy import text

from src.main.config.database import get_db
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_YEAR_PATTERN = re.compile(r"\b(1[5-9][0-9]{2}|20[0-9]{2}|2100)\b")

_PRIORITY_PATHS: list[tuple[str, tuple[str, ...]]] = [
    # (top-level column, dotted path inside the JSON)
    ("extracted_metadata", ("resolved", "year")),
    ("extracted_metadata", ("publishedDate",)),
    ("extracted_metadata", ("publication_date",)),
    ("file_metadata", ("year",)),
    ("file_metadata", ("publishedDate",)),
]


def _extract_year(meta_blob: str | None, path: tuple[str, ...]) -> int | None:
    """Walk ``path`` inside the JSON metadata string and pick the first valid year."""
    if not meta_blob:
        return None
    try:
        data = json.loads(meta_blob) if isinstance(meta_blob, str) else meta_blob
    except (json.JSONDecodeError, TypeError):
        return None
    cursor = data
    for key in path:
        if not isinstance(cursor, dict):
            return None
        cursor = cursor.get(key)
        if cursor is None:
            return None
    if isinstance(cursor, int) and 1500 <= cursor <= 2100:
        return cursor
    match = _YEAR_PATTERN.search(str(cursor))
    if match:
        return int(match.group(1))
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Report counts without writing")
    parser.add_argument("--batch-size", type=int, default=500, help="Rows per UPDATE batch (default 500)")
    args = parser.parse_args()

    db = next(get_db())
    try:
        candidates = db.execute(
            text("SELECT id, extracted_metadata::text AS em, file_metadata::text AS fm FROM documents WHERE publication_year IS NULL")
        ).all()
        logger.info("Scanning %d documents with NULL publication_year", len(candidates))

        updates: list[tuple[str, int]] = []
        for row in candidates:
            doc_id = row.id
            for column, path in _PRIORITY_PATHS:
                meta_blob = row.em if column == "extracted_metadata" else row.fm
                year = _extract_year(meta_blob, path)
                if year is not None:
                    updates.append((str(doc_id), year))
                    break

        logger.info("Found %d documents with extractable publication_year", len(updates))
        if args.dry_run:
            for did, year in updates[:10]:
                logger.info("[dry-run] would set %s.publication_year = %d", did[:8], year)
            logger.info("[dry-run] total candidates: %d (showing first 10)", len(updates))
            return

        applied = 0
        for batch_start in range(0, len(updates), args.batch_size):
            batch = updates[batch_start : batch_start + args.batch_size]
            for did, year in batch:
                db.execute(
                    text("UPDATE documents SET publication_year = :py WHERE id = :did AND publication_year IS NULL"),
                    {"py": year, "did": did},
                )
                applied += 1
            db.commit()
            logger.info("Committed %d/%d updates", min(batch_start + args.batch_size, len(updates)), len(updates))

        logger.info("Backfill complete: %d documents updated", applied)
    finally:
        db.close()


if __name__ == "__main__":
    main()
