"""SQLite-based progress tracking for resumable processing."""

from datetime import UTC, datetime
import os
import sqlite3

from scripts.dataset_generator.core.models import BookInfo, BookStatus


class StateManager:
    """Manages processing state in a local SQLite database for resume support."""

    def __init__(self, db_path: str):
        self.db_path = db_path
        os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
        # timeout=30 allows multiple processes to queue writes without "database is locked"
        self._conn = sqlite3.connect(db_path, timeout=30)
        self._conn.row_factory = sqlite3.Row
        # WAL mode enables concurrent reads + serialised writes across processes
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._create_tables()
        self._migrate()

    def _create_tables(self):
        """Create the state tracking tables if they do not exist."""
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS books (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT UNIQUE NOT NULL,
                file_type TEXT NOT NULL,
                file_size_mb REAL NOT NULL,
                title TEXT DEFAULT '',
                page_count INTEGER DEFAULT 0,
                total_chapters INTEGER DEFAULT 0,
                processed_chapters INTEGER DEFAULT 0,
                qa_pairs_generated INTEGER DEFAULT 0,
                status TEXT DEFAULT 'pending',
                error_message TEXT,
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                uploaded_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS chapters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                book_file_path TEXT NOT NULL,
                chapter_number INTEGER NOT NULL,
                chapter_title TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                qa_pairs_json TEXT,
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                UNIQUE(book_file_path, chapter_number)
            );

            CREATE TABLE IF NOT EXISTS run_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                total_books_scanned INTEGER DEFAULT 0,
                total_books_processed INTEGER DEFAULT 0,
                total_qa_pairs INTEGER DEFAULT 0,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_books_status ON books(status);
            CREATE INDEX IF NOT EXISTS idx_books_file_path ON books(file_path);
            CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_file_path);
        """)
        self._conn.commit()

    def _migrate(self) -> None:
        """Apply incremental schema changes to existing state databases."""
        try:
            self._conn.execute("ALTER TABLE books ADD COLUMN uploaded_at TIMESTAMP")
            self._conn.commit()
        except Exception:
            pass  # Column already exists in databases created after the initial migration

    def mark_uploaded(self, file_path: str) -> None:
        """Record that a book's markdown was successfully uploaded to the remote API."""
        self._conn.execute(
            "UPDATE books SET uploaded_at = ? WHERE file_path = ?",
            (_now(), file_path),
        )
        self._conn.commit()

    def register_book(self, book: BookInfo) -> None:
        """Register a book in the state database (skip if already exists)."""
        self._conn.execute(
            """INSERT OR IGNORE INTO books (file_path, file_type, file_size_mb, title)
               VALUES (?, ?, ?, ?)""",
            (book.file_path, book.file_type.value, book.file_size_mb, book.title),
        )
        self._conn.commit()

    def get_pending_books(self) -> list[dict]:
        """Get all books that still need processing (pending or in_progress)."""
        cursor = self._conn.execute("SELECT * FROM books WHERE status IN ('pending', 'in_progress') ORDER BY id")
        return [dict(row) for row in cursor.fetchall()]

    def get_book_status(self, file_path: str) -> str | None:
        """Get the processing status of a specific book."""
        cursor = self._conn.execute("SELECT status FROM books WHERE file_path = ?", (file_path,))
        row = cursor.fetchone()
        return row["status"] if row else None

    def mark_in_progress(self, file_path: str) -> None:
        """Mark a book as currently being processed."""
        self._conn.execute(
            "UPDATE books SET status = ?, started_at = ? WHERE file_path = ?",
            (BookStatus.IN_PROGRESS.value, _now(), file_path),
        )
        self._conn.commit()

    def mark_completed(self, file_path: str, qa_count: int, total_chapters: int = 0, page_count: int = 0) -> None:
        """Mark a book as successfully processed."""
        self._conn.execute(
            """UPDATE books SET status = ?, qa_pairs_generated = ?, total_chapters = ?,
               page_count = ?, completed_at = ? WHERE file_path = ?""",
            (BookStatus.COMPLETED.value, qa_count, total_chapters, page_count, _now(), file_path),
        )
        self._conn.commit()

    def mark_failed(self, file_path: str, error: str) -> None:
        """Mark a book as failed with an error message."""
        self._conn.execute(
            "UPDATE books SET status = ?, error_message = ?, completed_at = ? WHERE file_path = ?",
            (BookStatus.FAILED.value, error[:2000], _now(), file_path),
        )
        self._conn.commit()

    def mark_skipped(self, file_path: str, reason: str) -> None:
        """Mark a book as skipped."""
        self._conn.execute(
            "UPDATE books SET status = ?, error_message = ?, completed_at = ? WHERE file_path = ?",
            (BookStatus.SKIPPED.value, reason[:2000], _now(), file_path),
        )
        self._conn.commit()

    def get_completed_chapter_pairs(self, book_file_path: str) -> dict:
        """
        Return completed chapter pairs for a book keyed by chapter number.

        Each value is a list of raw QAPair dicts (as stored in qa_pairs_json).
        Only chapters with status='completed' and non-empty pairs are returned.
        """
        cursor = self._conn.execute(
            """SELECT chapter_number, qa_pairs_json FROM chapters
               WHERE book_file_path = ? AND status = 'completed' AND qa_pairs_json IS NOT NULL""",
            (book_file_path,),
        )
        import json

        return {row["chapter_number"]: json.loads(row["qa_pairs_json"]) for row in cursor.fetchall()}

    def save_chapter_result(self, book_file_path: str, chapter_number: int, title: str, pairs_json: str) -> None:
        """Save Q&A pairs for a completed chapter and increment the book's processed_chapters count."""
        self._conn.execute(
            """INSERT INTO chapters (book_file_path, chapter_number, chapter_title, status, qa_pairs_json, started_at, completed_at)
               VALUES (?, ?, ?, 'completed', ?, ?, ?)
               ON CONFLICT(book_file_path, chapter_number) DO UPDATE SET
                   status = 'completed', qa_pairs_json = ?, completed_at = ?""",
            (book_file_path, chapter_number, title, pairs_json, _now(), _now(), pairs_json, _now()),
        )
        self._conn.execute(
            "UPDATE books SET processed_chapters = processed_chapters + 1 WHERE file_path = ?",
            (book_file_path,),
        )
        self._conn.commit()

    def mark_chapter_started(self, book_file_path: str, chapter_number: int, title: str) -> None:
        """Record that a chapter is being processed (for crash recovery visibility)."""
        self._conn.execute(
            """INSERT INTO chapters (book_file_path, chapter_number, chapter_title, status, started_at)
               VALUES (?, ?, ?, 'in_progress', ?)
               ON CONFLICT(book_file_path, chapter_number) DO UPDATE SET
                   status = 'in_progress', started_at = ?""",
            (book_file_path, chapter_number, title, _now(), _now()),
        )
        self._conn.commit()

    def update_run_stats(self, scanned: int, processed: int, qa_pairs: int) -> None:
        """Update or insert aggregate run statistics."""
        self._conn.execute(
            """INSERT INTO run_stats (id, total_books_scanned, total_books_processed, total_qa_pairs, last_updated)
               VALUES (1, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                   total_books_scanned = ?,
                   total_books_processed = ?,
                   total_qa_pairs = ?,
                   last_updated = ?""",
            (scanned, processed, qa_pairs, _now(), scanned, processed, qa_pairs, _now()),
        )
        self._conn.commit()

    def get_run_stats(self) -> dict:
        """Get aggregate run statistics."""
        cursor = self._conn.execute("SELECT * FROM run_stats WHERE id = 1")
        row = cursor.fetchone()
        if row:
            return dict(row)
        return {"total_books_scanned": 0, "total_books_processed": 0, "total_qa_pairs": 0}

    def get_status_counts(self) -> dict:
        """Get counts of books by status."""
        cursor = self._conn.execute("SELECT status, COUNT(*) as count FROM books GROUP BY status")
        return {row["status"]: row["count"] for row in cursor.fetchall()}

    def reset_skipped_to_pending(self) -> int:
        """Reset all skipped books to pending so they can be retried (e.g. with OCR)."""
        cursor = self._conn.execute("UPDATE books SET status = 'pending', error_message = NULL WHERE status = 'skipped'")
        self._conn.commit()
        return cursor.rowcount

    def close(self):
        """Close the database connection."""
        self._conn.close()


def _now() -> str:
    return datetime.now(UTC).isoformat()
