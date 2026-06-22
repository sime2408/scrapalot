"""
EPUB Document Processing Service.

This module handles EPUB-specific document processing including
- EPUB content extraction to Markdown
- Chapter detection and parsing
- Integration with the shared chunking service
"""

from collections.abc import Callable
import os
import time

from langchain_core.documents import Document as LangchainDocument

from src.main.utils.core.logger import get_logger
from src.main.utils.documents.utils import extract_epub_to_markdown, validate_file_path

logger = get_logger(__name__)

# Post-extraction sanity check: if a non-trivial EPUB file returns
# almost nothing (scanned-image-only, DRM-stripped, missing spine items),
# don't store the placeholder as a successfully-processed document.
_MIN_EXTRACTED_TEXT_CHARS = 5000
_MIN_FILE_SIZE_FOR_VALIDATION = 100 * 1024  # 100 KB


class EPUBProcessor:
    """
    EPUB processor for handling EPUB documents.

    This class handles all EPUB-specific processing including
    - Content extraction to Markdown format
    - Chapter detection and parsing
    - Integration with the shared chunking service
    """

    @staticmethod
    def process_epub(
        file_path: str,
        job_id: str | None = None,
        progress_callback: Callable | None = None,
        db=None,
        user_id: str | None = None,
        relative_file_path: str | None = None,
    ) -> list[LangchainDocument]:
        """
        Process an EPUB file and return a list of LangChain Document objects.

        Args:
            file_path: Path to the EPUB file (absolute path for processing)
            job_id: Job ID for progress tracking (optional)
            progress_callback: Callback function for progress updates (optional)
            db: Database session (optional)
            user_id: User ID for tracking (optional)
            relative_file_path: Relative file path to store in metadata (optional, defaults to file_path)

        Returns:
            List of LangchainDocument objects with chapter-level content

        Raises:
            DocumentProcessingError: If processing fails
        """
        # Import here to avoid circular imports
        from src.main.service.document.document_processor import (
            DocumentProcessingError,
            DocumentProcessor,
        )

        metadata_file_path = relative_file_path if relative_file_path else file_path

        try:
            logger.info("Processing EPUB document: %s", os.path.basename(file_path))

            # Verify the file exists
            if not validate_file_path(file_path):
                logger.error("File not found: %s", file_path)
                raise FileNotFoundError(f"File not found: {file_path}")

            # Update progress
            if job_id and progress_callback:
                progress_callback(
                    job_id,
                    {
                        "progress": 5,
                        "message": "extractingEpub",
                        "status": "processing",
                    },
                )

            # Extract EPUB to Markdown
            logger.info("Extracting EPUB to markdown")
            start_time = time.time()
            markdown_content, chapter_count = extract_epub_to_markdown(file_path)

            if not markdown_content:
                logger.error("EPUB extraction produced no text — likely DRM/encoding issue: %s", file_path)
                raise DocumentProcessingError("errorEpubExtractionEmpty")

            # Sanity check: non-trivial EPUBs that return almost no text are usually
            # scanned-image books, DRM-protected, or missing spine items. Without this
            # validation they were silently stored as 1-chunk "completed" documents
            # (observed on 8+ garden/cooking EPUBs in the books collection).
            try:
                file_bytes = os.path.getsize(file_path)
            except OSError:
                file_bytes = 0
            if len(markdown_content) < _MIN_EXTRACTED_TEXT_CHARS and file_bytes > _MIN_FILE_SIZE_FOR_VALIDATION:
                # Parametrized status code (CLAUDE.md rule #3): UI renders
                # `knowledge.uploader.lowExtractionYieldEpub` with `{{0}}` chars,
                # `{{1}}` KB.
                code = f"lowExtractionYieldEpub:{len(markdown_content)}:{file_bytes / 1024:.0f}"
                logger.error("EPUB low extraction yield: %s (%s)", code, file_path)
                raise DocumentProcessingError(code)

            logger.info("Extracted %d chapters from EPUB in %.2fs", chapter_count or 0, time.time() - start_time)

            # Update progress
            if job_id and progress_callback:
                progress_callback(
                    job_id,
                    {
                        "progress": 40,
                        "message": f"extractedChapters:{chapter_count}",
                        "status": "processing",
                    },
                )

            # Create a page document with the Markdown content
            # This will be chunked by apply_chunking_and_return_documents_with_pages
            page_documents = [
                LangchainDocument(
                    page_content=markdown_content,
                    metadata={
                        "source": metadata_file_path,
                        "file_name": os.path.basename(file_path),
                        "type": "epub",
                        "chapter_count": chapter_count or 0,
                        "page": 1,  # EPUB doesn't have pages, use 1 as default
                    },
                )
            ]

            # Update progress
            if job_id and progress_callback:
                progress_callback(
                    job_id,
                    {
                        "progress": 50,
                        "message": "applyingChunking",
                        "status": "processing",
                    },
                )

            # Apply chunking to split the EPUB content into semantically meaningful chunks
            # This enables chapter detection and hierarchy creation
            documents = DocumentProcessor.apply_chunking_and_return_documents_with_pages(
                page_documents, file_path, db, user_id, metadata_file_path, job_id, progress_callback
            )

            logger.info(
                "EPUB processing completed: %s (%d chunks from %d chapters)",
                os.path.basename(file_path),
                len(documents),
                chapter_count or 0,
            )

            return documents

        except Exception as ex:
            logger.error("Error processing EPUB: %s", str(ex))
            logger.exception(ex)
            error_msg = f"Failed to process EPUB '{os.path.basename(file_path)}': {ex!s}"
            raise DocumentProcessingError(error_msg) from ex
        finally:
            # Force garbage collection to free memory
            import gc

            gc.collect()


# Module-level instance for convenience
epub_processor = EPUBProcessor()

# Re-export for convenience
__all__ = [
    "EPUBProcessor",
    "epub_processor",
]
