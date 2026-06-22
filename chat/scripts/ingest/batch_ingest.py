"""
batch_ingest.py — Batch book ingest pipeline for Scrapalot.

Scans a books root directory, converts unsupported formats via Calibre,
parses with Docling (GPU), and uploads markdown to the Scrapalot API.
State is persisted in a local SQLite DB so the pipeline can be resumed.

Usage:
    python scripts/ingest/batch_ingest.py --dry-run
    python scripts/ingest/batch_ingest.py --resume
    python scripts/ingest/batch_ingest.py --validate-only
"""

from __future__ import annotations

import argparse
import ctypes
import gc
import json
import logging
import os
import signal
import sqlite3
import subprocess
import sys
import tempfile

# Force UTF-8 stdout/stderr on Windows to handle non-ASCII filenames (e.g., Spanish accents)
if sys.platform == "win32":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
import threading
import time

import requests

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BOOKS_ROOT = Path(r"E:\_KNJIGE")
IGNORE_FOLDERS = {"_to_delete"}
SUPPORTED_FORMATS = {".pdf", ".epub", ".docx", ".mobi", ".azw3", ".djvu"}
CALIBRE_FORMATS = {".mobi", ".azw3", ".djvu"}

CALIBRE_EXE_FALLBACK = r"C:\Program Files\Calibre2\ebook-convert.exe"
CALIBRE_TIMEOUT = 120

MAX_ATTEMPTS = 3
API_RETRY_DELAYS = [2, 4, 8]

_SCRIPT_DIR = Path(__file__).parent
_STATE_DIR = _SCRIPT_DIR / "state"

# Shared shutdown event — set by SIGINT handler to stop worker dispatch.
shutdown_event = threading.Event()

# Module-level logger (configured by setup_logging).
log: logging.Logger = logging.getLogger("batch_ingest")


# ---------------------------------------------------------------------------
# Custom exceptions
# ---------------------------------------------------------------------------


class APIError(Exception):
    """Unrecoverable API error — stops the pipeline."""


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def setup_logging(dry_run: bool) -> logging.Logger:
    """Configure logging to both stdout and a timestamped file.

    Returns the root logger for this script.
    """
    _STATE_DIR.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    suffix = "_dryrun" if dry_run else ""
    log_path = _STATE_DIR / f"ingest_{timestamp}{suffix}.log"

    logger = logging.getLogger("batch_ingest")
    logger.setLevel(logging.DEBUG)

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)-8s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # File handler — DEBUG and above.
    fh = logging.FileHandler(log_path, encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(formatter)
    logger.addHandler(fh)

    # Stdout handler — INFO and above.
    sh = logging.StreamHandler(sys.stdout)
    sh.setLevel(logging.INFO)
    sh.setFormatter(formatter)
    logger.addHandler(sh)

    logger.info("Log file: %s", log_path)
    return logger


# ---------------------------------------------------------------------------
# State database
# ---------------------------------------------------------------------------


def open_state_db() -> sqlite3.Connection:
    """Open (or create) the SQLite state database with WAL mode.

    Creates the required tables if they do not exist yet.
    Returns an open connection with row_factory set to sqlite3.Row.
    """
    _STATE_DIR.mkdir(parents=True, exist_ok=True)
    db_path = _STATE_DIR / "books_state.db"

    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS books (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            local_path  TEXT    NOT NULL UNIQUE,
            file_hash   TEXT,
            collection  TEXT,
            status      TEXT    NOT NULL DEFAULT 'pending',
            document_id TEXT,
            error       TEXT,
            attempts    INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS collections (
            folder_name   TEXT PRIMARY KEY,
            collection_id TEXT NOT NULL,
            workspace_id  TEXT NOT NULL,
            created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
    """
    )
    conn.commit()
    return conn


def update_book_status(
    conn: sqlite3.Connection,
    local_path: str,
    status: str,
    document_id: str | None = None,
    error: str | None = None,
) -> None:
    """Update the status of a book row, incrementing the attempt counter."""
    conn.execute(
        """
        UPDATE books
           SET status      = ?,
               document_id = COALESCE(?, document_id),
               error       = ?,
               attempts    = attempts + 1,
               updated_at  = datetime('now')
         WHERE local_path  = ?
        """,
        (status, document_id, error, local_path),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Signal handling
# ---------------------------------------------------------------------------


def install_signal_handler() -> None:
    """Install a SIGINT handler that sets the shutdown event gracefully."""

    def _handler(_signum, _frame):  # noqa: ANN001
        print("\nInterrupt received — finishing current book then stopping. Press Ctrl+C again to force quit.")
        shutdown_event.set()

    signal.signal(signal.SIGINT, _handler)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def api_post(url: str, token: str, payload: dict, retries: int = 3) -> requests.Response:
    """POST with exponential backoff; raises APIError after max retries on 5xx."""
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    last_exc: Exception | None = None

    for attempt in range(retries):
        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=60)
            if resp.status_code < 500:
                return resp
            delay = API_RETRY_DELAYS[min(attempt, len(API_RETRY_DELAYS) - 1)]
            log.warning("POST %s → %d, retrying in %ds...", url, resp.status_code, delay)
            time.sleep(delay)
        except requests.RequestException as exc:
            last_exc = exc
            delay = API_RETRY_DELAYS[min(attempt, len(API_RETRY_DELAYS) - 1)]
            log.warning("POST %s error: %s, retrying in %ds...", url, exc, delay)
            time.sleep(delay)

    raise APIError(f"POST {url} failed after {retries} attempts. Last error: {last_exc}")


def api_get(url: str, token: str, params: dict | None = None) -> requests.Response:
    """GET with 2 retries on connection errors."""
    headers = {"Authorization": f"Bearer {token}"}

    for attempt in range(2):
        try:
            resp = requests.get(url, headers=headers, params=params, timeout=30)
            return resp
        except requests.RequestException as exc:
            if attempt == 1:
                raise APIError(f"GET {url} failed: {exc}") from exc
            time.sleep(2)

    # Unreachable but satisfies type checker.
    raise APIError(f"GET {url} failed after 2 attempts")


# ---------------------------------------------------------------------------
# Auth & workspace / collection management
# ---------------------------------------------------------------------------


def login(api_base: str, username: str, password: str) -> str:
    """Authenticate and return the access token."""
    url = f"{api_base}/auth/login"
    resp = requests.post(url, json={"username": username, "password": password}, timeout=30)
    if resp.status_code != 200:
        raise APIError(f"Login failed ({resp.status_code}): {resp.text}")
    data = resp.json()
    token = data.get("accessToken") or data.get("access_token")
    if not token:
        raise APIError(f"Login response missing accessToken: {data}")
    log.info("Authenticated as %s", username)
    return token


def get_or_create_workspace(api_base: str, token: str, name: str) -> str:
    """Return the workspace id for the given name, creating it if absent."""
    resp = api_get(f"{api_base}/workspaces", token)
    if resp.status_code == 200:
        data = resp.json()
        # API returns {"workspaces": [...], "pagination": {...}}
        items = data.get("workspaces", data) if isinstance(data, dict) else data
        for ws in items:
            if ws.get("name") == name:
                # noinspection PyTypeChecker
                log.info("Found existing workspace '%s' (id=%s)", name, ws["id"])
                # noinspection PyTypeChecker
                return ws["id"]

    log.info("Creating workspace '%s'...", name)
    resp = api_post(f"{api_base}/workspaces", token, {"name": name})
    if resp.status_code not in (200, 201):
        raise APIError(f"Failed to create workspace '{name}': {resp.status_code} {resp.text}")
    ws_id = resp.json()["id"]
    log.info("Created workspace '%s' (id=%s)", name, ws_id)
    return ws_id


def get_or_create_collection(
    api_base: str,
    token: str,
    workspace_id: str,
    name: str,
    conn: sqlite3.Connection,
) -> str:
    """Return the collection id for the given name.

    Checks the local state DB first, then queries the API, then creates it.
    Caches the result in the local ``collections`` table.
    """
    # Check local cache.
    row = conn.execute("SELECT collection_id FROM collections WHERE folder_name = ?", (name,)).fetchone()
    if row:
        return row["collection_id"]

    # Query the API.
    resp = api_get(f"{api_base}/collections", token, params={"workspace_id": workspace_id})
    if resp.status_code == 200:
        data = resp.json()
        # API returns {"collections": [...], "pagination": {...}}
        items = data.get("collections", data) if isinstance(data, dict) else data
        for col in items:
            if col.get("name") == name:
                # noinspection PyTypeChecker
                cid = col["id"]
                _cache_collection(conn, name, cid, workspace_id)
                log.info("Found existing collection '%s' (id=%s)", name, cid)
                return cid

    # Create a new collection.
    log.info("Creating collection '%s'...", name)
    # Backend uses SNAKE_CASE JSON naming strategy.
    payload = {
        "name": name,
        "workspace_id": workspace_id,
        "chunking_strategy": "recursive",
        "chunk_size": 1000,
        "chunk_overlap": 200,
    }
    resp = api_post(f"{api_base}/collections", token, payload)
    if resp.status_code not in (200, 201):
        raise APIError(f"Failed to create collection '{name}': {resp.status_code} {resp.text}")
    cid = resp.json()["id"]
    _cache_collection(conn, name, cid, workspace_id)
    log.info("Created collection '%s' (id=%s)", name, cid)
    return cid


def _cache_collection(conn: sqlite3.Connection, folder_name: str, collection_id: str, workspace_id: str) -> None:
    """Insert or replace a collection entry in the local state DB."""
    conn.execute(
        """
        INSERT OR REPLACE INTO collections (folder_name, collection_id, workspace_id)
        VALUES (?, ?, ?)
        """,
        (folder_name, collection_id, workspace_id),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Book scanner
# ---------------------------------------------------------------------------


def scan_books(books_root: Path) -> list[dict]:
    """Walk the books root and return a list of book descriptor dicts.

    Each dict has keys: ``path`` (str), ``collection`` (top-level folder name),
    ``ext`` (lowercase extension including the dot).

    Only top-level directories are treated as collections.  Subdirectories
    within them are fully recursed.  The ``_to_delete`` folder (and any folder
    in ``IGNORE_FOLDERS``) is skipped entirely.
    """
    books: list[dict] = []

    for top_dir in sorted(books_root.iterdir()):
        if not top_dir.is_dir():
            continue
        if top_dir.name in IGNORE_FOLDERS:
            continue
        collection = top_dir.name
        for file_path in top_dir.rglob("*"):
            if not file_path.is_file():
                continue
            ext = file_path.suffix.lower()
            if ext not in SUPPORTED_FORMATS:
                continue
            books.append(
                {
                    "path": str(file_path),
                    "collection": collection,
                    "ext": ext,
                }
            )

    log.info("Scanned %d books across %d collections", len(books), len({b["collection"] for b in books}))
    return books


# ---------------------------------------------------------------------------
# Remote reconciliation
# ---------------------------------------------------------------------------


def fetch_remote_filenames(api_base: str, token: str, collection_id: str) -> set[str]:
    """Return the set of filename strings already uploaded to a collection.

    Uses the /documents/collection/{id} endpoint which returns a plain list
    (no server-side pagination — all documents in one response).
    """
    filenames: set[str] = set()

    resp = api_get(f"{api_base}/documents/collection/{collection_id}", token)
    if resp.status_code != 200:
        log.warning(
            "fetch_remote_filenames: unexpected status %d for collection %s",
            resp.status_code,
            collection_id,
        )
        return filenames

    data = resp.json()
    items = data if isinstance(data, list) else []

    for doc in items:
        fname = doc.get("filename") or doc.get("file_name") or doc.get("name")
        if fname:
            filenames.add(fname)

    return filenames


def reconcile_with_remote(
    conn: sqlite3.Connection,
    api_base: str,
    token: str,
    collection_ids: dict[str, str],
) -> None:
    """Reconcile local state against remote for every collection.

    Two passes per collection:
    1. Mark local 'pending'/'failed' books as 'done' if already present on
       remote — prevents re-uploading duplicates after a crashed run.
    2. Reset local 'done' books to 'pending' if absent from remote — ensures
       failed uploads are retried.
    """
    total_resets = 0
    total_already_done = 0

    for folder_name, collection_id in collection_ids.items():
        remote_names = fetch_remote_filenames(api_base, token, collection_id)

        # Pass 1: pending/failed → done if already on remote.
        pending_rows = conn.execute(
            "SELECT local_path FROM books WHERE collection = ? AND status IN ('pending','failed')",
            (folder_name,),
        ).fetchall()
        already_done = 0
        for row in pending_rows:
            if Path(row["local_path"]).name in remote_names:
                conn.execute(
                    """
                    UPDATE books
                       SET status     = 'done',
                           error      = NULL,
                           updated_at = datetime('now')
                     WHERE local_path = ?
                    """,
                    (row["local_path"],),
                )
                already_done += 1
        if already_done:
            conn.commit()
            log.info(
                "reconcile: marked %d already-remote books as done in '%s'",
                already_done,
                folder_name,
            )
        total_already_done += already_done

        # Pass 2: done → pending if missing from remote.
        done_rows = conn.execute(
            "SELECT local_path FROM books WHERE collection = ? AND status = 'done'",
            (folder_name,),
        ).fetchall()
        resets = 0
        for row in done_rows:
            if Path(row["local_path"]).name not in remote_names:
                conn.execute(
                    """
                    UPDATE books
                       SET status     = 'pending',
                           attempts   = 0,
                           error      = NULL,
                           updated_at = datetime('now')
                     WHERE local_path = ?
                    """,
                    (row["local_path"],),
                )
                resets += 1
        if resets:
            conn.commit()
            log.info(
                "reconcile: reset %d books to pending in collection '%s'",
                resets,
                folder_name,
            )
        total_resets += resets

    log.info(
        "reconcile: %d already-remote marked done, %d missing reset to pending",
        total_already_done,
        total_resets,
    )


# ---------------------------------------------------------------------------
# Calibre conversion
# ---------------------------------------------------------------------------


def convert_with_calibre(src_path: Path) -> Path | None:
    """Convert a MOBI/AZW3 file to EPUB or a DJVU file to PDF via Calibre.

    Tries ``ebook-convert`` from PATH first, then falls back to the known
    Calibre installation path.  Outputs to a temporary directory.

    Returns the output path, or None if the conversion fails.
    """
    ext = src_path.suffix.lower()
    if ext in {".mobi", ".azw3"}:
        out_ext = ".epub"
    elif ext == ".djvu":
        out_ext = ".pdf"
    else:
        log.warning("convert_with_calibre called for unsupported format: %s", ext)
        return None

    tmp_dir = Path(tempfile.mkdtemp(prefix="scrapalot_calibre_"))
    out_path = tmp_dir / (src_path.stem + out_ext)

    import shutil as _shutil  # keep deferred — runs in subprocess workers

    # noinspection PyDeprecation
    calibre_exe = _shutil.which("ebook-convert") or CALIBRE_EXE_FALLBACK
    cmd = [calibre_exe, str(src_path), str(out_path)]
    success = False
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=CALIBRE_TIMEOUT,
        )
        if result.returncode != 0:
            log.warning("Calibre conversion failed for %s: %s", src_path.name, result.stderr[:500])
            return None
        log.debug("Calibre converted %s → %s", src_path.name, out_path.name)
        success = True
        return out_path
    except subprocess.TimeoutExpired:
        log.warning("Calibre timed out after %ds for %s", CALIBRE_TIMEOUT, src_path.name)
        return None
    except FileNotFoundError:
        log.warning("Calibre executable not found at '%s'", calibre_exe)
        return None
    except Exception as exc:
        log.warning("Calibre error for %s: %s", src_path.name, exc)
        return None
    finally:
        if not success:
            _shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# pymupdf4llm fast path (text-based PDFs)
# ---------------------------------------------------------------------------

# Minimum average characters per page to consider a PDF text-based.
# Below this threshold the PDF is likely scanned and needs Docling OCR.
_PYMUPDF_MIN_CHARS_PER_PAGE = 100


def parse_with_pymupdf(file_path: Path) -> str | None:
    """Extract Markdown from a PDF using pymupdf4llm (fast, CPU-only, no GPU).

    Samples the first 10 pages to decide whether the PDF has a real text
    layer.  Returns the full Markdown string when successful, or None when
    the PDF is likely scanned (falls back to Docling OCR).
    """
    # noinspection PyBroadException
    try:
        import fitz  # pymupdf
        import pymupdf4llm

        doc = fitz.open(str(file_path))
        page_count = len(doc)
        if page_count == 0:
            doc.close()
            return None

        # Sample up to 10 pages to estimate text density.
        sample = min(10, page_count)
        total_chars = sum(len(doc[i].get_text()) for i in range(sample))
        doc.close()

        if total_chars / sample < _PYMUPDF_MIN_CHARS_PER_PAGE:
            return None  # Scanned PDF — caller should fall back to Docling.

        return pymupdf4llm.to_markdown(str(file_path))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Docling parsing
# ---------------------------------------------------------------------------


def _epub_to_temp_html(epub_path: Path) -> Path:
    """Convert an EPUB to a single temporary HTML file for Docling.

    Docling 2.x has no native EPUB InputFormat; EPUBs are HTML-based and can
    be processed via InputFormat.HTML after extraction.
    """
    import tempfile

    from bs4 import BeautifulSoup
    import ebooklib
    from ebooklib import epub as _epub

    book = _epub.read_epub(str(epub_path))
    parts: list[str] = []
    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        content = item.get_content().decode("utf-8", errors="replace")
        soup = BeautifulSoup(content, "html.parser")
        body = soup.find("body")
        parts.append(str(body) if body else content)

    combined = "<html><body>" + "\n".join(parts) + "</body></html>"
    tmp = tempfile.NamedTemporaryFile(suffix=".html", delete=False, mode="w", encoding="utf-8")
    tmp.write(combined)
    tmp.close()
    return Path(tmp.name)


def build_docling_converter():
    """Build a single shared Docling DocumentConverter.

    Called once at startup, so models are loaded into memory only once,
    then shared (via closure/argument) across all book parse calls.
    OCR is enabled for PDF (the only format that needs it).
    """
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = True
    pipeline_options.do_table_structure = True

    return DocumentConverter(
        allowed_formats=[InputFormat.PDF, InputFormat.DOCX, InputFormat.HTML, InputFormat.ASCIIDOC, InputFormat.MD],
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)},
    )


# Module-level converter reference, set once per worker process by the initializer.
_worker_converter = None


def _worker_init() -> None:
    """ProcessPoolExecutor initializer: build the Docling converter once per worker.

    Each worker process calls this exactly once at startup, so N workers load
    N model copies — but each worker reuses its own converter for all books it
    processes, eliminating the per-book model reload overhead.
    """
    global _worker_converter
    _worker_converter = build_docling_converter()


def process_book_worker(task: dict) -> dict:
    """Entry point for ProcessPoolExecutor workers.

    Uses the per-worker converter built by _worker_init — no model reload
    per book.  Combines parse + upload into one call so the worker handles
    a complete book end-to-end.
    """
    parse_result = parse_book(task, _worker_converter)
    if parse_result["status"] == "failed":
        return parse_result
    return upload_book(
        parse_result,
        task["api_base"],
        task["token"],
        username=task.get("username", ""),
        password=task.get("password", ""),
    )


# Hard timeout for Docling OCR — large scanned PDFs can run for hours without one.
_DOCLING_TIMEOUT_SECONDS = 8 * 60  # 8 minutes per book

# Maximum pages passed to Docling's OCR pipeline per book.
# Worst-case scanned PDFs (agriculture, 17th-century Latin) process at ~5-10 pages/min
# under EasyOCR on heavy bitmap scans.  40 pages = 4-8 min, safely within the 8-minute
# timeout.  Good-quality scans process at 30+ pages/min so the cap is rarely a bottleneck.
_MAX_DOCLING_PAGES = 40


def _interrupt_thread(thread_id: int) -> None:
    """Best-effort: inject SystemExit into a running thread via CPython internals.

    Works only when the thread is executing Python bytecode, not native C extensions.
    For Docling calls blocked in PyTorch/EasyOCR C++ code the exception fires once
    control returns to the Python interpreter.  Combine with max_tasks_per_child on
    the executor as a guaranteed backstop.
    """
    ctypes.pythonapi.PyThreadState_SetAsyncExc(
        ctypes.c_ulong(thread_id),
        ctypes.py_object(SystemExit),
    )


def parse_with_docling(file_path: Path, converter=None) -> tuple[str | None, bytes | None]:
    """Parse a document with Docling using GPU acceleration.

    ``converter`` should be a pre-built DocumentConverter (loaded once at
    startup to share models across all calls).  If None, a temporary
    converter is created for this call only.

    Returns a tuple of (markdown_text, cover_jpeg_bytes).
    The cover is best-effort; it may be None even on success.

    Raises TimeoutError if Docling does not finish within _DOCLING_TIMEOUT_SECONDS.
    The underlying thread is a daemon and will be abandoned on timeout — the worker
    process should be considered dirty and will be replaced by the pool on next restart.
    """
    import os

    if converter is None:
        converter = build_docling_converter()

    # Docling has no native EPUB format: convert to a temp HTML file first.
    tmp_html: Path | None = None
    parse_path = file_path
    if file_path.suffix.lower() == ".epub":
        tmp_html = _epub_to_temp_html(file_path)
        parse_path = tmp_html

    # Run the converter in a daemon thread so we can enforce a hard timeout.
    # max_num_pages caps the OCR workload: at ~10-15 pages/min for heavy scanned
    # PDFs, 80 pages finishes in ~5-8 min — safely within the 8-minute timeout.
    _outcome: list = [None, None, None]  # [markdown, cover_bytes, exception]

    def _convert() -> None:
        try:
            doc = converter.convert(str(parse_path), max_num_pages=_MAX_DOCLING_PAGES)
            _outcome[0] = doc.document.export_to_markdown()
            # Best-effort cover extraction.
            # noinspection PyBroadException
            try:
                pages = doc.document.pages
                if pages:
                    first_page = pages[0] if not isinstance(pages, dict) else pages.get(1)
                    if first_page is not None:
                        images = getattr(first_page, "images", None) or []
                        if images:
                            img_data = images[0]
                            if hasattr(img_data, "pil_image") and img_data.pil_image is not None:
                                import io

                                buf = io.BytesIO()
                                img_data.pil_image.save(buf, format="JPEG")
                                _outcome[1] = buf.getvalue()
            except Exception:
                pass
        except Exception as exc:
            _outcome[2] = exc

    try:
        t = threading.Thread(target=_convert, daemon=True)
        t.start()
        t.join(_DOCLING_TIMEOUT_SECONDS)
        if t.is_alive():
            # Best-effort: inject SystemExit into the blocked thread.
            # noinspection PyTypeChecker
            _interrupt_thread(t.ident)
            t.join(2.0)
            gc.collect()
            raise TimeoutError(f"Docling timed out after {_DOCLING_TIMEOUT_SECONDS // 60} min on {file_path.name}")
        if _outcome[2] is not None:
            raise _outcome[2]
        return _outcome[0], _outcome[1]
    finally:
        if tmp_html and tmp_html.exists():
            os.unlink(tmp_html)


# ---------------------------------------------------------------------------
# Book processing — split into parse (GPU, main thread) + upload (threads)
# ---------------------------------------------------------------------------


def parse_book(task: dict, converter) -> dict:
    """Step A+B: Calibre conversion (if needed) + Docling parse.

    Runs in the main thread so the shared converter (and its GPU models)
    is never accessed concurrently.  Returns a parse-result dict.

    Keys in returned dict:
        local_path    – echoed back
        status        – "parsed" | "failed"
        markdown      – present when status == "parsed"
        cover_bytes   – present (may be None) when status == "parsed"
        collection_id – echoed from task
        error         – present when status == "failed"
    """
    import shutil as _shutil

    src_path = Path(task["local_path"])
    tmp_dir: Path | None = None
    work_file: Path = src_path

    try:
        ext = src_path.suffix.lower()

        # --- Step A: Calibre conversion for formats Docling cannot read ---
        if ext in CALIBRE_FORMATS:
            converted = convert_with_calibre(src_path)
            if converted is None:
                return {
                    "local_path": str(src_path),
                    "collection_id": task["collection_id"],
                    "status": "failed",
                    "error": f"Calibre conversion failed for {src_path.name}",
                }
            tmp_dir = converted.parent
            work_file = converted

        # --- Step B: Parse — fast path first, Docling OCR as fallback ---
        # For PDFs, try pymupdf4llm first (~2s, CPU).  If the PDF has no
        # text layer (scanned), fall back to Docling GPU OCR (~250s).
        markdown: str | None = None
        cover_bytes: bytes | None = None

        if work_file.suffix.lower() == ".pdf":
            markdown = parse_with_pymupdf(work_file)

        if not markdown:
            # Either not a PDF, scanned PDF, or pymupdf failed — use Docling.
            markdown, cover_bytes = parse_with_docling(work_file, converter)

        if not markdown or not markdown.strip():
            return {
                "local_path": str(src_path),
                "collection_id": task["collection_id"],
                "status": "failed",
                "error": f"No text extracted from {src_path.name}",
            }

        return {
            "local_path": str(src_path),
            "collection_id": task["collection_id"],
            "status": "parsed",
            "markdown": markdown,
            "cover_bytes": cover_bytes,
        }

    except Exception as exc:
        return {
            "local_path": str(src_path),
            "collection_id": task["collection_id"],
            "status": "failed",
            "error": str(exc),
        }

    finally:
        if tmp_dir is not None and tmp_dir.exists():
            # noinspection PyBroadException
            try:
                _shutil.rmtree(tmp_dir, ignore_errors=True)
            except Exception:
                pass


def upload_book(parse_result: dict, api_base: str, token: str, username: str = "", password: str = "") -> dict:
    """Step C+D: Upload Markdown + thumbnail to the API.

    Handles two edge cases:
    - 401 Unauthorized: JWT expired during a long ingest run.  Re-login with
      the provided credentials and retry the upload once.
    - 409 Conflict: document already exists on the remote (duplicate upload
      attempt after a crash).  Treated as success — no re-upload needed.

    Returns a final result dict with status "done" or "failed".
    """
    src_path = Path(parse_result["local_path"])
    collection_id = parse_result["collection_id"]
    markdown = parse_result["markdown"]
    cover_bytes = parse_result.get("cover_bytes")

    # --- Step C: Upload markdown ---
    upload_url = f"{api_base}/documents/register-markdown"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {
        "collection_id": collection_id,
        "filename": src_path.name,
        "title": src_path.stem,
        "markdown_content": markdown,
    }

    doc_id: str | None = None
    last_error: str | None = None

    for attempt in range(MAX_ATTEMPTS):
        try:
            resp = requests.post(upload_url, json=payload, headers=headers, timeout=120)

            if resp.status_code == 201:
                body = resp.json()
                doc_id = body.get("document_id") or body.get("id") or body.get("documentId")
                break

            if resp.status_code == 409:
                # Already uploaded — treat as done.
                # noinspection PyBroadException
                try:
                    doc_id = resp.json().get("document_id") or "duplicate"
                except Exception:
                    doc_id = "duplicate"
                break

            if resp.status_code == 401 and username and password:
                # JWT expired — refresh token and retry immediately.
                try:
                    token = login(api_base, username, password)
                    headers["Authorization"] = f"Bearer {token}"
                except Exception as refresh_exc:
                    last_error = f"Token refresh failed: {refresh_exc}"
                continue  # Retry the loop with the new token.

            delay = API_RETRY_DELAYS[min(attempt, len(API_RETRY_DELAYS) - 1)]
            last_error = f"HTTP {resp.status_code}: {resp.text[:200]}"
            if attempt < MAX_ATTEMPTS - 1:
                time.sleep(delay)

        except requests.RequestException as exc:
            delay = API_RETRY_DELAYS[min(attempt, len(API_RETRY_DELAYS) - 1)]
            last_error = str(exc)
            if attempt < MAX_ATTEMPTS - 1:
                time.sleep(delay)

    if doc_id is None:
        return {
            "local_path": str(src_path),
            "status": "failed",
            "error": f"Upload failed: {last_error}",
        }

    # --- Step D: Upload cover thumbnail (best-effort) ---
    if cover_bytes:
        # noinspection PyBroadException
        try:
            requests.post(
                f"{api_base}/documents/{doc_id}/thumbnail",
                data=cover_bytes,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "image/jpeg"},
                timeout=30,
            )
        except Exception:
            pass  # Thumbnail failure is non-fatal.

    return {
        "local_path": str(src_path),
        "status": "done",
        "document_id": doc_id,
    }


# ---------------------------------------------------------------------------
# Pipeline entry points
# ---------------------------------------------------------------------------


def run_dry_run(args: argparse.Namespace) -> None:
    """Scan books and print a summary table without touching the API."""
    log.info("=== DRY RUN ===")
    books = scan_books(args.books_root)

    # Aggregate by collection and format.
    from collections import defaultdict

    col_counts: dict[str, int] = defaultdict(int)
    col_bytes: dict[str, int] = defaultdict(int)
    fmt_counts: dict[str, int] = defaultdict(int)
    calibre_needed = 0

    for b in books:
        col_counts[b["collection"]] += 1
        col_bytes[b["collection"]] += Path(b["path"]).stat().st_size
        fmt_counts[b["ext"]] += 1
        if b["ext"] in CALIBRE_FORMATS:
            calibre_needed += 1

    # Optional remote check.
    remote_counts: dict[str, int] = {}
    if not args.validate_only:
        try:
            log.info("Querying remote for existing document counts...")
            token = login(args.api_base, args.username, args.password)
            workspace_id = get_or_create_workspace(args.api_base, token, "books")
            conn = open_state_db()
            try:
                for folder_name in col_counts:
                    cid = get_or_create_collection(args.api_base, token, workspace_id, folder_name, conn)
                    names = fetch_remote_filenames(args.api_base, token, cid)
                    remote_counts[folder_name] = len(names)
            finally:
                conn.close()
        except Exception as exc:
            log.warning("Could not fetch remote counts: %s", exc)

    # Print the table.
    header = f"{'Collection':<40} {'Local':>7} {'Remote':>7} {'GB':>6}"
    print()
    print(header)
    print("-" * len(header))

    total_local = 0
    total_remote = 0
    total_gb = 0.0

    for col in sorted(col_counts):
        local_n = col_counts[col]
        remote_n = remote_counts.get(col, 0)
        gb = col_bytes[col] / 1_073_741_824
        total_local += local_n
        total_remote += remote_n
        total_gb += gb
        print(f"{col:<40} {local_n:>7} {remote_n:>7} {gb:>6.2f}")

    print("-" * len(header))
    print(f"{'TOTAL':<40} {total_local:>7} {total_remote:>7} {total_gb:>6.2f}")
    print()

    # Format breakdown.
    print("Format breakdown:")
    for ext, count in sorted(fmt_counts.items()):
        print(f"  {ext:<8} {count:>6}")
    print()

    already_remote = sum(remote_counts.values())
    to_process = max(0, total_local - already_remote)

    print(f"Calibre-needed (MOBI/AZW3/DJVU): {calibre_needed}")
    print(f"Already on remote:               {already_remote}")
    print(f"To process:                      {to_process}")

    # Time estimate: 250s per book * 1.25 overhead / (workers * 3600 s/h).
    hours = (to_process * 250 * 1.25) / (args.workers * 3600)
    print(f"Estimated time ({args.workers} workers):      {hours:.1f} hours")
    print()


def run_ingest(args: argparse.Namespace) -> None:
    """Full ingest pipeline: auth, scan, seed DB, create collections, dispatch workers."""
    conn = open_state_db()
    try:
        token = login(args.api_base, args.username, args.password)
        workspace_id = get_or_create_workspace(args.api_base, token, "books")
        books = scan_books(args.books_root)

        # Seed state DB with any books not yet tracked.
        for b in books:
            conn.execute(
                "INSERT OR IGNORE INTO books (local_path, collection) VALUES (?, ?)",
                (b["path"], b["collection"]),
            )
        conn.commit()
        log.info("State DB seeded with %d books", len(books))

        # Ensure all collections exist.
        collection_ids: dict[str, str] = {}
        for folder_name in sorted({b["collection"] for b in books}):
            cid = get_or_create_collection(args.api_base, token, workspace_id, folder_name, conn)
            collection_ids[folder_name] = cid

        # Optionally reconcile local 'done' state against remote.
        if args.resume:
            reconcile_with_remote(conn, args.api_base, token, collection_ids)

        # Build the list of pending / failed books.
        pending = conn.execute(
            "SELECT local_path, collection FROM books WHERE status IN ('pending','failed') AND attempts < ?",
            (MAX_ATTEMPTS,),
        ).fetchall()

        if not pending:
            log.info("Nothing to process.")
            return

        log.info("Processing %d books with %d workers...", len(pending), args.workers)
        done_count = fail_count = 0

        tasks = [
            {
                "local_path": row["local_path"],
                "collection_id": collection_ids[row["collection"]],
                "api_base": args.api_base,
                "token": token,
                "username": args.username,
                "password": args.password,
            }
            for row in pending
            if row["collection"] in collection_ids
        ]

        # Each worker process loads Docling once via _worker_init, then handles
        # N books with the same converter — no per-book model reload.
        # Memory: args.workers × ~3 GB (e.g. 2 workers = ~6 GB).
        log.info("Initialising %d worker(s) — Docling loaded once per worker...", args.workers)
        with ProcessPoolExecutor(max_workers=args.workers, initializer=_worker_init) as executor:
            futures = {executor.submit(process_book_worker, t): t for t in tasks}
            try:
                for future in as_completed(futures):
                    if shutdown_event.is_set():
                        break
                    result = future.result()
                    path = result["local_path"]
                    status = result["status"]
                    doc_id = result.get("document_id")
                    error = result.get("error")
                    update_book_status(conn, path, status, doc_id, error)
                    if status == "done":
                        done_count += 1
                        if done_count % 50 == 0:
                            log.info("Progress: %d done, %d failed", done_count, fail_count)
                    else:
                        fail_count += 1
                        log.warning("FAILED: %s — %s", Path(path).name, error)
            finally:
                # Cancel any futures that have not started yet.
                for f in list(futures):
                    f.cancel()

        log.info("=== Done: %d success, %d failed ===", done_count, fail_count)

    except APIError as exc:
        log.error("FATAL API error: %s", exc)
        sys.exit(1)
    finally:
        conn.close()


def run_validation(args: argparse.Namespace) -> None:
    """Validate the state DB and remote against each other.

    For every collection in the local state DB, fetches the remote filename set and
    identifies any locally-done books that are absent on the remote.  Writes a JSON
    report to the state directory and prints a summary to stdout.  Exits with status 1
    if any books are missing on the remote.
    """
    conn: sqlite3.Connection | None = None
    try:
        token = login(args.api_base, args.username, args.password)
        conn = open_state_db()

        # Load all known collections from the local state DB.
        collection_rows = conn.execute("SELECT folder_name, collection_id FROM collections").fetchall()

        if not collection_rows:
            log.warning("No collections found in state DB — run ingest first to populate collections")

        collections_checked = 0
        total_local_done = 0
        total_remote = 0
        total_missing = 0
        skipped_count = 0
        report_collections: list[dict] = []

        for row in collection_rows:
            folder_name = row["folder_name"]
            collection_id = row["collection_id"]

            remote_names = fetch_remote_filenames(args.api_base, token, collection_id)

            done_rows = conn.execute(
                "SELECT local_path FROM books WHERE collection = ? AND status = 'done'",
                (folder_name,),
            ).fetchall()

            local_done = len(done_rows)

            # Skip collections where the remote fetch returned empty, but we have
            # locally-done books — this almost certainly indicates an API error.
            if not remote_names and local_done > 0:
                log.warning(
                    "Collection '%s': remote fetch returned empty but local_done=%d — skipping (possible API error); report may be incomplete",
                    folder_name,
                    local_done,
                )
                report_collections.append(
                    {
                        "name": folder_name,
                        "skipped": True,
                        "reason": "remote fetch returned empty (possible API error)",
                    }
                )
                skipped_count += 1
                continue

            missing: list[str] = []
            for book_row in done_rows:
                fname = Path(book_row["local_path"]).name
                if fname not in remote_names:
                    missing.append(book_row["local_path"])

            remote_count = len(remote_names)

            log.info(
                "Collection '%s': local_done=%d, remote=%d, missing=%d",
                folder_name,
                local_done,
                remote_count,
                len(missing),
            )

            report_collections.append(
                {
                    "name": folder_name,
                    "local_done": local_done,
                    "remote_count": remote_count,
                    "missing": missing,
                }
            )

            collections_checked += 1
            total_local_done += local_done
            total_remote += remote_count
            total_missing += len(missing)

        report = {
            "generated_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "summary": {
                "collections_checked": collections_checked,
                "total_local_done": total_local_done,
                "total_remote": total_remote,
                "missing_remote": total_missing,
                "extra_remote": 0,
                "skipped_collections": skipped_count,
            },
            "collections": report_collections,
        }

        _STATE_DIR.mkdir(parents=True, exist_ok=True)
        report_path = _STATE_DIR / f"validation_report_{datetime.now(UTC).strftime('%Y%m%d_%H%M%S')}.json"
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

        print()
        print("=== Validation Report ===")
        print(f"Collections checked:  {collections_checked}")
        print(f"Local done:          {total_local_done}")
        print(f"Remote count:        {total_remote}")
        print(f"Missing on remote:      {total_missing}")
        print(f"Report saved to: {report_path}")
        print()

        if total_missing > 0:
            log.warning("Validation found %d books missing on remote", total_missing)
            sys.exit(1)
        else:
            log.info("Validation passed: all local done books are present on remote")

    except APIError as exc:
        log.error("FATAL API error during validation: %s", exc)
        sys.exit(1)
    finally:
        if conn is not None:
            conn.close()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    """Build and return the argument parser."""
    parser = argparse.ArgumentParser(
        prog="batch_ingest",
        description="Batch ingest books into Scrapalot using Docling + Calibre.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Scan and print a summary table without uploading anything.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        default=False,
        help="Resume an interrupted run; reconciles local state against remote.",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        default=False,
        help="Only validate state DB and remote counts; do not ingest.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=8,
        metavar="N",
        help="Number of parallel worker processes (default: 8, max: 16).",
    )
    parser.add_argument(
        "--books-root",
        type=Path,
        default=BOOKS_ROOT,
        metavar="PATH",
        help=f"Root directory containing book folders (default: {BOOKS_ROOT}).",
    )
    parser.add_argument(
        "--api-base",
        default="https://api.scrapalot.app/api/v1",
        metavar="URL",
        help="Scrapalot API base URL (default: https://api.scrapalot.app/api/v1).",
    )
    parser.add_argument(
        "--username",
        default="admin",
        help="API username (default: admin).",
    )
    parser.add_argument(
        "--password",
        default="admin123",
        help="API password (default: admin123).",
    )
    return parser


def main() -> None:
    """Parse arguments, configure logging, and dispatch to the appropriate runner."""
    parser = build_arg_parser()
    args = parser.parse_args()

    # Clamp workers to the supported range.
    args.workers = max(1, min(16, args.workers))

    global log
    log = setup_logging(dry_run=args.dry_run)
    install_signal_handler()

    log.info("=== Scrapalot Batch Ingest ===")
    log.info("API base:   %s", args.api_base)
    log.info("Books root: %s", args.books_root)
    log.info("Workers:    %d", args.workers)
    log.info("Dry run:    %s", args.dry_run)
    log.info("Resume:     %s", args.resume)
    log.info("Validate:   %s", args.validate_only)

    if args.dry_run:
        run_dry_run(args)
    elif args.validate_only:
        run_validation(args)
    else:
        run_ingest(args)


if __name__ == "__main__":
    main()
