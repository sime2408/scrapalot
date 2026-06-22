#!/usr/bin/env python3
"""Multi-source metadata extraction with fallback chain and analysis.

Extraction order:
1. ISBN from PDF → Open Library / Google Books
2. PDF embedded metadata
3. Anna's Archive API (if MD5 hash in filename)
4. PDF content analysis (first 3 pages)
5. Claude Code CLI (if enabled)

Usage:
    # Extract and rename MD5-named PDFs
    python multi_source_metadata_extractor.py extract --input "C:\\Books" [--use-claude] [--google-api-key KEY] [--limit N]

    # Analyze filenames to see what still needs renaming
    python multi_source_metadata_extractor.py analyze --input "C:\\Books"
"""

import argparse
from pathlib import Path
import re
import subprocess
import sys
import time

import requests

try:
    from pypdf import PdfReader
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pypdf"])
    from pypdf import PdfReader

# Allow running as `python scripts/anna/multi_source_metadata_extractor.py`.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _metadata_sources import (  # noqa: E402
    claude_extract_metadata,
    parse_year_from_string,
    read_pdf_first_pages_text,
    safe_print,
)


class MultiSourceMetadataExtractor:
    """Extract book metadata from multiple sources with fallback."""

    def __init__(self, google_api_key: str | None = None):
        self.google_api_key = google_api_key
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
        self.stats = {
            "isbn_openlibrary": 0,
            "isbn_google": 0,
            "pdf_metadata": 0,
            "annas_api": 0,
            "pdf_content": 0,
            "claude_code": 0,
            "failed": 0,
            "renamed": 0,
        }

    # ========== ISBN Extraction ==========

    @staticmethod
    def extract_isbn_from_pdf(pdf_path: Path) -> str | None:
        """Extract ISBN from first 3 pages of PDF."""
        text = read_pdf_first_pages_text(pdf_path, max_pages=3)
        if not text:
            return None

        isbn13_pattern = r"ISBN[-\s]?(?:13)?[-:\s]*(?:97[89])[-\s]?\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,7}[-\s]?\d"
        match = re.search(isbn13_pattern, text, re.IGNORECASE)
        if match:
            isbn = re.sub(r"[^\d]", "", match.group())
            return isbn if len(isbn) == 13 else None

        isbn10_pattern = r"ISBN[-\s]?(?:10)?[-:\s]*\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,7}[-\s]?[\dX]"
        match = re.search(isbn10_pattern, text, re.IGNORECASE)
        if match:
            isbn = re.sub(r"[^\dX]", "", match.group().upper())
            return isbn if len(isbn) == 10 else None

        return None

    # ========== Open Library API ==========

    def lookup_openlibrary(self, isbn: str) -> dict | None:
        """Lookup book metadata using Open Library API."""
        try:
            url = f"https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data"
            response = self.session.get(url, timeout=10)

            if response.status_code == 200:
                data = response.json()
                key = f"ISBN:{isbn}"

                if key in data:
                    book = data[key]
                    title = book.get("title", "")
                    authors = book.get("authors", [])
                    author = authors[0]["name"] if authors else None

                    year = None
                    publish_date = book.get("publish_date", "")
                    year_match = re.search(r"\b(19|20)\d{2}\b", publish_date)
                    if year_match:
                        year = year_match.group()

                    if title:
                        return {"title": title, "author": author or "Unknown Author", "year": year or "Unknown Year", "source": "OpenLibrary"}

        except Exception as e:
            safe_print(f"  OpenLibrary error: {e}")

        return None

    # ========== Google Books API ==========

    def lookup_google_books(self, isbn: str) -> dict | None:
        """Lookup book metadata using Google Books API."""
        if not self.google_api_key:
            return None

        try:
            url = "https://www.googleapis.com/books/v1/volumes"
            params = {"q": f"isbn:{isbn}", "key": self.google_api_key}
            response = self.session.get(url, params=params, timeout=10)

            if response.status_code == 200:
                data = response.json()
                items = data.get("items", [])

                if items:
                    volume_info = items[0].get("volumeInfo", {})
                    title = volume_info.get("title")
                    authors = volume_info.get("authors", [])
                    published_date = volume_info.get("publishedDate", "")

                    year = None
                    year_match = re.search(r"\b(19|20)\d{2}\b", published_date)
                    if year_match:
                        year = year_match.group()

                    if title:
                        return {
                            "title": title,
                            "author": authors[0] if authors else "Unknown Author",
                            "year": year or "Unknown Year",
                            "source": "GoogleBooks",
                        }

        except Exception as e:
            safe_print(f"  Google Books error: {e}")

        return None

    # ========== PDF Embedded Metadata ==========

    @staticmethod
    def extract_pdf_metadata(pdf_path: Path) -> dict | None:
        """Extract metadata from PDF embedded properties."""
        try:
            reader = PdfReader(pdf_path)
            metadata = reader.metadata

            if metadata:
                title = metadata.get("/Title", "").strip()
                author = metadata.get("/Author", "").strip()
                year = None

                # Try to extract year from creation date
                creation_date = metadata.get("/CreationDate", "")
                year_match = re.search(r"(19|20)\d{2}", str(creation_date))
                if year_match:
                    year = year_match.group()

                if title and len(title) > 3:
                    return {"title": title, "author": author or "Unknown Author", "year": year or "Unknown Year", "source": "PDF-Metadata"}

        except Exception as e:
            safe_print(f"  PDF metadata error: {e}")

        return None

    # ========== Anna's Archive API ==========

    @staticmethod
    def query_annas_archive_api(_md5_hash: str) -> dict | None:
        """Query Anna's Archive API for book metadata."""
        # DISABLED: HTML parsing too unreliable, returns malformed data
        # The fast download API already confirmed most hashes don't exist
        return None

    # ========== PDF Content Analysis ==========

    @staticmethod
    def extract_pdf_content(pdf_path: Path) -> dict | None:
        """Extract metadata from PDF content (first 3 pages)."""
        text = read_pdf_first_pages_text(pdf_path, max_pages=3)
        if len(text) < 100:
            return None

        lines = [line.strip() for line in text.split("\n") if line.strip()]
        title = lines[0] if lines else None

        author = None
        for line in lines[:10]:
            m = re.match(r"^by\s+(.+)", line, re.IGNORECASE)
            if m:
                author = m.group(1)
                break

        year = parse_year_from_string(text)

        if title and len(title) > 5:
            return {
                "title": title[:100],
                "author": author or "Unknown Author",
                "year": year or "Unknown Year",
                "source": "PDF-Content",
            }
        return None

    # ========== Claude Code CLI ==========

    @staticmethod
    def extract_with_claude(file_path: Path) -> dict | None:
        """Extract metadata using Claude Code CLI."""
        safe_print("  Using Claude Code...")
        metadata = claude_extract_metadata(file_path, on_message=safe_print)
        if metadata:
            metadata["source"] = "Claude-Code"
        return metadata

    # ========== Main Extraction Pipeline ==========

    def get_metadata(self, pdf_path: Path, use_claude: bool = False) -> dict | None:
        """Get metadata using all available sources with fallback chain."""
        # Method 1: ISBN → Open Library / Google Books
        safe_print("  [1/5] Extracting ISBN...")
        isbn = self.extract_isbn_from_pdf(pdf_path)

        if isbn:
            safe_print(f"  Found ISBN: {isbn}")

            # Try Open Library first (free)
            safe_print("  [2/5] Querying Open Library...")
            metadata = self.lookup_openlibrary(isbn)
            if metadata:
                self.stats["isbn_openlibrary"] += 1
                return metadata

            # Try Google Books (if API key available)
            if self.google_api_key:
                safe_print("  [3/5] Querying Google Books...")
                metadata = self.lookup_google_books(isbn)
                if metadata:
                    self.stats["isbn_google"] += 1
                    return metadata

        # Method 2: PDF embedded metadata
        safe_print("  [2/5] Reading PDF metadata...")
        metadata = self.extract_pdf_metadata(pdf_path)
        if metadata:
            self.stats["pdf_metadata"] += 1
            return metadata

        # Method 3: Anna's Archive API (if MD5 in filename)
        md5_match = re.match(r"^([a-f0-9]{32})\.pdf$", pdf_path.name)
        if md5_match:
            md5_hash = md5_match.group(1)
            safe_print("  [3/5] Querying Anna's Archive API...")
            metadata = self.query_annas_archive_api(md5_hash)
            if metadata:
                self.stats["annas_api"] += 1
                time.sleep(0.7)  # Rate limiting
                return metadata

        # Method 4: PDF content analysis
        safe_print("  [4/5] Analyzing PDF content...")
        metadata = self.extract_pdf_content(pdf_path)
        if metadata:
            self.stats["pdf_content"] += 1
            return metadata

        # Method 5: Claude Code (if enabled)
        if use_claude:
            safe_print("  [5/5] Using Claude Code...")
            metadata = self.extract_with_claude(pdf_path)
            if metadata:
                self.stats["claude_code"] += 1
                return metadata

        return None

    # ========== File Processing ==========

    @staticmethod
    def sanitize_filename(text: str, max_length: int = 100) -> str:
        """Clean text for use in filename."""
        # Remove invalid characters
        text = re.sub(r'[<>:"/\\|?*]', "", text)
        # Remove control characters
        text = "".join(c for c in text if ord(c) >= 32)
        # Limit length
        return text[:max_length].strip(" .")

    def create_filename(self, metadata: dict) -> str:
        """Create standardized filename from metadata."""
        year = metadata.get("year", "Unknown Year")
        author = self.sanitize_filename(metadata.get("author", "Unknown Author"))
        title = self.sanitize_filename(metadata.get("title", "Untitled"))

        return f"({year}) {author} - {title}.pdf"

    def process_folder(self, input_dir: Path, use_claude: bool = False, limit: int | None = None):
        """Process all MD5-named PDFs in folder."""
        md5_pattern = re.compile(r"^[a-f0-9]{32}$")
        pdf_files = [f for f in input_dir.glob("*.pdf") if md5_pattern.match(f.stem)]

        if limit:
            pdf_files = pdf_files[:limit]

        safe_print("=" * 80)
        safe_print("MULTI-SOURCE METADATA EXTRACTION")
        safe_print("=" * 80)
        safe_print(f"\nFiles to process: {len(pdf_files)}")
        safe_print(f"Claude Code: {'ENABLED' if use_claude else 'DISABLED'}")
        safe_print(f"Google Books API: {'ENABLED' if self.google_api_key else 'DISABLED'}")
        safe_print("\n" + "=" * 80)

        for i, pdf_file in enumerate(pdf_files, 1):
            safe_print(f"\n[{i}/{len(pdf_files)}] {pdf_file.name}")

            metadata = self.get_metadata(pdf_file, use_claude=use_claude)

            if metadata:
                new_filename = self.create_filename(metadata)
                new_path = input_dir / new_filename

                # Handle duplicate filenames
                counter = 1
                while new_path.exists() and new_path != pdf_file:
                    stem = Path(new_filename).stem
                    new_filename = f"{stem} ({counter}).pdf"
                    new_path = input_dir / new_filename
                    counter += 1

                try:
                    pdf_file.rename(new_path)
                    safe_print(f"  ✓ Renamed: {new_filename[:70]}")
                    safe_print(f"  Source: {metadata['source']}")
                    self.stats["renamed"] += 1
                except Exception as e:
                    safe_print(f"  ✗ Rename failed: {e}")
                    self.stats["failed"] += 1
            else:
                safe_print("  ✗ No metadata found")
                self.stats["failed"] += 1

            time.sleep(0.5)  # Rate limiting

        # Final summary
        safe_print("\n" + "=" * 80)
        safe_print("EXTRACTION COMPLETE")
        safe_print("=" * 80)
        safe_print(f"Total processed: {len(pdf_files)}")
        safe_print(f"  Successfully renamed: {self.stats['renamed']}")
        safe_print(f"  Failed: {self.stats['failed']}")
        safe_print("\nSources used:")
        safe_print(f"  ISBN + Open Library: {self.stats['isbn_openlibrary']}")
        safe_print(f"  ISBN + Google Books: {self.stats['isbn_google']}")
        safe_print(f"  PDF Metadata: {self.stats['pdf_metadata']}")
        safe_print(f"  Anna's Archive API: {self.stats['annas_api']}")
        safe_print(f"  PDF Content: {self.stats['pdf_content']}")
        safe_print(f"  Claude Code: {self.stats['claude_code']}")
        safe_print(f"\nSuccess rate: {self.stats['renamed'] / len(pdf_files) * 100:.1f}%")
        safe_print("=" * 80)


def analyze_filenames(input_dir: Path):
    """Analyze book filenames to see what still needs renaming.

    Merged from: analyze_book_names.py
    """
    pdf_files = list(input_dir.glob("*.pdf"))
    md5_pattern = re.compile(r"^[a-f0-9]{32}$")
    renamed_pattern = re.compile(r"^\(\d{4}\)|^\(Unknown Year\)")

    md5_names = []
    renamed_proper = []
    renamed_unknown = []
    other_names = []

    for pdf in pdf_files:
        if md5_pattern.match(pdf.stem):
            md5_names.append(pdf)
        elif renamed_pattern.match(pdf.stem):
            if "Unknown" in pdf.stem:
                renamed_unknown.append(pdf)
            else:
                renamed_proper.append(pdf)
        else:
            other_names.append(pdf)

    total = len(pdf_files)
    safe_print("=" * 80)
    safe_print("BOOK COLLECTION NAMING ANALYSIS")
    safe_print("=" * 80)
    safe_print(f"\nTotal PDFs: {total}")
    safe_print(f"\n{'Category':<30} {'Count':<10} {'%'}")
    safe_print("-" * 60)

    for label, items in [
        ("Properly renamed", renamed_proper),
        ("Renamed (Unknown Author)", renamed_unknown),
        ("MD5 hash names (need work)", md5_names),
        ("Other names", other_names),
    ]:
        pct = len(items) / total * 100 if total else 0
        safe_print(f"{label:<30} {len(items):<10} {pct:.1f}%")

    if md5_names:
        safe_print("\nMD5 hash names (first 10):")
        for pdf in md5_names[:10]:
            safe_print(f"  {pdf.name}")

    if other_names:
        safe_print("\nOther names (first 10):")
        for pdf in other_names[:10]:
            safe_print(f"  {pdf.name}")

    safe_print(f"\n{len(md5_names)} books still have MD5 hash names and need metadata.")


def main():
    parser = argparse.ArgumentParser(description="Multi-source metadata extraction and analysis")
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # Extract command
    extract_parser = subparsers.add_parser("extract", help="Extract metadata and rename PDFs")
    extract_parser.add_argument("--input", type=Path, required=True, help="Input directory with PDFs")
    extract_parser.add_argument("--use-claude", action="store_true", help="Enable Claude Code extraction")
    extract_parser.add_argument("--google-api-key", type=str, help="Google Books API key")
    extract_parser.add_argument("--limit", type=int, help="Limit number of files to process")

    # Analyze command
    analyze_parser = subparsers.add_parser("analyze", help="Analyze filenames to see what needs renaming")
    analyze_parser.add_argument("--input", type=Path, required=True, help="Input directory with PDFs")

    args = parser.parse_args()

    if args.command == "extract":
        extractor = MultiSourceMetadataExtractor(google_api_key=args.google_api_key)
        extractor.process_folder(args.input, use_claude=args.use_claude, limit=args.limit)
    elif args.command == "analyze":
        analyze_filenames(args.input)
    else:
        # Backward compatibility: if --input is provided without subcommand
        if hasattr(args, "input") and args.input:
            extractor = MultiSourceMetadataExtractor(google_api_key=getattr(args, "google_api_key", None))
            extractor.process_folder(args.input, use_claude=getattr(args, "use_claude", False), limit=getattr(args, "limit", None))
        else:
            parser.print_help()


if __name__ == "__main__":
    main()
