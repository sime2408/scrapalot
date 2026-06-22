"""
test_celery_ingest.py — Celery worker stress test via raw file upload.

Picks N books from E:\\_KNJIGE, uploads them as raw files to the Scrapalot API
with auto_process=true, and polls job status until completion or timeout.

The API dispatches each upload to the Celery worker (CELERY_ENABLED=true required
on the server), which runs Docling OCR + chunking + embedding server-side.

Prerequisites:
    - docker compose up scrapalot-workers
    - CELERY_ENABLED=true in docker-scrapalot/.env (or set on scrapalot-chat container)

Usage:
    python scripts/manual_tests/test_celery_ingest.py --count 20
    python scripts/manual_tests/test_celery_ingest.py --count 100 --workers 4 --timeout 600
    python scripts/manual_tests/test_celery_ingest.py --count 10 --api-base http://localhost:8090/api/v1
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import logging
from pathlib import Path
import random
import sys
import time

import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BOOKS_ROOT = Path(r"E:\_KNJIGE")
SUPPORTED_FORMATS = {".pdf", ".epub", ".docx"}

DEFAULT_API_BASE = "https://api.scrapalot.app/api/v1"
DEFAULT_USERNAME = "admin"
DEFAULT_PASSWORD = "admin"
DEFAULT_COUNT = 20
DEFAULT_WORKERS = 2  # parallel upload threads (not Celery workers)
DEFAULT_POLL_TIMEOUT = 600  # seconds to wait per job before giving up
DEFAULT_POLL_INTERVAL = 5  # seconds between status polls

WORKSPACE_NAME = "celery-test"
COLLECTION_NAME = "celery-test-books"

log = logging.getLogger("celery_test")


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(message)s",
        datefmt="%H:%M:%S",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def login(api_base: str, username: str, password: str) -> str:
    resp = requests.post(
        f"{api_base}/auth/login",
        json={"username": username, "password": password},
        timeout=30,
    )
    if resp.status_code != 200:
        raise SystemExit(f"Login failed ({resp.status_code}): {resp.text}")
    data = resp.json()
    token = data.get("accessToken") or data.get("access_token")
    if not token:
        raise SystemExit(f"No token in login response: {data}")
    log.info("Authenticated as %s", username)
    return token


def get_or_create_workspace(api_base: str, token: str) -> str:
    headers = {"Authorization": f"Bearer {token}"}
    resp = requests.get(f"{api_base}/workspaces", headers=headers, timeout=30)
    if resp.status_code == 200:
        data = resp.json()
        items = data.get("workspaces", data) if isinstance(data, dict) else data
        for ws in items:
            if ws.get("name") == WORKSPACE_NAME:
                # noinspection PyTypeChecker
                log.info("Using existing workspace '%s' (id=%s)", WORKSPACE_NAME, ws["id"])
                # noinspection PyTypeChecker
                return ws["id"]

    resp = requests.post(
        f"{api_base}/workspaces",
        json={"name": WORKSPACE_NAME},
        headers={**headers, "Content-Type": "application/json"},
        timeout=30,
    )
    if resp.status_code not in (200, 201):
        raise SystemExit(f"Failed to create workspace: {resp.status_code} {resp.text}")
    ws_id = resp.json()["id"]
    log.info("Created workspace '%s' (id=%s)", WORKSPACE_NAME, ws_id)
    return ws_id


def get_or_create_collection(api_base: str, token: str, workspace_id: str) -> str:
    headers = {"Authorization": f"Bearer {token}"}
    resp = requests.get(
        f"{api_base}/collections",
        headers=headers,
        params={"workspace_id": workspace_id},
        timeout=30,
    )
    if resp.status_code == 200:
        data = resp.json()
        items = data.get("collections", data) if isinstance(data, dict) else data
        for col in items:
            if col.get("name") == COLLECTION_NAME:
                # noinspection PyTypeChecker
                log.info("Using existing collection '%s' (id=%s)", COLLECTION_NAME, col["id"])
                # noinspection PyTypeChecker
                return col["id"]

    resp = requests.post(
        f"{api_base}/collections",
        json={
            "name": COLLECTION_NAME,
            "workspace_id": workspace_id,
            "chunking_strategy": "recursive",
            "chunk_size": 1000,
            "chunk_overlap": 200,
        },
        headers={**headers, "Content-Type": "application/json"},
        timeout=30,
    )
    if resp.status_code not in (200, 201):
        raise SystemExit(f"Failed to create collection: {resp.status_code} {resp.text}")
    col_id = resp.json()["id"]
    log.info("Created collection '%s' (id=%s)", COLLECTION_NAME, col_id)
    return col_id


# ---------------------------------------------------------------------------
# Book selection
# ---------------------------------------------------------------------------


def pick_books(count: int, seed: int | None = None) -> list[Path]:
    """Randomly select `count` supported books from BOOKS_ROOT."""
    if not BOOKS_ROOT.exists():
        raise SystemExit(f"Books root not found: {BOOKS_ROOT}")

    all_books = [p for p in BOOKS_ROOT.rglob("*") if p.suffix.lower() in SUPPORTED_FORMATS and p.is_file()]
    if not all_books:
        raise SystemExit(f"No supported books found in {BOOKS_ROOT}")

    rng = random.Random(seed)
    selected = rng.sample(all_books, min(count, len(all_books)))
    log.info("Selected %d books from %d total (seed=%s)", len(selected), len(all_books), seed)
    return selected


# ---------------------------------------------------------------------------
# Upload + poll
# ---------------------------------------------------------------------------


def upload_raw(
    file_path: Path,
    api_base: str,
    token: str,
    collection_id: str,
    username: str,
    password: str,
) -> dict:
    """
    Upload a raw file to /documents/upload with auto_process=true.

    Returns dict with keys: file, job_id, document_id, upload_status, error
    """
    headers = {"Authorization": f"Bearer {token}"}
    result = {
        "file": file_path.name,
        "job_id": None,
        "document_id": None,
        "upload_status": None,
        "error": None,
    }

    for attempt in range(3):
        try:
            with open(file_path, "rb") as fh:
                resp = requests.post(
                    f"{api_base}/documents/upload",
                    headers=headers,
                    data={
                        "collection_id": collection_id,
                        "auto_process": "true",
                    },
                    files={"file": (file_path.name, fh, _mime(file_path))},
                    timeout=120,
                )

            if resp.status_code == 401 and attempt < 2:
                # Refresh token and retry
                token = login(api_base, username, password)
                headers["Authorization"] = f"Bearer {token}"
                continue

            if resp.status_code == 409:
                result["upload_status"] = "duplicate"
                # noinspection PyBroadException
                try:
                    body = resp.json()
                    result["document_id"] = body.get("document_id") or body.get("id")
                except Exception:
                    pass
                return result

            if resp.status_code == 429:
                result["upload_status"] = "rate_limited"
                result["error"] = "429 Too Many Requests — per-user concurrency limit hit"
                log.warning("429 for %s — waiting 10s before retry", file_path.name)
                time.sleep(10)
                continue

            if resp.status_code not in (200, 201):
                result["upload_status"] = "upload_failed"
                result["error"] = f"HTTP {resp.status_code}: {resp.text[:300]}"
                return result

            body = resp.json()
            result["job_id"] = body.get("job_id")
            result["document_id"] = body.get("document_id")
            result["upload_status"] = "uploaded"
            return result

        except Exception as exc:
            result["error"] = str(exc)
            if attempt < 2:
                time.sleep(3)

    result["upload_status"] = "upload_failed"
    return result


def poll_job(
    job_id: str,
    api_base: str,
    token: str,
    timeout: int,
    poll_interval: int,
    label: str,
) -> dict:
    """
    Poll /jobs/{job_id} until completed/failed or timeout.

    Returns dict: job_id, final_status, progress, duration_s, error
    """
    headers = {"Authorization": f"Bearer {token}"}
    start = time.monotonic()
    last_progress = 0.0

    while True:
        elapsed = time.monotonic() - start
        if elapsed > timeout:
            return {
                "job_id": job_id,
                "final_status": "timeout",
                "progress": last_progress,
                "duration_s": elapsed,
                "error": f"Timed out after {timeout}s",
            }

        try:
            resp = requests.get(
                f"{api_base}/jobs/{job_id}",
                headers=headers,
                timeout=15,
            )
            if resp.status_code == 200:
                body = resp.json()
                status = body.get("status", "unknown")
                # progress may be 0.0–1.0 or 0–100
                raw_progress = body.get("progress", 0) or 0
                progress = raw_progress if raw_progress <= 1.0 else raw_progress / 100.0
                last_progress = progress

                pct = f"{progress * 100:.0f}%"
                log.debug("[%s] job %s — %s %s (%.0fs)", label, job_id, status, pct, elapsed)

                if status in ("completed", "done"):
                    return {
                        "job_id": job_id,
                        "final_status": "completed",
                        "progress": progress,
                        "duration_s": elapsed,
                        "error": None,
                    }
                if status in ("failed", "error"):
                    return {
                        "job_id": job_id,
                        "final_status": "failed",
                        "progress": progress,
                        "duration_s": elapsed,
                        "error": body.get("error_message") or body.get("description"),
                    }
            elif resp.status_code == 404:
                # Job not found yet — Celery may not have picked it up
                log.debug("[%s] job %s — 404, waiting...", label, job_id)
        except Exception as exc:
            log.debug("[%s] poll error: %s", label, exc)

        time.sleep(poll_interval)


def process_one(
    file_path: Path,
    api_base: str,
    token: str,
    collection_id: str,
    username: str,
    password: str,
    poll_timeout: int,
    poll_interval: int,
) -> dict:
    """Upload one file and poll until done. Returns a full result record."""
    t0 = time.monotonic()
    label = file_path.name[:40]

    log.info("→ Uploading: %s (%.1f MB)", file_path.name, file_path.stat().st_size / 1_048_576)
    upload = upload_raw(file_path, api_base, token, collection_id, username, password)

    if upload["upload_status"] != "uploaded":
        log.warning("✗ Upload failed [%s]: %s", label, upload.get("error") or upload["upload_status"])
        return {**upload, "final_status": upload["upload_status"], "duration_s": time.monotonic() - t0}

    job_id = upload["job_id"]
    if not job_id:
        # Uploaded but no job_id — might be a duplicate that was already processed
        log.info("✓ Duplicate/no job for %s", label)
        return {**upload, "final_status": "duplicate", "duration_s": time.monotonic() - t0}

    log.info("  Queued: job_id=%s, polling...", job_id)
    poll = poll_job(job_id, api_base, token, poll_timeout, poll_interval, label)

    icon = "✓" if poll["final_status"] == "completed" else "✗"
    log.info(
        "%s %s — %s in %.0fs (progress=%.0f%%)",
        icon,
        label,
        poll["final_status"],
        poll["duration_s"],
        poll["progress"] * 100,
    )

    return {**upload, **poll}


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------


def print_summary(results: list[dict], total_elapsed: float) -> None:
    completed = [r for r in results if r.get("final_status") == "completed"]
    failed = [r for r in results if r.get("final_status") == "failed"]
    timed_out = [r for r in results if r.get("final_status") == "timeout"]
    other = [r for r in results if r.get("final_status") not in ("completed", "failed", "timeout")]

    print("\n" + "=" * 70)
    print("  CELERY WORKER TEST — SUMMARY")
    print("=" * 70)
    print(f"  Total books:    {len(results)}")
    print(f"  Completed:      {len(completed)}")
    print(f"  Failed:         {len(failed)}")
    print(f"  Timed out:      {len(timed_out)}")
    print(f"  Other:          {len(other)}")
    print(f"  Total time:     {total_elapsed:.0f}s")
    if completed:
        durations = [r["duration_s"] for r in completed]
        print(f"  Avg per book:   {sum(durations) / len(durations):.0f}s")
        print(f"  Fastest:        {min(durations):.0f}s")
        print(f"  Slowest:        {max(durations):.0f}s")
    print("=" * 70)

    if failed:
        print("\nFAILED:")
        for r in failed:
            print(f"  ✗ {r['file']}")
            print(f"    {r.get('error') or '—'}")

    if timed_out:
        print("\nTIMED OUT:")
        for r in timed_out:
            print(f"  ⏱ {r['file']} (job={r.get('job_id')})")

    print()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mime(path: Path) -> str:
    ext = path.suffix.lower()
    return {
        ".pdf": "application/pdf",
        ".epub": "application/epub+zip",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }.get(ext, "application/octet-stream")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Celery worker stress test — raw file upload")
    p.add_argument("--api-base", default=DEFAULT_API_BASE, help="API base URL (default: %(default)s)")
    p.add_argument("--username", default=DEFAULT_USERNAME, help="API username")
    p.add_argument("--password", default=DEFAULT_PASSWORD, help="API password")
    p.add_argument("--count", type=int, default=DEFAULT_COUNT, help="Number of books to upload (default: %(default)s)")
    p.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help="Parallel upload threads (default: %(default)s)")
    p.add_argument("--timeout", type=int, default=DEFAULT_POLL_TIMEOUT, help="Per-job poll timeout in seconds (default: %(default)s)")
    p.add_argument("--poll-interval", type=int, default=DEFAULT_POLL_INTERVAL, help="Seconds between status polls (default: %(default)s)")
    p.add_argument("--seed", type=int, default=None, help="Random seed for reproducible book selection")
    p.add_argument("--books-root", type=Path, default=BOOKS_ROOT, help="Books root directory (default: %(default)s)")
    p.add_argument("--pdfs-only", action="store_true", help="Only pick PDFs (heavier Docling test)")
    p.add_argument("--collection-id", default=None, help="Use an existing collection ID (skips workspace/collection creation)")
    return p.parse_args()


def main() -> None:
    setup_logging()
    args = parse_args()

    global BOOKS_ROOT, SUPPORTED_FORMATS
    BOOKS_ROOT = args.books_root
    if args.pdfs_only:
        SUPPORTED_FORMATS = {".pdf"}

    # Auth
    token = login(args.api_base, args.username, args.password)

    # Workspace + collection
    if args.collection_id:
        collection_id = args.collection_id
        log.info("Using provided collection_id=%s", collection_id)
    else:
        workspace_id = get_or_create_workspace(args.api_base, token)
        collection_id = get_or_create_collection(args.api_base, token, workspace_id)

    # Pick books
    books = pick_books(args.count, seed=args.seed)

    log.info(
        "Starting test: %d books, %d upload thread(s), poll timeout=%ds, Flower: http://localhost:5555",
        len(books),
        args.workers,
        args.timeout,
    )

    # Upload + poll (parallel upload threads, blocking poll per thread)
    t0 = time.monotonic()
    results: list[dict] = []

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(
                process_one,
                book,
                args.api_base,
                token,
                collection_id,
                args.username,
                args.password,
                args.timeout,
                args.poll_interval,
            ): book
            for book in books
        }
        for fut in as_completed(futures):
            try:
                results.append(fut.result())
            except Exception as exc:
                book = futures[fut]
                log.error("Unexpected error for %s: %s", book.name, exc)
                results.append(
                    {
                        "file": book.name,
                        "final_status": "error",
                        "duration_s": 0,
                        "error": str(exc),
                    }
                )

    print_summary(results, time.monotonic() - t0)

    # Exit code: 0 if all completed, 1 if any failed
    any_bad = any(r.get("final_status") not in ("completed", "duplicate") for r in results)
    sys.exit(1 if any_bad else 0)


if __name__ == "__main__":
    main()
