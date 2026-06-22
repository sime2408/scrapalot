"""
DOCX Document Processing Service.

This module handles DOCX-specific document processing including:
- Microsoft Word document parsing via Docling
- Rich text formatting extraction
- Table and image handling
- Progress tracking for long-running operations
"""

from collections.abc import Callable
import time

from langchain_core.documents import Document as LangchainDocument

from src.main.utils.core.logger import get_logger
from src.main.utils.documents.utils import (
    configure_docling_pipeline_options,
    format_processing_time,
    setup_docling_environment,
    validate_file_path,
)

logger = get_logger(__name__)


# Import Docling components with fallback to stubs
try:
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, WordFormatOption

except ImportError as import_error:
    logger.warning("Failed to import Docling components: %s", str(import_error))
    from src.main.dto.docling_stubs import (
        DocumentConverter,
        InputFormat,
        PdfPipelineOptions,
        WordFormatOption,
    )


class DOCXProcessor:
    """
    DOCX processor for handling Microsoft Word documents.

    Uses Docling for document parsing and text extraction.
    """

    @staticmethod
    def process_docx(
        file_path: str,
        job_id: str | None = None,
        progress_callback: Callable | None = None,
        _db=None,
        _user_id: str | None = None,
        relative_file_path: str | None = None,
    ) -> list[LangchainDocument]:
        """
        Process a DOCX file and return a list of LangChain Document objects.

        Args:
            file_path: Path to the DOCX file (absolute path for processing)
            job_id: Job ID for progress tracking (optional)
            progress_callback: Callback function for progress updates (optional)
            _db: Database session (optional)
            _user_id: User ID for tracking (optional)
            relative_file_path: Relative file path to store in metadata (optional)

        Returns:
            List of LangchainDocument objects with content

        Raises:
            DocumentProcessingError: If processing fails
        """
        from src.main.service.document.document_processor import DocumentProcessingError

        start_time = time.time()
        logger.info("Starting DOCX processing: %s", file_path)

        # Validate file path
        try:
            validate_file_path(file_path)
        except Exception as e:
            logger.error("File validation failed: %s", str(e))
            raise DocumentProcessingError(f"Invalid file path: {e!s}") from e

        # Set up Docling environment (CPU-only for DOCX processing)
        setup_docling_environment(is_gpu=False, device_type="cpu")

        # Configure pipeline options (use PdfPipelineOptions for all Docling formats)
        pipeline_options = PdfPipelineOptions()
        pipeline_options = configure_docling_pipeline_options(pipeline_options, is_gpu=False)

        try:
            # Initialize DocumentConverter with Word format option
            # Note: WordFormatOption automatically uses the correct DOCX backend
            converter = DocumentConverter(format_options={InputFormat.DOCX: WordFormatOption(pipeline_options=pipeline_options)})

            # Convert DOCX to Docling document
            logger.info("Converting DOCX with Docling...")
            result = converter.convert(file_path)

            if not result or not result.document:
                raise DocumentProcessingError("Docling conversion failed - no document returned")

            # Export to markdown
            markdown_content = result.document.export_to_markdown()

            if not markdown_content or not markdown_content.strip():
                raise DocumentProcessingError("No content extracted from DOCX")

            # Get document metadata
            doc_metadata = {
                "source": relative_file_path or file_path,
                "file_type": "docx",
                "processing_method": "docling",
            }

            # Add page count if available
            if hasattr(result.document, "pages") and result.document.pages:
                doc_metadata["page_count"] = str(len(result.document.pages))

            # Create a single LangchainDocument with full content
            langchain_doc = LangchainDocument(
                page_content=markdown_content,
                metadata=doc_metadata,
            )

            processing_time = time.time() - start_time
            logger.info(
                "DOCX processing completed in %s. Content length: %d chars",
                format_processing_time(processing_time),
                len(markdown_content),
            )

            # Update progress if callback provided
            if progress_callback:
                progress_callback(
                    job_id=job_id,
                    progress=100,
                    message="DOCX processing completed",
                )

            return [langchain_doc]

        except Exception as e:
            logger.exception("DOCX processing failed: %s", str(e))
            raise DocumentProcessingError(f"Failed to process DOCX: {e!s}") from e


# Export the main processing function
def process_docx(
    file_path: str,
    job_id: str | None = None,
    progress_callback: Callable | None = None,
    db=None,
    user_id: str | None = None,
    relative_file_path: str | None = None,
) -> list[LangchainDocument]:
    """
    Process a DOCX file and return a list of LangChain Document objects.

    This is a convenience function that delegates to DOCXProcessor.

    Args:
        file_path: Path to the DOCX file
        job_id: Job ID for progress tracking
        progress_callback: Callback function for progress updates
        db: Database session
        user_id: User ID for tracking
        relative_file_path: Relative file path to store in metadata

    Returns:
        List of LangchainDocument objects
    """
    return DOCXProcessor.process_docx(
        file_path=file_path,
        job_id=job_id,
        progress_callback=progress_callback,
        _db=db,
        _user_id=user_id,
        relative_file_path=relative_file_path,
    )


__all__ = ["DOCXProcessor", "process_docx"]
