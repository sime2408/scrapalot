"""
Thumbnail Service — single canonical thumbnail per document.

We render exactly one PNG per doc (256×360, "large"). The frontend
always requests `?size=large`; smaller list/grid surfaces letterbox the
same image at the CSS layer. The earlier 3-size tree (small/medium/
large) tripled disk usage and tripled the chance any one render would
silently fail without a visible win.

This module handles:
- Automatic PDF cover page extraction using PyMuPDF
- Automatic EPUB cover image extraction using ebooklib
- Custom thumbnail upload support
"""
# noinspection PyUnresolvedReferences

import io
import os
from typing import Any

# noinspection PyPep8Naming
import xml.etree.ElementTree as ET

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# Open Library is a slow external dependency reached over the public internet.
# DownloadBookCover runs inside a gRPC call with a ~15s channel deadline, so the
# TOTAL time spent talking to OL must stay well under that — otherwise the
# backend's gRPC resilience interceptor times out and retries the same slow
# call, producing DEADLINE_EXCEEDED storms for cover-less books. Keep the
# per-request timeout short and cap the title search's cumulative wall-clock
# across its multiple candidate queries.
_OL_HTTP_TIMEOUT_SECONDS = 5
_OL_TITLE_SEARCH_BUDGET_SECONDS = 9.0


# Lazy load PyMuPDF to avoid startup delay
_pymupdf = None


def _get_pymupdf():
    """Lazy load PyMuPDF module."""
    global _pymupdf
    if _pymupdf is None:
        try:
            # noinspection PyUnresolvedReferences
            import pymupdf

            _pymupdf = pymupdf
            logger.debug("PyMuPDF loaded successfully")
        except ImportError:
            logger.warning("PyMuPDF not available for thumbnail generation")
            _pymupdf = False
    return _pymupdf if _pymupdf else None


# Lazy load PIL to avoid startup delay
_pil_image = None


def _get_pil_image():
    """Lazy load PIL Image module."""
    global _pil_image
    if _pil_image is None:
        try:
            # noinspection PyUnresolvedReferences
            from PIL import Image

            _pil_image = Image
            logger.debug("PIL Image loaded successfully")
        except ImportError:
            logger.warning("PIL not available for thumbnail processing")
            _pil_image = False
    return _pil_image if _pil_image else None


class ThumbnailService:
    """Service for generating and managing document thumbnails."""

    # Single thumbnail size — `large` (256×360) covers every UI surface that
    # actually requests one (frontend `document-thumbnail.tsx` hard-codes
    # `?size=large`, smaller surfaces letterbox the same image at the CSS
    # layer). Generating three sizes per doc tripled the disk footprint,
    # tripled the chance any one render would silently fail, and shipped
    # nothing visible to the user.
    THUMBNAIL_SIZES: dict[str, tuple[int, int]] = {
        "large": (256, 360),
    }
    DEFAULT_SIZE = "large"
    THUMBNAIL_FORMAT = "PNG"
    THUMBNAIL_QUALITY = 85
    SUPPORTED_PDF_EXTENSIONS = {".pdf"}
    SUPPORTED_EPUB_EXTENSIONS = {".epub"}
    SUPPORTED_THUMBNAIL_EXTENSIONS = {".pdf", ".epub"}
    SUPPORTED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

    @staticmethod
    def _normalize_size(size: str | None) -> str:
        """Backward-compat shim: legacy callers / API clients still send
        `small` or `medium`. We render exactly one canonical size now;
        anything that isn't an explicit known key collapses to the default.
        """
        if size and size in ThumbnailService.THUMBNAIL_SIZES:
            return size
        return ThumbnailService.DEFAULT_SIZE

    @staticmethod
    def get_thumbnail_path(document_file_path: str, size: str = "large") -> str:
        """Path on disk for the canonical thumbnail (single size).

        `size` is accepted for backward compatibility with callers that
        still pass `small` / `medium`; everything resolves to the default
        large thumbnail file because we only persist one image per doc.
        """
        size = ThumbnailService._normalize_size(size)
        directory = os.path.dirname(document_file_path)
        basename = os.path.splitext(os.path.basename(document_file_path))[0]
        return os.path.join(directory, f"{basename}_thumb_{size}.png")

    @staticmethod
    def get_thumbnail_relative_path(document_relative_path: str, size: str = "large") -> str:
        """Relative path stored in metadata. Same single-size semantics."""
        size = ThumbnailService._normalize_size(size)
        directory = os.path.dirname(document_relative_path)
        basename = os.path.splitext(os.path.basename(document_relative_path))[0]
        return os.path.join(directory, f"{basename}_thumb_{size}.png")

    @staticmethod
    def get_default_thumbnail_path() -> str | None:
        """Locate the legacy PDF-icon placeholder asset on disk.

        Kept solely so :meth:`is_placeholder_thumbnail` can recognise legacy
        thumbnails that were copied from this asset before the placeholder
        fallback was removed. New writes never reference it — when real
        thumbnail generation fails the API returns 404 and the frontend
        renders its title-card fallback instead of a generic icon.
        """
        # noinspection PyTypeChecker
        possible_paths = [
            os.path.join(os.getcwd(), "static", "img", "pdf-placeholder.png"),
            os.path.join(os.getcwd(), "src", "main", "static", "pdf-placeholder.png"),
            os.path.join(os.path.dirname(__file__), "..", "..", "static", "pdf-placeholder.png"),
            os.path.join(os.getcwd(), "..", "scrapalot-ui", "public", "icons", "documents", "pdf.png"),
        ]
        for path in possible_paths:
            # noinspection PyTypeChecker
            if os.path.exists(path):
                return str(path)
        return None

    # SHA256 of the legacy placeholder asset, lazily resolved on first call.
    # Caches both the size and the digest so the per-request comparison is a
    # 40-byte hex equality check, not a re-read of the placeholder file.
    _placeholder_signature: tuple[int, str] | None = None

    @classmethod
    def _get_placeholder_signature(cls) -> tuple[int, str] | None:
        if cls._placeholder_signature is not None:
            return cls._placeholder_signature
        path = cls.get_default_thumbnail_path()
        if not path:
            return None
        try:
            import hashlib

            size = os.path.getsize(path)
            with open(path, "rb") as fh:
                digest = hashlib.sha256(fh.read()).hexdigest()
            cls._placeholder_signature = (size, digest)
            return cls._placeholder_signature
        except OSError:
            return None

    @classmethod
    def is_placeholder_thumbnail(cls, thumb_path: str) -> bool:
        """True iff ``thumb_path`` is byte-identical to the legacy PDF-icon
        placeholder. Used by the serve endpoint to translate "thumb is the
        generic icon" into a 404 so the frontend's title-card fallback can
        render. Cheap fast-path on size mismatch; only hashes when sizes match.
        """
        signature = cls._get_placeholder_signature()
        if not signature:
            return False
        try:
            if os.path.getsize(thumb_path) != signature[0]:
                return False
            import hashlib

            with open(thumb_path, "rb") as fh:
                return hashlib.sha256(fh.read()).hexdigest() == signature[1]
        except OSError:
            return False

    @staticmethod
    def generate_pdf_thumbnail(
        pdf_path: str,
        output_path: str | None = None,
        size: str = "large",
        page_number: int = 0,
    ) -> str | None:
        """Render the cover page of a PDF to a single PNG thumbnail.

        `size` is preserved in the signature for backward compatibility
        but is normalised to the single canonical value internally.
        """
        size = ThumbnailService._normalize_size(size)
        pymupdf = _get_pymupdf()
        pil_image = _get_pil_image()

        if not pymupdf:
            logger.warning("PyMuPDF not available, cannot generate thumbnail")
            return None

        if not pil_image:
            logger.warning("PIL not available, cannot process thumbnail image")
            return None

        if not os.path.exists(pdf_path):
            logger.error("PDF file not found: %s", pdf_path)
            return None

        # Refuse non-PDF inputs upfront. Without this guard, callers that
        # forget to gate on `can_generate_thumbnail` (e.g. on-demand routes
        # handed a markdown- or image-backed document) hand a `.md` to
        # PyMuPDF, which then logs an "Error generating thumbnail … Failed
        # to open file" line per call. Cheap extension check is enough —
        # the supported set is `{.pdf}`.
        if os.path.splitext(pdf_path.lower())[1] not in ThumbnailService.SUPPORTED_PDF_EXTENSIONS:
            return None

        try:
            # Open PDF with PyMuPDF
            # noinspection PyUnresolvedReferences
            doc = pymupdf.open(pdf_path)

            if len(doc) == 0:
                logger.warning("PDF has no pages: %s", pdf_path)
                doc.close()
                return None

            # Get the specified page (default: first page)
            actual_page = min(page_number, len(doc) - 1)
            page = doc[actual_page]

            # Calculate zoom factor for good quality thumbnail
            # Render at 2x the target size for better quality
            target_size = ThumbnailService.THUMBNAIL_SIZES.get(size, ThumbnailService.THUMBNAIL_SIZES[ThumbnailService.DEFAULT_SIZE])
            zoom = 2.0
            # noinspection PyUnresolvedReferences
            mat = pymupdf.Matrix(zoom, zoom)

            # Render page to pixmap
            pix = page.get_pixmap(matrix=mat, alpha=False)

            # Convert to PIL Image
            # noinspection PyUnresolvedReferences
            img = pil_image.frombytes("RGB", [pix.width, pix.height], pix.samples)

            # Resize to target size while maintaining aspect ratio
            # noinspection PyUnresolvedReferences
            img.thumbnail(target_size, pil_image.Resampling.LANCZOS)

            # Determine output path
            if output_path is None:
                output_path = ThumbnailService.get_thumbnail_path(pdf_path, size)

            # Ensure directory exists
            # noinspection PyTypeChecker
            resolved_output_path: str = output_path
            os.makedirs(os.path.dirname(resolved_output_path), exist_ok=True)

            # Save thumbnail
            img.save(resolved_output_path, ThumbnailService.THUMBNAIL_FORMAT)

            doc.close()
            logger.info("Generated thumbnail (%s): %s", size, resolved_output_path)
            return resolved_output_path

        except Exception as e:
            logger.error("Error generating thumbnail for %s: %s", pdf_path, str(e))
            return None

    @staticmethod
    def extract_epub_cover(epub_path: str) -> bytes | None:
        """
        Extract cover image bytes from an EPUB file.

        Tries multiple methods in order of reliability:
        1. OF metadata cover reference
        2. Items with ITEM_COVER type
        3. Images with "cover" in the filename
        4. First image as last resort

        Args:
            epub_path: Absolute path to EPUB file

        Returns:
            Raw image bytes or None if no cover found
        """
        try:
            from ebooklib import epub

            book = epub.read_epub(epub_path, options={"ignore_ncx": True})

            # Method 1: Find cover via OF metadata <meta name="cover" content="item-id"/>
            cover_id = None
            for _ns, meta_dict in book.metadata.items():
                if not isinstance(meta_dict, dict):
                    continue
                for _tag_name, entries in meta_dict.items():
                    if not isinstance(entries, list):
                        continue
                    for entry in entries:
                        if isinstance(entry, tuple) and len(entry) >= 2:
                            attrs = entry[1] if isinstance(entry[1], dict) else {}
                            if attrs.get("name") == "cover":
                                cover_id = attrs.get("content")
                                break

            if cover_id:
                for item in book.get_items():
                    if item.get_id() == cover_id:
                        content = item.get_content()
                        if content and len(content) > 100:
                            logger.debug("EPUB cover found via OF metadata: %s", item.get_name())
                            return content

            # Method 2: Look for ITEM_COVER type
            for item in book.get_items():
                if item.get_type() == 3:  # ebooklib.ITEM_COVER = 3
                    content = item.get_content()
                    # Verify it's actual image data (not HTML cover page)
                    if content and len(content) > 100 and not content[:20].strip().startswith(b"<"):
                        logger.debug("EPUB cover found via ITEM_COVER: %s", item.get_name())
                        return content

            # Method 3: Find images with "cover" in the name
            from ebooklib import ITEM_IMAGE

            image_items = list(book.get_items_of_type(ITEM_IMAGE))
            for item in image_items:
                name_lower = item.get_name().lower()
                id_lower = item.get_id().lower()
                if "cover" in name_lower or "cover" in id_lower:
                    content = item.get_content()
                    if content and len(content) > 100:
                        logger.debug("EPUB cover found by name match: %s", item.get_name())
                        return content

            # Method 4: Parse XHTML cover pages for embedded image references
            for item in book.get_items():
                if item.get_type() == 3:  # ITEM_COVER
                    content = item.get_content()
                    if content and content[:20].strip().startswith(b"<"):
                        try:
                            root = ET.fromstring(content)
                            # Find <img> or <image> elements
                            for ns_prefix in ["", "{http://www.w3.org/1999/xhtml}"]:
                                for img in root.iter(f"{ns_prefix}img"):
                                    src = str(img.get("src", ""))
                                    if src:
                                        # Find the referenced image item
                                        for img_item in image_items:
                                            # noinspection PyTypeChecker
                                            if img_item.get_name().endswith(src) or src.endswith(os.path.basename(img_item.get_name())):
                                                img_content = img_item.get_content()
                                                if img_content and len(img_content) > 100:
                                                    logger.debug("EPUB cover found via XHTML reference: %s", img_item.get_name())
                                                    return img_content
                        except ET.ParseError as e:
                            logger.debug("Could not parse EPUB XHTML for cover lookup: %s", e)

            # Method 5: Largest image as fallback (likely to be the cover)
            if image_items:
                largest = max(image_items, key=lambda i: len(i.get_content() or b""))
                content = largest.get_content()
                if content and len(content) > 1000:
                    logger.debug("EPUB cover using largest image fallback: %s", largest.get_name())
                    return content

            logger.info("No cover image found in EPUB: %s", epub_path)
            return None

        except Exception as e:
            logger.error("Error extracting EPUB cover from %s: %s", epub_path, str(e))
            return None

    @staticmethod
    def generate_epub_thumbnail(
        epub_path: str,
        output_path: str | None = None,
        size: str = "large",
    ) -> str | None:
        """Extract the cover image from an EPUB and emit a single PNG.

        `size` is normalised to the canonical single thumbnail size.
        """
        size = ThumbnailService._normalize_size(size)
        pil_image = _get_pil_image()
        if not pil_image:
            logger.warning("PIL not available, cannot generate EPUB thumbnail")
            return None

        if not os.path.exists(epub_path):
            logger.error("EPUB file not found: %s", epub_path)
            return None

        try:
            cover_bytes = ThumbnailService.extract_epub_cover(epub_path)
            if not cover_bytes:
                logger.info("No cover to generate thumbnail for: %s", epub_path)
                return None

            # noinspection PyUnresolvedReferences
            img = pil_image.open(io.BytesIO(cover_bytes))

            # Convert to RGB if necessary
            if img.mode in ("RGBA", "P", "LA"):
                # noinspection PyUnresolvedReferences
                background = pil_image.new("RGB", img.size, (255, 255, 255))
                if img.mode == "P":
                    img = img.convert("RGBA")
                background.paste(img, mask=img.split()[-1] if img.mode in ("RGBA", "LA") else None)
                img = background
            elif img.mode != "RGB":
                img = img.convert("RGB")

            target_size = ThumbnailService.THUMBNAIL_SIZES.get(size, ThumbnailService.THUMBNAIL_SIZES[ThumbnailService.DEFAULT_SIZE])
            # noinspection PyUnresolvedReferences
            img.thumbnail(target_size, pil_image.Resampling.LANCZOS)

            if output_path is None:
                output_path = ThumbnailService.get_thumbnail_path(epub_path, size)

            resolved_epub_output_path: str = str(output_path)
            os.makedirs(os.path.dirname(resolved_epub_output_path), exist_ok=True)
            img.save(resolved_epub_output_path, ThumbnailService.THUMBNAIL_FORMAT)

            logger.info("Generated EPUB thumbnail (%s): %s", size, resolved_epub_output_path)
            return resolved_epub_output_path

        except Exception as e:
            logger.error("Error generating EPUB thumbnail for %s: %s", epub_path, str(e))
            return None

    @staticmethod
    def generate_all_thumbnails(file_path: str) -> dict[str, str | None]:
        """
        Generate the canonical thumbnail for a document (PDF or EPUB).

        After the size collapse to a single canonical thumbnail, this
        method generates exactly one image and returns
        ``{"large": path_or_None}``. The dict-of-sizes shape is kept so
        existing callers (`document_pipeline.py`, `documents.py`,
        admin gRPC) that iterate `results.values()` still work.
        """
        ext = os.path.splitext(file_path.lower())[1]
        results = {}
        for size in ThumbnailService.THUMBNAIL_SIZES:
            if ext in ThumbnailService.SUPPORTED_EPUB_EXTENSIONS:
                results[size] = ThumbnailService.generate_epub_thumbnail(file_path, size=size)
            else:
                results[size] = ThumbnailService.generate_pdf_thumbnail(file_path, size=size)
        return results

    @staticmethod
    def save_custom_thumbnail(
        document_file_path: str,
        image_data: bytes,
        size: str = "large",
    ) -> str | None:
        """
        Save a custom uploaded thumbnail for a document.

        Args:
            document_file_path: Absolute path to the document file
            image_data: Raw image bytes from upload
            size: Target size

        Returns:
            Path to saved thumbnail or None if failed
        """
        pil_image = _get_pil_image()

        if not pil_image:
            logger.warning("PIL not available, cannot save custom thumbnail")
            return None

        try:
            # Open uploaded image
            # noinspection PyUnresolvedReferences
            img = pil_image.open(io.BytesIO(image_data))

            # Convert to RGB if necessary (handles PNG with alpha, etc.)
            if img.mode in ("RGBA", "P", "LA"):
                # Create white background for transparent images
                # noinspection PyUnresolvedReferences
                background = pil_image.new("RGB", img.size, (255, 255, 255))
                if img.mode == "P":
                    img = img.convert("RGBA")
                background.paste(img, mask=img.split()[-1] if img.mode in ("RGBA", "LA") else None)
                img = background
            elif img.mode != "RGB":
                img = img.convert("RGB")

            # Resize to target size while maintaining aspect ratio
            target_size = ThumbnailService.THUMBNAIL_SIZES.get(size, ThumbnailService.THUMBNAIL_SIZES[ThumbnailService.DEFAULT_SIZE])
            # noinspection PyUnresolvedReferences
            img.thumbnail(target_size, pil_image.Resampling.LANCZOS)

            # Generate output path
            output_path = ThumbnailService.get_thumbnail_path(document_file_path, size)

            # Ensure directory exists
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            # Save thumbnail. If the destination already exists but is owned by
            # a different uid (legacy data: pre-existing thumbnails written by
            # an earlier root-owned ingest path linger in the volume), PIL's
            # `open(path, "wb")` returns EACCES because we cannot truncate a
            # file we do not own. The parent dir typically has write access,
            # so unlink-and-retry recovers the case.
            try:
                img.save(output_path, ThumbnailService.THUMBNAIL_FORMAT)
            except PermissionError:
                try:
                    os.unlink(output_path)
                except FileNotFoundError:
                    # Already gone — nothing to unlink before the retry save.
                    pass
                img.save(output_path, ThumbnailService.THUMBNAIL_FORMAT)

            logger.info("Saved custom thumbnail (%s): %s", size, output_path)
            return output_path

        except Exception as e:
            logger.error("Error saving custom thumbnail: %s", str(e))
            return None

    @staticmethod
    def save_custom_thumbnail_all_sizes(
        document_file_path: str,
        image_data: bytes,
    ) -> dict[str, str | None]:
        """
        Save custom thumbnail for all sizes.

        Args:
            document_file_path: Absolute path to the document file
            image_data: Raw image bytes from upload

        Returns:
            Dict mapping size to thumbnail path (or None if failed)
        """
        results = {}
        for size in ThumbnailService.THUMBNAIL_SIZES:
            results[size] = ThumbnailService.save_custom_thumbnail(document_file_path, image_data, size)
        return results

    @staticmethod
    def delete_thumbnails(document_file_path: str) -> bool:
        """Delete the canonical thumbnail and any legacy size variants.

        Production has `_thumb_small.png` / `_thumb_medium.png` left
        over from before the size collapse — sweep them too so a deleted
        doc doesn't leave orphan ONGs on disk.
        """
        deleted_any = False
        directory = os.path.dirname(document_file_path)
        basename = os.path.splitext(os.path.basename(document_file_path))[0]
        # Current canonical size + legacy sizes that historical ingests
        # may have written.
        candidates = {ThumbnailService.DEFAULT_SIZE, "small", "medium", "large"}
        for size in candidates:
            thumb_path = os.path.join(directory, f"{basename}_thumb_{size}.png")
            if os.path.exists(thumb_path):
                try:
                    os.remove(thumb_path)
                    logger.info("Deleted thumbnail: %s", thumb_path)
                    deleted_any = True
                except OSError as e:
                    logger.error("Failed to delete thumbnail %s: %s", thumb_path, str(e))
        return deleted_any

    @staticmethod
    def get_thumbnail_metadata(document_file_path: str) -> dict[str, Any]:
        """
        Get thumbnail metadata for a document.

        Args:
            document_file_path: Absolute path to the document file

        Returns:
            Dict with thumbnail availability info and paths
        """
        metadata: dict[str, Any] = {
            "has_thumbnail": False,
            "has_custom": False,
            "available_sizes": [],
            "thumbnail_paths": {},
        }

        for size in ThumbnailService.THUMBNAIL_SIZES:
            thumb_path = ThumbnailService.get_thumbnail_path(document_file_path, size)
            if os.path.exists(thumb_path):
                metadata["has_thumbnail"] = True
                metadata["available_sizes"].append(size)
                metadata["thumbnail_paths"][size] = thumb_path

        return metadata

    @staticmethod
    def can_generate_thumbnail(file_path: str) -> bool:
        """
        Check if thumbnail can be generated for a file based on its extension.

        Args:
            file_path: Path to the file

        Returns:
            True if thumbnail can be generated, False otherwise
        """
        ext = os.path.splitext(file_path.lower())[1]
        return ext in ThumbnailService.SUPPORTED_THUMBNAIL_EXTENSIONS

    @staticmethod
    def is_image_file(file_path: str) -> bool:
        """
        Check if the file is an image that can be used as its own thumbnail.

        Args:
            file_path: Path to the file

        Returns:
            True if file is an image, False otherwise
        """
        ext = os.path.splitext(file_path.lower())[1]
        return ext in ThumbnailService.SUPPORTED_IMAGE_EXTENSIONS

    @staticmethod
    def download_cover_from_internet(document_file_path: str, isbn: str) -> str | None:
        """
        Download book cover from Open Library using ISBN and save as custom thumbnail.

        Tries Open Library cover API with ISBN-13 and ISBN-10 formats,
        falling back to medium size if large is unavailable.

        Args:
            document_file_path: Path to the document file (for thumbnail path calculation)
            isbn: ISBN-10 or ISBN-13

        Returns:
            Source identifier (e.g. "openlibrary") if successful, None if failed
        """
        import re
        import urllib.request

        # Clean ISBN (remove hyphens, spaces)
        clean_isbn = re.sub(r"[^0-9X]", "", isbn.upper())
        if len(clean_isbn) not in (10, 13):
            logger.warning("Invalid ISBN format: %s", isbn)
            return None

        # Try large then medium cover sizes
        urls_to_try = [
            f"https://covers.openlibrary.org/b/isbn/{clean_isbn}-L.jpg",
            f"https://covers.openlibrary.org/b/isbn/{clean_isbn}-M.jpg",
        ]

        for url in urls_to_try:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Scrapalot/1.0"})
                with urllib.request.urlopen(req, timeout=_OL_HTTP_TIMEOUT_SECONDS) as response:
                    image_data = response.read()

                    # Open Library returns a 1x1 pixel image when no cover exists
                    if len(image_data) < 1000:
                        logger.debug("Cover too small (placeholder), skipping: %s", url)
                        continue

                    # Save as custom thumbnail for all sizes
                    results = ThumbnailService.save_custom_thumbnail_all_sizes(document_file_path, image_data)

                    if any(results.values()):
                        logger.info("Downloaded cover from Open Library for ISBN %s", clean_isbn)
                        return "openlibrary"

            except Exception as e:
                logger.debug("Failed to download cover from %s: %s", url, e)
                continue

        logger.info("No cover found on Open Library for ISBN %s", clean_isbn)
        return None

    @staticmethod
    def download_cover_by_title(
        document_file_path: str,
        filename: str,
        author: str | None = None,
        title: str | None = None,
        skip_cover_ids: set[int] | None = None,
    ) -> tuple[str, int] | None:
        """Download a book cover from Open Library by searching title + author.

        Prefers the explicit `author` / `title` (from `documents.title` and
        `extracted_metadata.author`) when provided, because filename heuristics
        often misidentify the author and pick the wrong cover. Falls back to
        parsing two filename conventions when explicit values are absent:
        - `(YEAR) Author Name - Book Title.ext` (space-separated, dash-delimited author/title)
        - `YEAR_author_words_title_words.ext`   (snake_case, no separator)

        Tries several candidate queries (title+author, title alone, truncations)
        and picks the result with the best title similarity that ALSO matches
        author when one is known.

        `skip_cover_ids` lets a retry pick a *different* cover than previous
        attempts: candidates already used are filtered out before the best
        match is chosen. When non-empty, the early-break optimisation is
        disabled so all candidate queries are exhausted before picking.
        Returns `("openlibrary", cover_id)` on success, None if nothing
        usable was found.
        """
        from difflib import SequenceMatcher
        import json as _json
        from pathlib import Path
        import re
        import time
        import urllib.request

        # Cumulative wall-clock budget across all candidate queries + downloads,
        # so a cover-less book (which exhausts every candidate, each hitting a
        # slow/no-match OL response) still returns inside the gRPC deadline.
        _deadline = time.monotonic() + _OL_TITLE_SEARCH_BUDGET_SECONDS

        def _remaining() -> float:
            return _deadline - time.monotonic()

        stem = Path(filename).stem

        # Strip leading year token in either format. Keep title_part / author_part
        # for similarity scoring; underscores collapse to spaces so snake_case
        # filenames become natural-language queries.
        stem_clean = re.sub(r"^\((\d{4})\)\s*", "", stem)
        stem_clean = re.sub(r"^\d{4}[_\s]+", "", stem_clean)
        stem_clean = stem_clean.replace("_", " ").strip()

        if " - " in stem:
            parsed_author, parsed_title = (p.strip() for p in stem.replace("_", " ").split(" - ", 1))
            # Re-strip leading year on author side if it was `(YYYY) Author`
            parsed_author = re.sub(r"^\(\d{4}\)\s*", "", parsed_author)
            parsed_author = re.sub(r"^\d{4}[\s]+", "", parsed_author).strip()
        else:
            parsed_author, parsed_title = "", stem_clean

        # Explicit metadata overrides filename parsing when provided.
        # `author` may be a "; "-separated list (DB convention) — take the
        # first entry for query relevance and score against the full list.
        title_part = (title or parsed_title).strip()
        if author:
            author_part = author.split(";")[0].strip()
            author_all = author
        else:
            author_part = parsed_author
            author_all = parsed_author

        if not stem_clean:
            logger.debug("Could not parse anything searchable from filename: %s", filename)
            return None

        def _norm(t: str) -> str:
            return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", t.lower())).strip()

        def _ol_search(query: str) -> list[dict]:
            if not query.strip():
                return []
            remaining = _remaining()
            if remaining <= 0:
                return []
            params = f"q={urllib.request.quote(query)}&limit=5&fields=key,title,author_name,cover_i"
            try:
                req = urllib.request.Request(
                    f"https://openlibrary.org/search.json?{params}",
                    headers={"User-Agent": "Scrapalot/1.0"},
                )
                with urllib.request.urlopen(req, timeout=min(_OL_HTTP_TIMEOUT_SECONDS, remaining)) as resp:
                    return _json.loads(resp.read()).get("docs", []) or []
            except Exception as e:
                logger.debug("OL search failed for %r: %s", query, e)
                return []

        # Candidate queries, ordered by expected precision.
        candidates: list[str] = []
        if title_part and author_part:
            candidates.append(f"{title_part} {author_part}")
        candidates.append(stem_clean)
        title_words = title_part.split() if title_part else stem_clean.split()
        for n in (8, 5, 3):
            head = " ".join(title_words[:n])
            if head and head not in candidates:
                candidates.append(head)

        title_for_score = title_part or stem_clean
        skip = skip_cover_ids or set()
        # When retrying with a skip set, we can't early-break on a 0.6 hit —
        # that hit might be the cover we're trying to avoid. Collect every
        # candidate, filter, then pick the highest remaining score.
        scored: list[tuple[float, int, str]] = []  # (score, cover_id, query)
        for query in candidates:
            if _remaining() <= 0:
                break
            best_in_query = 0.0
            for doc in _ol_search(query):
                cover_id = doc.get("cover_i")
                if not cover_id or cover_id in skip:
                    continue
                score = SequenceMatcher(None, _norm(title_for_score), _norm(doc.get("title", ""))).ratio()
                if author_part:
                    ol_authors = " ".join(doc.get("author_name") or [])
                    author_query_tokens = set(_norm(author_all).split())
                    ol_author_tokens = set(_norm(ol_authors).split())
                    overlap = author_query_tokens & ol_author_tokens
                    if overlap:
                        # Heavier boost than before — when we have a real
                        # author from extracted_metadata, an author match
                        # is the strongest signal we have that the cover is
                        # actually for THIS book and not a same-titled one.
                        score += 0.3
                    elif author:
                        # Explicit author provided but no overlap → almost
                        # certainly the wrong book; penalise so a clean
                        # title+author match elsewhere can win.
                        score -= 0.2
                scored.append((score, cover_id, query))
                if score > best_in_query:
                    best_in_query = score
            # First-attempt fast path: a confident hit lets us stop probing
            # candidate queries. Suppressed when skipping is active so the
            # retry can see ALL alternates.
            if not skip and best_in_query >= 0.6:
                break

        scored.sort(key=lambda t: t[0], reverse=True)
        for best_score, best_cover_id, best_query in scored:
            if best_score < 0.3:
                break
            if _remaining() <= 0:
                break
            # Download cover (large then medium)
            for size_suffix in ("-L.jpg", "-M.jpg"):
                url = f"https://covers.openlibrary.org/b/id/{best_cover_id}{size_suffix}"
                try:
                    req = urllib.request.Request(url, headers={"User-Agent": "Scrapalot/1.0"})
                    with urllib.request.urlopen(req, timeout=_OL_HTTP_TIMEOUT_SECONDS) as resp:
                        image_data = resp.read()
                    if len(image_data) < 1000:
                        logger.debug("Cover placeholder (too small) at %s", url)
                        continue
                    results = ThumbnailService.save_custom_thumbnail_all_sizes(document_file_path, image_data)
                    if any(results.values()):
                        logger.info(
                            "Downloaded OL cover for %r via query %r (cover_id=%d, score=%.2f, skipped=%d)",
                            filename,
                            best_query,
                            best_cover_id,
                            best_score,
                            len(skip),
                        )
                        return ("openlibrary", best_cover_id)
                except Exception as e:
                    logger.debug("Cover download failed from %s: %s", url, e)

        logger.info(
            "No usable OL cover match for filename %r (candidates=%d, skipped=%d)",
            filename,
            len(scored),
            len(skip),
        )
        return None
