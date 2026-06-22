#!/usr/bin/env python3
"""
Anna's Archive Book Processor - All-in-one processing tool

Features:
1. Convert DjVu files to PDF
2. Rename books with metadata from:
   - Libgen SQL database (fastest - local MD5 lookup)
   - PDF embedded metadata
   - Anna's Archive API
   - PDF content extraction (first few pages)
   - Claude Code CLI (optional)
3. Smart title/author/year detection from book content

Usage:
    # Convert DjVu to PDF
    python annas_archive_book_processor.py --convert-djvu --input "C:\\DjVu" --output "C:\\PDF"

    # Rename all books in a folder (uses libgen.db if available)
    python annas_archive_book_processor.py --rename --input "C:\\Books" --output "C:\\Books_Renamed"

    # Rename with specific libgen database
    python annas_archive_book_processor.py --rename --input "C:\\Books" --output "C:\\Books_Renamed" --libgen-db "C:\\path\\to\\libgen.db"

    # Both convert and rename
    python annas_archive_book_processor.py --convert-djvu --rename --input "C:\\DjVu" --output "C:\\Organized"

Setup for fast MD5 lookups:
    1. Download libgen SQL dump from archive.org: https://archive.org/details/libgen-20250603
    2. Extract libgen_2025-06-03.rar to get libgen.sql
    3. Convert to SQLite: python annas_archive_book_processor.py --convert-sql --sql-file "libgen.sql" --db-output "libgen.db"
    4. Use --libgen-db to specify the database path
"""

import argparse
import hashlib
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from typing import Any

import requests

# Libgen SQL database path (for fast MD5 lookups)
LIBGEN_DB_PATH = Path(r"C:\Users\SimunSunjic\Downloads\libgen.db")

try:
    from pypdf import PdfReader
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pypdf"])
    from pypdf import PdfReader

try:
    from bs4 import BeautifulSoup
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "beautifulsoup4"])
    from bs4 import BeautifulSoup

# Allow running as `python scripts/anna/annas_archive_book_processor.py`.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _metadata_sources import claude_extract_metadata  # noqa: E402

# DjVuLibre installation path
DJVULIBRE_PATH = Path(r"C:\Program Files (x86)\DjVuLibre")
DDJVU_EXE = DJVULIBRE_PATH / "ddjvu.exe"


class BookProcessor:
    """Unified processor for converting and renaming books."""

    def __init__(self, input_dir: Path, output_dir: Path, libgen_db_path: Path = None):
        self.input_dir = Path(input_dir)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.stats = {"success": 0, "failed": 0, "skipped": 0}
        self.libgen_db_path = libgen_db_path or LIBGEN_DB_PATH
        self._libgen_conn = None

    # ==================== Libgen SQL Database Lookup ====================

    @staticmethod
    def calculate_file_md5(file_path: Path) -> str:
        """Calculate MD5 hash of file content."""
        hash_md5 = hashlib.md5()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                hash_md5.update(chunk)
        return hash_md5.hexdigest().lower()

    def get_libgen_connection(self) -> sqlite3.Connection | None:
        """Get SQLite connection to libgen database (lazy loading)."""
        if self._libgen_conn is not None:
            return self._libgen_conn

        if not self.libgen_db_path.exists():
            return None

        try:
            self._libgen_conn = sqlite3.connect(str(self.libgen_db_path))
            self._libgen_conn.row_factory = sqlite3.Row
            return self._libgen_conn
        except Exception as e:
            print(f"    Warning: Could not connect to libgen DB: {e}")
            return None

    def lookup_in_libgen_db(self, md5_hash: str) -> dict | None:
        """Look up book metadata by MD5 hash in libgen database."""
        conn = self.get_libgen_connection()
        if conn is None:
            return None

        try:
            cursor = conn.cursor()
            # Query the updated table (libgen non-fiction uses 'updated' table)
            cursor.execute(
                """
                SELECT Title, Author, Year, Publisher, Extension, Language
                FROM updated
                WHERE MD5 = ? COLLATE NOCASE
                LIMIT 1
            """,
                (md5_hash,),
            )

            row = cursor.fetchone()
            if row:
                metadata = {}
                if row["Title"]:
                    metadata["title"] = row["Title"].strip()
                if row["Author"]:
                    metadata["author"] = row["Author"].strip()
                if row["Year"] and str(row["Year"]).isdigit():
                    year = int(row["Year"])
                    if 1800 <= year <= 2030:
                        metadata["year"] = str(year)
                return metadata if metadata.get("title") else None
            return None
        except sqlite3.OperationalError as e:
            # Table might not exist or have different schema
            if "no such table" in str(e).lower():
                print("    Warning: libgen DB table 'updated' not found. Run conversion first.")
            return None
        except Exception as e:
            print(f"    Warning: libgen DB lookup failed: {e}")
            return None

    # ==================== DjVu Conversion ====================

    @staticmethod
    def check_ddjvu() -> bool:
        """Check if ddjvu is available."""
        # noinspection PyBroadException
        try:
            if DDJVU_EXE.exists():
                subprocess.run([str(DDJVU_EXE), "-h"], capture_output=True, timeout=5)
                return True
        except Exception:
            pass
        # noinspection PyBroadException
        try:
            subprocess.run(["ddjvu", "-h"], capture_output=True, timeout=5)
            return True
        except Exception:
            pass
        return False

    @staticmethod
    def convert_djvu_to_pdf(djvu_path: Path, pdf_path: Path) -> bool:
        """Convert DjVu to PDF."""
        try:
            ddjvu_cmd = str(DDJVU_EXE) if DDJVU_EXE.exists() else "ddjvu"
            result = subprocess.run(
                [ddjvu_cmd, "-format=pdf", "-quality=85", str(djvu_path), str(pdf_path)], capture_output=True, text=True, timeout=300
            )
            return result.returncode == 0
        except Exception as e:
            print(f"    Conversion error: {str(e)[:50]}")
            return False

    def process_djvu_files(self) -> int:
        """Convert all DjVu files to PDF."""
        if not self.check_ddjvu():
            print("\nERROR: ddjvu not found!")
            print("Install DjVuLibre: http://djvu.sourceforge.net/")
            return 0

        files = list(self.input_dir.glob("*.djvu"))
        print(f"\nFound {len(files)} DjVu files to convert")

        for i, djvu_path in enumerate(files, 1):
            pdf_filename = djvu_path.stem + ".pdf"
            pdf_path = self.output_dir / pdf_filename

            if pdf_path.exists():
                print(f"[{i}/{len(files)}] SKIP (exists): {pdf_filename[:60]}")
                self.stats["success"] += 1
                continue

            print(f"[{i}/{len(files)}] Converting: {djvu_path.name[:60]}...")

            if self.convert_djvu_to_pdf(djvu_path, pdf_path):
                file_size = pdf_path.stat().st_size / (1024 * 1024)
                print(f"  -> Success ({file_size:.1f} MB)")
                self.stats["success"] += 1
            else:
                print("  -> Failed")
                self.stats["failed"] += 1

            if i % 50 == 0:
                print(f"\n--- Progress: {i}/{len(files)} - Success: {self.stats['success']}, Failed: {self.stats['failed']} ---\n")

        return self.stats["success"]

    # ==================== Metadata Extraction ====================

    @staticmethod
    def clean_text(text: str) -> str:
        """Clean text for filename."""
        if not text:
            return ""
        text = text.replace("\x00", "").strip()
        text = re.sub(r'[<>:"/\\|?*]', "", text)
        text = re.sub(r"\s+", " ", text)
        return text.strip()[:200]

    @staticmethod
    def extract_pdf_metadata(file_path: Path) -> dict | None:
        """Extract metadata from PDF embedded metadata."""
        # noinspection PyBroadException
        try:
            reader = PdfReader(file_path)
            meta = reader.metadata
            if not meta:
                return None

            metadata: dict[str, Any] = {"title": None, "author": None, "year": None}

            if meta.get("/Title"):
                title = str(meta["/Title"])
                if title and len(title) > 3 and not title.startswith("Microsoft"):
                    metadata["title"] = title

            if meta.get("/Author"):
                author = str(meta["/Author"])
                if author and len(author) > 2 and author not in ["Unknown", "Admin", "User"]:
                    metadata["author"] = author

            for date_field in ["/CreationDate", "/ModDate"]:
                if meta.get(date_field):
                    date_str = str(meta[date_field])
                    year_match = re.search(r"D:(\d{4})", date_str)
                    if year_match:
                        year = int(year_match.group(1))
                        if 1900 <= year <= 2030:
                            metadata["year"] = str(year)
                            break

            return metadata if metadata["title"] or metadata["author"] else None
        except Exception:
            return None

    @staticmethod
    def extract_pdf_content(file_path: Path, max_pages: int = 5) -> dict | None:
        """Extract title/author/year from PDF content (first few pages)."""
        # noinspection PyBroadException
        try:
            reader = PdfReader(file_path)

            # Collect text from first few pages
            text = ""
            for i in range(min(max_pages, len(reader.pages))):
                # noinspection PyBroadException
                try:
                    page_text = reader.pages[i].extract_text()
                    if page_text:
                        text += page_text + "\n"
                except Exception:
                    continue

            if not text or len(text) < 50:
                return None

            metadata: dict[str, Any] = {"title": None, "author": None, "year": None}

            # Extract title (usually largest text on first page)
            lines = [line.strip() for line in text.split("\n") if line.strip()]

            # Look for title patterns
            for line in lines[:20]:  # Check first 20 lines
                # Skip very short lines, URLs, copyright notices
                if len(line) < 10 or len(line) > 150:
                    continue
                if any(skip in line.lower() for skip in ["http", "www.", "©", "copyright", "isbn"]):
                    continue

                # Likely title if it's titlecased or all caps
                if line.istitle() or line.isupper():
                    metadata["title"] = line
                    break

            # Extract author - look for common patterns
            author_patterns = [
                r"(?:by|By|BY)\s+([A-Z][a-zA-Z\s\.]+)",
                r"([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*$",  # Name at end of line
                r"^([A-Z][a-z]+\s+[A-Z]\.\s+[A-Z][a-z]+)",  # John R. Smith
            ]

            for pattern in author_patterns:
                match = re.search(pattern, text[:1000], re.MULTILINE)
                if match:
                    author = match.group(1).strip()
                    if len(author) > 5 and len(author) < 50:
                        metadata["author"] = author
                        break

            # Extract year
            year_patterns = [
                r"(?:©|Copyright|Published)\s*(\d{4})",
                r"(?:First published|Edition)\s*(\d{4})",
                r"\b(19\d{2}|20[0-2]\d)\b",  # Any 4-digit year
            ]

            for pattern in year_patterns:
                match = re.search(pattern, text[:2000])
                if match:
                    year = int(match.group(1))
                    if 1900 <= year <= 2030:
                        metadata["year"] = str(year)
                        break

            return metadata if metadata["title"] else None

        except Exception as e:
            print(f"    Content extraction error: {str(e)[:50]}")
            return None

    @staticmethod
    def query_annas_archive_api(hash_str: str) -> dict | None:
        """Query Anna's Archive for metadata."""
        # noinspection PyBroadException
        try:
            url = f"https://annas-archive.org/md5/{hash_str}"
            response = requests.get(url, timeout=10)

            if response.status_code != 200:
                return None

            soup = BeautifulSoup(response.text, "html.parser")
            # noinspection PyTypeChecker
            metadata: dict[str, Any] = {"title": None, "author": None, "year": None}

            # Extract title
            title_tag = soup.find("title")
            if title_tag:
                title_text = title_tag.get_text()
                if " - Anna's Archive" in title_text:
                    metadata["title"] = title_text.split(" - Anna's Archive")[0].strip()

            # Extract author and year from page content
            divs = soup.find_all("div", class_="mb-4")
            for div in divs:
                text = div.get_text()

                if "Author" in text or "author" in text:
                    author_match = re.search(r"(?:Author|author)[:\s]*([^\n]+)", text)
                    if author_match and not metadata["author"]:
                        metadata["author"] = author_match.group(1).strip()

                if "Year" in text or "year" in text or "Publisher" in text:
                    year_match = re.search(r"(\d{4})", text)
                    if year_match and not metadata["year"]:
                        year = int(year_match.group(1))
                        if 1900 <= year <= 2030:
                            metadata["year"] = str(year)

            return metadata if metadata["title"] else None

        except Exception:
            return None

    @staticmethod
    def extract_hash_from_filename(filename: str) -> str | None:
        """Extract MD5 hash from filename."""
        # Pattern: Book_{hash} or just {hash}
        match = re.search(r"Book_([a-f0-9]{12,})", filename)
        if match:
            return match.group(1)

        match = re.search(r"([a-f0-9]{32})", filename)
        if match:
            return match.group(1)

        return None

    @staticmethod
    def needs_renaming(filename: str) -> bool:
        """Check if file needs better metadata."""
        if "Unknown" not in filename and "Book_" not in filename:
            if re.match(r"^\(\d{4}\) [A-Za-z]{2,}", filename):
                return False
        return True

    @staticmethod
    def extract_with_claude(file_path: Path) -> dict | None:
        """Extract metadata using Claude Code CLI."""
        print("    Using Claude Code...")
        return claude_extract_metadata(
            file_path,
            on_message=lambda msg: print(f"  {msg}"),
        )

    def get_metadata(self, file_path: Path, use_claude: bool = False) -> dict | None:
        """Get metadata using all available methods."""

        # Method 1: Libgen SQL Database (fastest - local lookup by MD5)
        if self.libgen_db_path.exists():
            print("    Calculating MD5 hash...")
            md5_hash = self.calculate_file_md5(file_path)
            print(f"    Trying Libgen DB (MD5: {md5_hash[:8]}...)...")
            metadata = self.lookup_in_libgen_db(md5_hash)
            if metadata and metadata.get("title"):
                print("    -> Found in Libgen DB!")
                return metadata

        # Method 2: PDF embedded metadata
        print("    Trying PDF metadata...")
        metadata = self.extract_pdf_metadata(file_path)
        if metadata and metadata.get("title"):
            print("    -> Found in PDF metadata!")
            return metadata

        # Method 3: Anna's Archive API (if hash in filename)
        hash_str = self.extract_hash_from_filename(file_path.name)
        if hash_str:
            print(f"    Trying API (MD5: {hash_str[:8]}...)...")
            metadata = self.query_annas_archive_api(hash_str)
            if metadata and metadata.get("title"):
                print("    -> Found via API!")
                time.sleep(0.7)  # Rate limiting
                return metadata

        # Method 4: Extract from PDF content (first few pages)
        print("    Reading PDF content...")
        metadata = self.extract_pdf_content(file_path)
        if metadata and metadata.get("title"):
            print("    -> Found in PDF content!")
            return metadata

        # Method 5: Claude Code (if enabled)
        if use_claude:
            metadata = self.extract_with_claude(file_path)
            if metadata and metadata.get("title"):
                print("    -> Found via Claude!")
                return metadata

        return None

    # ==================== File Type Detection ====================

    @staticmethod
    def detect_file_type(file_path: Path) -> str | None:
        """Detect file type and return appropriate extension."""
        try:
            # Read first few bytes to detect file type
            with open(file_path, "rb") as f:
                header = f.read(32)

            # PDF signature
            if header.startswith(b"%PDF"):
                return "pdf"

            # DjVu signature (check for AT&T in the header)
            if b"AT&T" in header[:8]:
                return "djvu"

            # EPUB signature (ZIP file starting with PK)
            if header.startswith(b"PK\x03\x04"):
                # Read more to check if it's an EPUB
                with open(file_path, "rb") as f:
                    f.seek(0)
                    data = f.read(1024)
                    if b"mimetype" in data and b"epub" in data:
                        return "epub"

        except Exception as e:
            print(f" [ERROR: {str(e)[:30]}]", flush=True)
            return None

        return None

    # ==================== Book Renaming ====================

    def process_rename_files(self, use_claude: bool = False, start_index: int = 0, batch_size: int = None) -> int:
        """Rename all books in directory."""
        # Get all files (including those without extensions)
        print(f"Scanning directory: {self.input_dir}")
        all_files = []
        file_count = 0
        for file_path in self.input_dir.iterdir():
            if file_path.is_file():
                file_count += 1
                try:
                    print(f"  Checking file {file_count}: {file_path.name[:50]}...", end="", flush=True)
                except UnicodeEncodeError:
                    print(f"  Checking file {file_count}: [Unicode filename]...", end="", flush=True)
                # Detect if it's a book file
                try:
                    file_ext = self.detect_file_type(file_path)
                    if file_ext in ["pdf", "djvu", "epub"]:
                        all_files.append((file_path, file_ext))
                        print(f" -> {file_ext.upper()}", flush=True)
                    else:
                        print(" -> Skipped", flush=True)
                except Exception as e:
                    print(f" [EXCEPTION: {str(e)[:40]}]", flush=True)

        print(f"Scanned {file_count} files total.")

        files_to_rename = [(f, ext) for f, ext in all_files if self.needs_renaming(f.name)]

        print(f"\nTotal book files found: {len(all_files)}")
        print(f"  PDF: {sum(1 for _, ext in all_files if ext == 'pdf')}")
        print(f"  DjVu: {sum(1 for _, ext in all_files if ext == 'djvu')}")
        print(f"  EPUB: {sum(1 for _, ext in all_files if ext == 'epub')}")
        print(f"Files needing renaming: {len(files_to_rename)}")

        # Apply batch slicing if specified
        if batch_size:
            end_index = min(start_index + batch_size, len(files_to_rename))
            files_to_rename = files_to_rename[start_index:end_index]
            print(f"Batch processing: files {start_index} to {end_index - 1} ({len(files_to_rename)} files)")

        if use_claude:
            print("Claude Code: ENABLED")
        print("\nStarting metadata extraction...\n")

        for i, (file_path, file_ext) in enumerate(files_to_rename, 1):
            filename = file_path.name

            try:
                print(f"[{i}/{len(files_to_rename)}] {filename[:70]} ({file_ext.upper()})")
            except UnicodeEncodeError:
                print(f"[{i}/{len(files_to_rename)}] [File with special characters] ({file_ext.upper()})")

            # Handle DjVu files - convert to PDF for metadata extraction
            temp_pdf_path = None
            metadata_source = file_path

            if file_ext == "djvu":
                print("  -> Converting DjVu to temp PDF for metadata extraction...")
                temp_pdf_path = self.output_dir / f"temp_{file_path.name}.pdf"
                if self.convert_djvu_to_pdf(file_path, temp_pdf_path):
                    metadata_source = temp_pdf_path
                else:
                    print("  -> DjVu conversion failed, skipping")
                    self.stats["failed"] += 1
                    continue

            # Get metadata (only works for PDF files)
            metadata = None
            if file_ext in ["pdf"] or temp_pdf_path:
                metadata = self.get_metadata(metadata_source, use_claude=use_claude)

            # Clean up temp PDF
            if temp_pdf_path and temp_pdf_path.exists():
                temp_pdf_path.unlink()

            if not metadata:
                print("  -> No metadata found, keeping original name")
                self.stats["failed"] += 1
                continue

            # Extract current year if exists
            year_match = re.match(r"^\((\d{4})\)", filename)
            current_year = year_match.group(1) if year_match else None

            # Create new filename with correct extension
            year = self.clean_text(metadata.get("year") or current_year or "Unknown Year")
            author = self.clean_text(metadata.get("author") or "Unknown Author")
            title = self.clean_text(metadata.get("title") or filename)

            # Check if this is actually better than current name
            if author == "Unknown Author" and "Unknown Author" in filename:
                print("  -> No improvement, keeping original")
                self.stats["skipped"] += 1
                continue

            new_filename = f"({year}) {author} - {title}.{file_ext}"
            new_path = self.output_dir / new_filename

            # Handle duplicates
            counter = 1
            while new_path.exists():
                new_path = self.output_dir / f"({year}) {author} - {title} ({counter}).pdf"
                counter += 1

            # Copy file
            try:
                shutil.copy2(file_path, new_path)
                try:
                    print(f"  -> ({year}) {author} - {title[:40]}...")
                except UnicodeEncodeError:
                    print("  -> Renamed successfully")
                self.stats["success"] += 1
            except Exception as e:
                print(f"  -> ERROR: {str(e)[:50]}")
                self.stats["failed"] += 1

            # Progress checkpoint
            if i % 50 == 0:
                print(f"\n--- Checkpoint: {i}/{len(files_to_rename)} processed ---")
                print(f"    Success: {self.stats['success']}, Failed: {self.stats['failed']}, Skipped: {self.stats['skipped']}\n")

        return self.stats["success"]

    def print_summary(self):
        """Print processing summary."""
        print(f"\n{'=' * 80}")
        print("PROCESSING COMPLETE")
        print(f"{'=' * 80}")
        print(f"Success: {self.stats['success']}")
        print(f"Skipped (no improvement): {self.stats['skipped']}")
        print(f"Failed: {self.stats['failed']}")
        print(f"Output: {self.output_dir}")
        print(f"{'=' * 80}")


def convert_sql_to_sqlite(sql_file: Path, db_output: Path):
    """Convert libgen SQL dump to SQLite database for fast lookups."""
    import re

    print(f"Converting {sql_file} to SQLite...")
    print(f"Output: {db_output}")

    # Remove existing database
    if db_output.exists():
        db_output.unlink()

    conn = sqlite3.connect(str(db_output))
    cursor = conn.cursor()

    # Create optimized table for lookups
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS updated (
            ID INTEGER PRIMARY KEY,
            Title TEXT,
            Author TEXT,
            Year TEXT,
            Publisher TEXT,
            Extension TEXT,
            MD5 TEXT,
            Language TEXT
        )
    """)

    # Create index on MD5 for fast lookups
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_md5 ON updated(MD5 COLLATE NOCASE)")

    print("Reading SQL dump (this may take a while for large files)...")

    insert_count = 0
    batch = []
    batch_size = 10000

    # Pattern to match INSERT statements
    insert_pattern = re.compile(r"INSERT INTO `updated` VALUES\s*\((.+?)\);", re.IGNORECASE | re.DOTALL)

    # Read and process the SQL file
    with open(sql_file, encoding="utf-8", errors="replace") as f:
        content = ""
        for line in f:
            content += line
            if line.strip().endswith(";"):
                # Try to find INSERT statements
                for match in insert_pattern.finditer(content):
                    values_str = match.group(1)
                    # Parse values (this is simplified - real SQL parsing is complex)
                    # noinspection PyBroadException
                    try:
                        # Split by '),(' for multiple value sets
                        value_sets = re.split(r"\),\s*\(", values_str)
                        for value_set in value_sets:
                            value_set = value_set.strip("()")
                            # Parse individual values
                            values = parse_sql_values(value_set)
                            if len(values) >= 22:  # libgen updated table has 22+ columns
                                # Extract: ID(0), Title(1), Author(5), Year(4), Publisher(7), Extension(12), MD5(9), Language(11)
                                try:
                                    batch.append(
                                        (
                                            values[0] if values[0] else None,  # ID
                                            values[1] if len(values) > 1 else None,  # Title
                                            values[5] if len(values) > 5 else None,  # Author
                                            values[4] if len(values) > 4 else None,  # Year
                                            values[7] if len(values) > 7 else None,  # Publisher
                                            values[12] if len(values) > 12 else None,  # Extension
                                            values[9] if len(values) > 9 else None,  # MD5
                                            values[11] if len(values) > 11 else None,  # Language
                                        )
                                    )
                                except IndexError:
                                    pass

                            if len(batch) >= batch_size:
                                cursor.executemany("INSERT OR IGNORE INTO updated VALUES (?, ?, ?, ?, ?, ?, ?, ?)", batch)
                                conn.commit()
                                insert_count += len(batch)
                                print(f"  Inserted {insert_count:,} records...")
                                batch = []
                    except Exception:
                        pass

                content = ""

    # Insert remaining batch
    if batch:
        cursor.executemany("INSERT OR IGNORE INTO updated VALUES (?, ?, ?, ?, ?, ?, ?, ?)", batch)
        conn.commit()
        insert_count += len(batch)

    print(f"\nConversion complete! Total records: {insert_count:,}")

    # Verify
    cursor.execute("SELECT COUNT(*) FROM updated")
    count = cursor.fetchone()[0]
    print(f"Verified records in database: {count:,}")

    conn.close()


def parse_sql_values(value_str: str) -> list[str]:
    """Parse SQL values from a string, handling quoted strings and escapes."""
    values = []
    current = ""
    in_quotes = False
    escape_next = False

    for char in value_str:
        if escape_next:
            current += char
            escape_next = False
        elif char == "\\":
            escape_next = True
        elif char == "'" and not in_quotes:
            in_quotes = True
        elif char == "'" and in_quotes:
            in_quotes = False
        elif char == "," and not in_quotes:
            val = current.strip().strip("'")
            values.append(val if val and val.upper() != "NULL" else None)
            current = ""
        else:
            current += char

    # Last value
    if current:
        val = current.strip().strip("'")
        values.append(val if val and val.upper() != "NULL" else None)

    return values


def main():
    parser = argparse.ArgumentParser(description="Anna's Archive Book Processor")
    parser.add_argument("--convert-djvu", action="store_true", help="Convert DjVu files to PDF")
    parser.add_argument("--rename", action="store_true", help="Rename books with metadata")
    parser.add_argument("--use-claude", action="store_true", help="Use Claude Code for metadata extraction")
    parser.add_argument("--input", type=Path, help="Input directory")
    parser.add_argument("--output", type=Path, help="Output directory")
    parser.add_argument("--max-files", type=int, help="Max files to process (for testing)")
    parser.add_argument("--start-index", type=int, default=0, help="Start index for batch processing")
    parser.add_argument("--batch-size", type=int, help="Number of files to process in this batch")
    parser.add_argument("--libgen-db", type=Path, help="Path to libgen SQLite database for MD5 lookups")
    parser.add_argument("--convert-sql", action="store_true", help="Convert libgen SQL dump to SQLite")
    parser.add_argument("--sql-file", type=Path, help="Input SQL file for conversion")
    parser.add_argument("--db-output", type=Path, help="Output SQLite database path")

    args = parser.parse_args()

    # Handle SQL to SQLite conversion
    if args.convert_sql:
        if not args.sql_file or not args.db_output:
            print("ERROR: --convert-sql requires --sql-file and --db-output")
            return
        convert_sql_to_sqlite(args.sql_file, args.db_output)
        return

    # Require input/output for other operations
    if not args.input or not args.output:
        parser.print_help()
        return

    print("=" * 80)
    print("ANNA'S ARCHIVE BOOK PROCESSOR")
    print("=" * 80)
    print(f"Input: {args.input}")
    print(f"Output: {args.output}")
    if args.libgen_db:
        print(f"Libgen DB: {args.libgen_db}")
    print("=" * 80)

    processor = BookProcessor(args.input, args.output, libgen_db_path=args.libgen_db)

    if args.convert_djvu:
        print("\n>>> CONVERTING DJVU TO PDF <<<")
        processor.process_djvu_files()

    if args.rename:
        print("\n>>> RENAMING BOOKS <<<")
        processor.process_rename_files(use_claude=args.use_claude, start_index=args.start_index, batch_size=args.batch_size)

    if not args.convert_djvu and not args.rename:
        parser.print_help()
        return

    processor.print_summary()


if __name__ == "__main__":
    main()
