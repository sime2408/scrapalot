#!/usr/bin/env python3
"""
upload_calibre_covers.py — Upload Calibre cover images to Scrapalot documents.

Walks the CalibreLibrary directory, matches each book's cover.jpg to an
existing document in Scrapalot (by normalised title similarity), and uploads
the image via POST /documents/{document_id}/thumbnail.

Matching strategy:
  - Scrapalot filename: "(1979) Author Name - Book Title.pdf"
      → strip year, strip author, strip extension → "book title"
  - Calibre folder:     "Book Title (12345)"
      → strip numeric ID suffix                 → "book title"
  A match is accepted when the normalised similarity ≥ MATCH_THRESHOLD (0.82).

Usage:
    python scripts/covers/upload_calibre_covers.py
    python scripts/covers/upload_calibre_covers.py --calibre "C:/Users/Me/CalibreLibrary"
    python scripts/covers/upload_calibre_covers.py --dry-run
    python scripts/covers/upload_calibre_covers.py --api-base http://localhost:8090/api/v1
"""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path
import re
import sys
import time

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

DEFAULT_CALIBRE_DIR = Path("C:/Users/Administrator/CalibreLibrary")
DEFAULT_API_BASE = "https://api.scrapalot.app/api/v1"
DEFAULT_USERNAME = "admin"
DEFAULT_PASSWORD = "admin123"
MATCH_THRESHOLD = 0.82  # difflib similarity score to accept a match
REQUEST_TIMEOUT = 30
UPLOAD_TIMEOUT = 60
DELAY_BETWEEN_UPLOADS = 0.2  # seconds — polite rate limiting

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("calibre_covers")


# ---------------------------------------------------------------------------
# Normalisation helpers
# ---------------------------------------------------------------------------

_YEAR_PREFIX = re.compile(r"^\(\d{4}\)\s*")
_NUMERIC_ID_SUFFIX = re.compile(r"\s*\(\d+\)\s*$")
_NON_ALNUM = re.compile(r"[^a-z0-9 ]")
_MULTI_SPACE = re.compile(r"\s+")

# Common English words and year patterns that appear in many titles — excluded
# from the inverted index so they don't flood the candidate set.
_STOP_WORDS = frozenset(
    {
        "the",
        "and",
        "of",
        "in",
        "a",
        "an",
        "to",
        "for",
        "with",
        "on",
        "at",
        "by",
        "from",
        "as",
        "is",
        "its",
        "into",
        "or",
        "de",
        "la",
        "el",
        "history",
        "introduction",
        "guide",
        "handbook",
        "volume",
        "edition",
        "vol",
        "new",
        "complete",
        "practical",
    }
)
# Year numbers (4-digit) are also noisy index entries
_YEAR_RE = re.compile(r"^\d{4}$")


def _is_index_word(word: str) -> bool:
    """Return True if the word should be used in the inverted index."""
    return len(word) > 3 and word not in _STOP_WORDS and not _YEAR_RE.match(word)


def _normalise(text: str) -> str:
    """Lowercase, strip punctuation and extra whitespace."""
    t = text.lower()
    t = _NON_ALNUM.sub(" ", t)
    t = _MULTI_SPACE.sub(" ", t).strip()
    return t


def _scrapalot_title_key(filename: str) -> str:
    """Extract a normalised title key from a scrapalot document filename.

    Examples:
        "(1979) Sian E. Rees - Agricultural Implements.pdf" → "agricultural implements"
        "Biology of Fungi.epub"                             → "biology of fungi"
    """
    stem = Path(filename).stem
    # Strip leading year: "(1979) "
    stem = _YEAR_PREFIX.sub("", stem)
    # Strip author prefix: everything before " - " (first occurrence)
    if " - " in stem:
        stem = stem.split(" - ", 1)[1]
    return _normalise(stem)


def _calibre_title_key(folder_name: str) -> str:
    """Extract a normalised title key from a Calibre book folder name.

    Examples:
        "Agricultural Implements (12345)" → "agricultural implements"
        "Biology of Fungi (99)"           → "biology of fungi"
    """
    name = _NUMERIC_ID_SUFFIX.sub("", folder_name)
    return _normalise(name)


def _similarity(a: str, b: str) -> float:
    """SequenceMatcher ratio between two normalised strings."""
    from difflib import SequenceMatcher

    return SequenceMatcher(None, a, b).ratio()


# ---------------------------------------------------------------------------
# Calibre index + inverted word index for fast matching
# ---------------------------------------------------------------------------


class CalibreIndex:
    """Inverted-word index over normalised Calibre title keys.

    Building: O(total_words).  Lookup per document: O(|candidates|) not O(N).
    """

    def __init__(self) -> None:
        # normalised_key → cover path
        self._covers: dict[str, Path] = {}
        # word → set of normalised keys that contain that word
        self._word_index: dict[str, set] = {}

    def add(self, key: str, cover: Path) -> None:
        self._covers[key] = cover
        for word in key.split():
            if _is_index_word(word):
                self._word_index.setdefault(word, set()).add(key)

    def find(self, doc_key: str, threshold: float) -> tuple[str, Path, float] | None:
        """Return (calibre_key, cover_path, score) or None.

        Uses a voting approach: count how many doc words each candidate matches.
        Only the top-voted candidates (sharing ≥2 words or single-word titles)
        are scored with SequenceMatcher, keeping the candidate set small.
        """
        # Exact match first
        if doc_key in self._covers:
            return doc_key, self._covers[doc_key], 1.0

        # Count how many index words each candidate shares with doc_key
        votes: dict[str, int] = {}
        doc_words = [w for w in doc_key.split() if _is_index_word(w)]
        for word in doc_words:
            for ckey in self._word_index.get(word, ()):
                votes[ckey] = votes.get(ckey, 0) + 1

        if not votes:
            return None

        # Keep only candidates with the highest vote counts (top 50 max)
        min_votes = max(1, max(votes.values()) // 2)
        top_candidates = [k for k, v in votes.items() if v >= min_votes]
        top_candidates.sort(key=lambda k: votes[k], reverse=True)
        top_candidates = top_candidates[:50]

        # Score the shortlisted candidates
        best_key = None
        best_score = 0.0
        for ckey in top_candidates:
            score = _similarity(doc_key, ckey)
            if score > best_score:
                best_score = score
                best_key = ckey

        if best_score >= threshold and best_key:
            return best_key, self._covers[best_key], best_score
        return None

    def __len__(self) -> int:
        return len(self._covers)


def build_calibre_index(calibre_dir: Path) -> CalibreIndex:
    """Walk CalibreLibrary and return a CalibreIndex.

    Only folders that contain a cover.jpg are indexed.
    Duplicate normalised titles keep the first occurrence.
    """
    index = CalibreIndex()
    missing_cover = 0
    total_books = 0

    for author_dir in sorted(calibre_dir.iterdir()):
        if not author_dir.is_dir():
            continue
        for book_dir in sorted(author_dir.iterdir()):
            if not book_dir.is_dir():
                continue
            total_books += 1
            cover = book_dir / "cover.jpg"
            if not cover.exists():
                missing_cover += 1
                continue
            key = _calibre_title_key(book_dir.name)
            if key:
                index.add(key, cover)

    log.info(
        "Calibre index: %d books total, %d with cover.jpg, %d without",
        total_books,
        len(index),
        missing_cover,
    )
    return index


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def get_workspaces(api_base: str, token: str) -> list[dict]:
    resp = requests.get(f"{api_base}/workspaces", headers=auth_headers(token), timeout=REQUEST_TIMEOUT)
    data = resp.json()
    # noinspection PyTypeChecker
    return data.get("workspaces", data) if isinstance(data, dict) else data


def get_collections(api_base: str, token: str, workspace_id: str) -> list[dict]:
    resp = requests.get(
        f"{api_base}/collections",
        headers=auth_headers(token),
        params={"workspace_id": workspace_id},
        timeout=REQUEST_TIMEOUT,
    )
    data = resp.json()
    # noinspection PyTypeChecker
    return data.get("collections", data) if isinstance(data, dict) else data


def get_documents(api_base: str, token: str, collection_id: str) -> list[dict]:
    resp = requests.get(
        f"{api_base}/documents/collection/{collection_id}",
        headers=auth_headers(token),
        timeout=REQUEST_TIMEOUT,
    )
    if resp.status_code != 200:
        log.warning("GET documents for collection %s → %d", collection_id, resp.status_code)
        return []
    data = resp.json()
    return data if isinstance(data, list) else data.get("documents", [])


def upload_cover(api_base: str, token: str, document_id: str, cover_path: Path) -> bool:
    """Upload ``cover_path``'s bytes as the document thumbnail."""
    return upload_thumbnail(
        api_base,
        token,
        document_id,
        cover_path.read_bytes(),
        timeout=UPLOAD_TIMEOUT,
    )


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------


def find_best_match(
    doc_key: str,
    calibre_index: CalibreIndex,
    threshold: float = MATCH_THRESHOLD,
) -> tuple[str, Path, float] | None:
    """Delegate to the CalibreIndex inverted-word lookup."""
    return calibre_index.find(doc_key, threshold)


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


def run(args: argparse.Namespace) -> None:
    calibre_dir = Path(args.calibre)
    if not calibre_dir.exists():
        raise SystemExit(f"Calibre directory not found: {calibre_dir}")

    # 1. Build Calibre index
    log.info("Scanning Calibre library at %s ...", calibre_dir)
    calibre_index = build_calibre_index(calibre_dir)
    if not len(calibre_index):
        raise SystemExit("No cover.jpg files found in Calibre library")

    # 2. Authenticate
    token = login(args.api_base, args.username, args.password)

    # 3. Walk workspaces → collections → documents
    workspaces = get_workspaces(args.api_base, token)
    log.info("Found %d workspace(s)", len(workspaces))

    uploaded = 0
    skipped_no_match = 0
    skipped_no_cover = 0
    failed = 0
    total_docs = 0

    for ws in workspaces:
        ws_id = ws.get("id") or ws.get("workspaceId")
        ws_name = ws.get("name", ws_id)
        # noinspection PyTypeChecker
        collections = get_collections(args.api_base, token, ws_id)
        log.info("Workspace '%s': %d collection(s)", ws_name, len(collections))

        for col in collections:
            col_id = col.get("id") or col.get("collectionId")
            col_name = col.get("name", col_id)
            # noinspection PyTypeChecker
            documents = get_documents(args.api_base, token, col_id)
            log.info("  Collection '%s': %d document(s)", col_name, len(documents))

            for doc in documents:
                total_docs += 1
                doc_id = doc.get("id") or doc.get("documentId")
                filename = doc.get("filename") or doc.get("file_name") or doc.get("name") or ""
                if not doc_id or not filename:
                    skipped_no_cover += 1
                    continue

                if has_custom_thumbnail(doc):
                    log.debug("  SKIP (custom thumbnail exists): %s", filename)
                    skipped_no_cover += 1
                    continue

                doc_key = _scrapalot_title_key(filename)
                match = find_best_match(doc_key, calibre_index, threshold=args.threshold)

                if match is None:
                    log.debug("  NO MATCH: %s (key=%s)", filename, doc_key)
                    skipped_no_match += 1
                    continue

                calibre_key, cover_path, score = match
                log.info(
                    "  MATCH %.0f%%: '%s' → %s",
                    score * 100,
                    filename,
                    cover_path.parent.name,
                )

                if args.dry_run:
                    uploaded += 1
                    continue

                # noinspection PyTypeChecker
                ok = upload_cover(args.api_base, token, doc_id, cover_path)
                if ok:
                    uploaded += 1
                    time.sleep(DELAY_BETWEEN_UPLOADS)
                else:
                    failed += 1

    # Summary
    print("\n" + "=" * 55)
    print("CALIBRE COVER UPLOAD COMPLETE")
    print("=" * 55)
    print(f"  Documents scanned:   {total_docs}")
    print(f"  Covers uploaded:     {uploaded}" + (" (dry run)" if args.dry_run else ""))
    print(f"  No match found:      {skipped_no_match}")
    print(f"  Skipped (no cover):  {skipped_no_cover}")
    print(f"  Upload failures:     {failed}")
    print("=" * 55)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    if sys.platform == "win32":
        os.environ.setdefault("PYTHONIOENCODING", "utf-8")
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Upload Calibre cover images to Scrapalot documents.")
    parser.add_argument(
        "--calibre",
        default=str(DEFAULT_CALIBRE_DIR),
        help=f"Path to CalibreLibrary directory (default: {DEFAULT_CALIBRE_DIR})",
    )
    parser.add_argument(
        "--api-base",
        default=DEFAULT_API_BASE,
        help=f"Scrapalot API base URL (default: {DEFAULT_API_BASE})",
    )
    parser.add_argument("--username", default=DEFAULT_USERNAME)
    parser.add_argument("--password", default=DEFAULT_PASSWORD)
    parser.add_argument(
        "--threshold",
        type=float,
        default=MATCH_THRESHOLD,
        help=f"Minimum similarity score for title matching (default: {MATCH_THRESHOLD})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show matches without uploading anything",
    )
    parser.add_argument("--verbose", action="store_true", help="Enable debug logging")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    run(args)


if __name__ == "__main__":
    main()
