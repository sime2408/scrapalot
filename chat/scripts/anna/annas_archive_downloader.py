#!/usr/bin/env python3
"""
Anna's Archive Downloader - All-in-one download tool

Features:
1. Collect MD5 hashes from Anna's Archive search results
2. Download torrents from Anna's Archive
3. Fast downloads using API (100 per 18 hours)
4. Search and download books by keywords

Usage:
    # Collect MD5 hashes from search
    python annas_archive_downloader.py collect --output hashes.txt [--max 200] [--sort newest]

    # Download by MD5 hashes
    python annas_archive_downloader.py download --md5-file hashes.txt --secret KEY --output ./books [--count 100]

    # Download torrents
    python annas_archive_downloader.py torrents --torrent-list urls.txt --output ./torrents
"""

import argparse
from pathlib import Path
import re
import time
from urllib.parse import unquote

import requests

BASE_URL = "https://annas-archive.se"
FAST_DOWNLOAD_API = f"{BASE_URL}/dyn/api/fast_download.json"

DEFAULT_KEYWORDS = [
    "spirituality consciousness",
    "metaphysics esoteric",
    "meditation mindfulness",
    "occult alchemy hermetic",
    "kabbalah theosophy mysticism",
    "chakras kundalini energy",
    "astral projection lucid dreaming",
    "shamanism sacred plant medicine",
    "gnosis tantra",
    "sacred geometry hermetic",
]


def sanitize_filename(filename: str, max_length: int = 200) -> str:
    """Sanitize filename for Windows by removing invalid characters."""
    for char in '<>:"/\\|?*':
        filename = filename.replace(char, "_")
    filename = "".join(c for c in filename if ord(c) >= 32).strip(" .")
    name_part, ext = Path(filename).stem, Path(filename).suffix
    if len(name_part) > max_length:
        name_part = name_part[:max_length]
    return f"{name_part}{ext}" if ext else name_part


# =============================================================================
# MD5 Hash Collection (merged from collect_md5_simple.py, collect_md5_hashes.py)
# =============================================================================


def collect_md5_hashes(
    output_file: Path,
    keywords: list[str] = None,
    max_hashes: int = 200,
    pages_per_query: int = 5,
    sort: str = "newest",
):
    """Collect MD5 hashes from Anna's Archive search results."""
    keywords = keywords or DEFAULT_KEYWORDS
    all_md5s: set[str] = set()

    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    session = requests.Session()
    session.headers.update(headers)

    print("=" * 80)
    print(f"MD5 HASH COLLECTION (sort={sort})")
    print("=" * 80)

    for idx, kw in enumerate(keywords, 1):
        if len(all_md5s) >= max_hashes:
            break

        print(f"\n[{idx}/{len(keywords)}] Searching: '{kw}'")

        for page in range(1, pages_per_query + 1):
            if len(all_md5s) >= max_hashes:
                break

            print(f"  Page {page}...", end=" ", flush=True)
            try:
                params = {"q": kw, "ext": "pdf", "sort": sort, "page": page}
                response = session.get(f"{BASE_URL}/search", params=params, timeout=30)
                if response.status_code == 200:
                    md5s = set(re.findall(r"/md5/([a-f0-9]{32})", response.text, re.IGNORECASE))
                    new_count = len(md5s - all_md5s)
                    all_md5s.update(md5s)
                    print(f"Found {len(md5s)} ({new_count} new) | Total: {len(all_md5s)}")
                else:
                    print(f"HTTP {response.status_code}")
            except Exception as e:
                print(f"Error: {e}")
            time.sleep(1.5)

    if all_md5s:
        output_file.parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, "w") as f:
            for md5 in sorted(all_md5s):
                f.write(f"{md5}\n")
        print(f"\nCollected {len(all_md5s)} MD5 hashes → {output_file}")
    else:
        print("\nNo MD5 hashes found!")


# =============================================================================
# Downloader
# =============================================================================


class AnnasArchiveDownloader:
    """Unified downloader for Anna's Archive."""

    def __init__(self, output_dir: Path, secret_key: str | None = None):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.secret_key = secret_key
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})

    def download_torrents(self, torrent_list_path: Path) -> int:
        """Download torrent files from a URL list."""
        if not torrent_list_path or not torrent_list_path.exists():
            print("ERROR: Torrent list file required")
            return 0

        with open(torrent_list_path) as f:
            torrent_urls = [line.strip() for line in f if line.strip()]

        downloaded = 0
        for i, url in enumerate(torrent_urls, 1):
            filename = url.split("/")[-1]
            output_path = self.output_dir / filename

            if output_path.exists():
                print(f"[{i}/{len(torrent_urls)}] SKIP: {filename}")
                continue

            try:
                print(f"[{i}/{len(torrent_urls)}] Downloading: {filename}...")
                response = self.session.get(url, timeout=30)
                if response.status_code == 200:
                    output_path.write_bytes(response.content)
                    print(f"  -> Success ({len(response.content) / 1024:.1f} KB)")
                    downloaded += 1
                else:
                    print(f"  -> Failed (HTTP {response.status_code})")
            except Exception as e:
                print(f"  -> Error: {str(e)[:50]}")
            time.sleep(0.5)

        print(f"\nDownloaded {downloaded} torrents to {self.output_dir}")
        return downloaded

    def fast_download(self, md5: str) -> Path | None:
        """Download a book using fast download API."""
        if not self.secret_key:
            raise ValueError("Secret key required for fast downloads")

        try:
            params = {"md5": md5, "key": self.secret_key, "path_index": 0, "domain_index": 0}
            api_response = self.session.get(FAST_DOWNLOAD_API, params=params, timeout=30)

            if api_response.status_code != 200:
                # noinspection PyBroadException
                try:
                    error_msg = api_response.json().get("error", "Unknown error")
                    print(f"  API HTTP {api_response.status_code}: {error_msg}", flush=True)
                except Exception:
                    print(f"  API error: HTTP {api_response.status_code}", flush=True)
                return None

            import json

            try:
                api_data = api_response.json()
            except json.JSONDecodeError as e:
                print(f"  JSON decode error: {e}")
                return None

            if not api_data.get("download_url"):
                if "error" in api_data:
                    print(f"  API error: {api_data['error']}")
                return None

            download_url = api_data["download_url"]
            raw_filename = unquote(download_url.split("/")[-1])
            filename = sanitize_filename(raw_filename) or f"{md5}.pdf"

            response = self.session.get(download_url, timeout=60, stream=True)
            if response.status_code != 200:
                return None

            if "text/html" in response.headers.get("Content-Type", ""):
                return None

            output_path = self.output_dir / filename
            with open(output_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)

            # Validate file magic bytes
            with open(output_path, "rb") as f:
                magic = f.read(10)

            if magic[:5] == b"%PDF-" or magic[:2] == b"PK" or b"BOOKMOBI" in magic[:40]:
                return output_path
            else:
                output_path.unlink()
                return None

        except Exception as e:
            print(f"  [{type(e).__name__}] {str(e)[:100]}")
            return None

    def download_from_md5_list(self, md5_file: Path, max_downloads: int | None = None) -> int:
        """Download books from a list of MD5 hashes."""
        with open(md5_file) as f:
            md5_list = [line.strip() for line in f if line.strip()]

        if max_downloads:
            md5_list = md5_list[:max_downloads]

        print("=" * 80)
        print(f"FAST DOWNLOAD FROM MD5 LIST ({len(md5_list)} hashes)")
        print("=" * 80)

        stats = {"success": 0, "failed": 0}

        for i, md5 in enumerate(md5_list, 1):
            print(f"\n[{i}/{len(md5_list)}] MD5: {md5[:8]}...")

            result = self.fast_download(md5)
            if result:
                file_size = result.stat().st_size / (1024 * 1024)
                try:
                    print(f"  -> Success: {result.name[:60]} ({file_size:.1f} MB)")
                except UnicodeEncodeError:
                    print(f"  -> Success: [Unicode filename] ({file_size:.1f} MB)")
                stats["success"] += 1
            else:
                print("  -> Failed")
                stats["failed"] += 1

            time.sleep(0.7)

            if i % 10 == 0:
                print(f"\n--- Progress: {i}/{len(md5_list)} - Success: {stats['success']}, Failed: {stats['failed']} ---")

        print(f"\n{'=' * 80}")
        print(f"Success: {stats['success']}, Failed: {stats['failed']}")
        print(f"Output: {self.output_dir}")
        return stats["success"]


# =============================================================================
# Main CLI
# =============================================================================


def main():
    parser = argparse.ArgumentParser(description="Anna's Archive Downloader")
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # Collect command
    collect_parser = subparsers.add_parser("collect", help="Collect MD5 hashes from search")
    collect_parser.add_argument("--output", type=Path, required=True, help="Output file for MD5 hashes")
    collect_parser.add_argument("--max", type=int, default=200, help="Max hashes to collect")
    collect_parser.add_argument("--sort", default="newest", help="Sort order (newest, newest_year_first)")
    collect_parser.add_argument("--pages", type=int, default=5, help="Pages per query")

    # Download command
    dl_parser = subparsers.add_parser("download", help="Download books by MD5 hash")
    dl_parser.add_argument("--md5-file", type=Path, required=True, help="File with MD5 hashes")
    dl_parser.add_argument("--secret", type=str, required=True, help="Fast download secret key")
    dl_parser.add_argument("--output", type=Path, required=True, help="Output directory")
    dl_parser.add_argument("--count", type=int, help="Max downloads")

    # Torrents command
    torr_parser = subparsers.add_parser("torrents", help="Download torrent files")
    torr_parser.add_argument("--torrent-list", type=Path, required=True, help="File with torrent URLs")
    torr_parser.add_argument("--output", type=Path, required=True, help="Output directory")

    args = parser.parse_args()

    if args.command == "collect":
        collect_md5_hashes(args.output, max_hashes=args.max, pages_per_query=args.pages, sort=args.sort)

    elif args.command == "download":
        downloader = AnnasArchiveDownloader(args.output, args.secret)
        downloader.download_from_md5_list(args.md5_file, args.count)

    elif args.command == "torrents":
        downloader = AnnasArchiveDownloader(args.output)
        downloader.download_torrents(args.torrent_list)

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
