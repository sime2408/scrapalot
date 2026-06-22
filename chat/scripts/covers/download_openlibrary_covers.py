#!/usr/bin/env python3
"""Download book cover thumbnails from Open Library for UFO collection documents.

Searches Open Library by parsed title+author from the document filename,
downloads the best-matching cover, and uploads it via the Scrapalot API.

Usage:
    python scripts/covers/download_openlibrary_covers.py
    python scripts/covers/download_openlibrary_covers.py --dry-run
    python scripts/covers/download_openlibrary_covers.py --collection-id 804edc35-...
    python scripts/covers/download_openlibrary_covers.py --api-base http://localhost:8090/api/v1
"""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path
import re
import sys
import time
import urllib.request

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _scrapalot_api import (  # noqa: E402
    auth_headers,
    has_custom_thumbnail,
    login,
    upload_thumbnail,
)

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DEFAULT_API_BASE = "https://api.scrapalot.app/api/v1"
DEFAULT_USERNAME = "admin"
DEFAULT_PASSWORD = "admin123"  # pragma: allowlist secret
DEFAULT_COLLECTION_ID = "804edc35-98b2-4642-a176-a7b2e6d53d66"

OPEN_LIBRARY_SEARCH_URL = "https://openlibrary.org/search.json"
OPEN_LIBRARY_COVER_URL = "https://covers.openlibrary.org/b/id/{cover_id}-L.jpg"
OPEN_LIBRARY_COVER_M_URL = "https://covers.openlibrary.org/b/id/{cover_id}-M.jpg"

SEARCH_DELAY = 1.0  # seconds between OL search requests (rate limit)
UPLOAD_DELAY = 0.3  # seconds between API uploads
MIN_COVER_BYTES = 1000  # ignore placeholder 1×1px images

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("ol_covers")

# ---------------------------------------------------------------------------
# Filename parsing
# ---------------------------------------------------------------------------

_YEAR_PREFIX = re.compile(r"^\((\d{4})\)\s*")
_NON_ALNUM = re.compile(r"[^a-z0-9 ]")
_MULTI_SPACE = re.compile(r"\s+")


def parse_filename(filename: str) -> tuple[str, str, str | None]:
    """Parse '(1979) Author Name - Book Title.pdf' → (title, author, year).

    Returns:
        (title, author, year) — author and year may be empty string / None.
    """
    stem = Path(filename).stem

    # Extract year
    m = _YEAR_PREFIX.match(stem)
    year = m.group(1) if m else None
    stem = _YEAR_PREFIX.sub("", stem)

    # Split on first " - " to separate author from title
    if " - " in stem:
        author_part, title_part = stem.split(" - ", 1)
    else:
        author_part = ""
        title_part = stem

    return title_part.strip(), author_part.strip(), year


def _normalise(text: str) -> str:
    t = text.lower()
    t = _NON_ALNUM.sub(" ", t)
    return _MULTI_SPACE.sub(" ", t).strip()


# ---------------------------------------------------------------------------
# Open Library search
# ---------------------------------------------------------------------------


def search_openlibrary(title: str, author: str, year: str | None) -> list[dict]:
    """Query Open Library search API and return raw result docs."""
    query = title
    if author:
        query = f"{title} {author}"

    params: dict = {"q": query, "limit": 5, "fields": "key,title,author_name,cover_i,first_publish_year"}
    if year:
        params["first_publish_year"] = year

    try:
        resp = requests.get(OPEN_LIBRARY_SEARCH_URL, params=params, timeout=15)
        if resp.status_code != 200:
            log.debug("OL search returned %d for %r", resp.status_code, query)
            return []
        data = resp.json()
        return data.get("docs", [])
    except Exception as e:
        log.debug("OL search error for %r: %s", query, e)
        return []


def _title_similarity(a: str, b: str) -> float:
    from difflib import SequenceMatcher

    return SequenceMatcher(None, _normalise(a), _normalise(b)).ratio()


def pick_best_cover_id(docs: list[dict], title: str, author: str) -> int | None:
    """From OL search results, pick the cover_i of the best title match."""
    best_score = 0.0
    best_cover_id = None

    for doc in docs:
        cover_id = doc.get("cover_i")
        if not cover_id:
            continue

        ol_title = doc.get("title", "")
        score = _title_similarity(title, ol_title)

        # Boost when author tokens overlap
        if author:
            ol_authors = " ".join(doc.get("author_name") or [])
            # Simple overlap: any surname word match
            author_words = set(_normalise(author).split())
            ol_author_words = set(_normalise(ol_authors).split())
            if author_words & ol_author_words:
                score += 0.1

        if score > best_score:
            best_score = score
            best_cover_id = cover_id

    if best_score >= 0.3 and best_cover_id:
        return best_cover_id
    return None


def download_cover(cover_id: int) -> bytes | None:
    """Download cover image from Open Library by cover ID."""
    for url_template in (OPEN_LIBRARY_COVER_URL, OPEN_LIBRARY_COVER_M_URL):
        url = url_template.format(cover_id=cover_id)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Scrapalot/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
                if len(data) >= MIN_COVER_BYTES:
                    return data
                log.debug("Cover too small (%d bytes), trying medium: %s", len(data), url)
        except Exception as e:
            log.debug("Download error from %s: %s", url, e)
    return None


# ---------------------------------------------------------------------------
# Scrapalot API helpers
# ---------------------------------------------------------------------------


def get_collection_documents(api_base: str, token: str, collection_id: str) -> list[dict]:
    """Paginate through all documents in a collection."""
    docs: list[dict] = []
    page = 1
    while True:
        resp = requests.get(
            f"{api_base}/documents/collection/{collection_id}",
            headers=auth_headers(token),
            params={"page": page, "page_size": 100},
            timeout=30,
        )
        if resp.status_code != 200:
            log.warning("GET documents page %d → %d", page, resp.status_code)
            break
        data = resp.json()
        page_docs = data.get("documents", data) if isinstance(data, dict) else data
        if not isinstance(page_docs, list):
            break
        docs.extend(page_docs)
        has_more = data.get("has_more", False) if isinstance(data, dict) else False
        if not has_more or not page_docs:
            break
        page += 1
    return docs


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


def run(args: argparse.Namespace) -> None:
    token = login(args.api_base, args.username, args.password)

    log.info("Fetching documents from collection %s ...", args.collection_id)
    docs = get_collection_documents(args.api_base, token, args.collection_id)
    log.info("Found %d documents", len(docs))

    if not docs:
        log.warning("No documents found — check collection ID and credentials")
        return

    uploaded = skipped_existing = skipped_no_cover = failed = 0

    for i, doc in enumerate(docs, 1):
        doc_id = doc.get("id") or doc.get("documentId")
        filename = doc.get("filename") or doc.get("file_name") or doc.get("name") or ""
        if not doc_id or not filename:
            skipped_no_cover += 1
            continue

        if has_custom_thumbnail(doc):
            log.debug("[%d/%d] SKIP (thumbnail exists): %s", i, len(docs), filename)
            skipped_existing += 1
            continue

        title, author, year = parse_filename(filename)
        log.info("[%d/%d] Searching OL: title=%r author=%r year=%s", i, len(docs), title[:50], author[:40], year)

        ol_docs = search_openlibrary(title, author, year)
        time.sleep(SEARCH_DELAY)  # rate limit

        if not ol_docs:
            log.info("  No OL results for %r", filename)
            skipped_no_cover += 1
            continue

        cover_id = pick_best_cover_id(ol_docs, title, author)
        if not cover_id:
            log.info("  No usable cover in OL results for %r", filename)
            skipped_no_cover += 1
            continue

        log.info("  Cover ID %d found — downloading ...", cover_id)
        image_bytes = download_cover(cover_id)
        if not image_bytes:
            log.info("  Download failed for cover_id=%d", cover_id)
            skipped_no_cover += 1
            continue

        log.info("  Downloaded %d bytes", len(image_bytes))

        if args.dry_run:
            log.info("  DRY RUN — would upload cover for %s", filename)
            uploaded += 1
            continue

        ok = upload_thumbnail(args.api_base, token, doc_id, image_bytes)
        if ok:
            log.info("  Uploaded thumbnail for %r", filename)
            uploaded += 1
            time.sleep(UPLOAD_DELAY)
        else:
            failed += 1

    print("\n" + "=" * 55)
    print("OPEN LIBRARY COVER DOWNLOAD COMPLETE")
    print("=" * 55)
    print(f"  Documents scanned:      {len(docs)}")
    print(f"  Covers uploaded:        {uploaded}" + (" (dry run)" if args.dry_run else ""))
    print(f"  Skipped (had thumb):    {skipped_existing}")
    print(f"  No cover found on OL:   {skipped_no_cover}")
    print(f"  Upload failures:        {failed}")
    print("=" * 55)


def main() -> None:
    if sys.platform == "win32":
        os.environ.setdefault("PYTHONIOENCODING", "utf-8")
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Download Open Library covers for Scrapalot documents.")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    parser.add_argument("--username", default=DEFAULT_USERNAME)
    parser.add_argument("--password", default=DEFAULT_PASSWORD)
    parser.add_argument("--collection-id", default=DEFAULT_COLLECTION_ID)
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done, no uploads")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    run(args)


if __name__ == "__main__":
    main()
