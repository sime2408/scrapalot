"""
PDF Document Processing Service.

This module handles PDF-specific document processing including
- OCR detection and processing
- GPU-accelerated processing with Docling
- Fast CPU processing with PyMuPDF4LLM
- Progress tracking for long-running operations
"""

from collections.abc import Callable
import logging
import os
import re
import time
from typing import Any

from celery.exceptions import SoftTimeLimitExceeded
from langchain_core.documents import Document as LangchainDocument

from src.main.utils.core.logger import get_logger
from src.main.utils.documents.utils import (
    configure_docling_pipeline_options,
    format_processing_time,
    setup_docling_environment,
    validate_file_path,
)

logger = get_logger(__name__)

# Post-extraction sanity check: scanned-image PDFs that skip OCR return almost
# no text, and the pipeline silently stores a 1-chunk "completed" document.
# Refuse to keep results below this threshold for non-trivial PDFs.
_MIN_EXTRACTED_PDF_TEXT_CHARS = 5000
_MIN_PDF_FILE_SIZE_FOR_VALIDATION = 100 * 1024  # 100 KB

# Module-level lazy singleton for RapidOCR. The model weights are ~150 MB and
# initialization is slow; sharing one instance across all task invocations
# inside the same worker child avoids repeated warm-up. Thread-safe init via a
# lock — though the reprocess path only runs one task per child at a time,
# other future callers may need this.
_rapidocr_instance = None
_rapidocr_init_lock = None


def _get_rapidocr_singleton():
    """Lazy singleton RapidOCR configured for English detection + Latin script
    recognition. Works for English, Spanish, Italian, German, French, Portuguese
    and any other Latin-alphabet language seen in the scanned PDF corpus. On
    first call inside a worker child, downloads/loads ONNX weights (~150 MB,
    ~2-3 seconds). Subsequent calls return the cached instance.

    Fork safety note: Celery prefork workers import this module ONCE in the
    main process and then fork child workers. Because we use lazy
    initialization, `_rapidocr_instance` is still `None` at fork time — each
    child inherits `None` and creates its own RapidOCR instance on first task.
    We never fork an already-initialized ONNX runtime session, which would be
    undefined behavior. Do NOT call this function at module import time or in
    any code path that runs before the prefork happens.
    """
    global _rapidocr_instance, _rapidocr_init_lock
    if _rapidocr_instance is not None:
        return _rapidocr_instance
    if _rapidocr_init_lock is None:
        import threading

        _rapidocr_init_lock = threading.Lock()
    with _rapidocr_init_lock:
        if _rapidocr_instance is not None:
            return _rapidocr_instance
        # noinspection PyUnresolvedReferences
        from rapidocr import RapidOCR

        # noinspection PyUnresolvedReferences
        from rapidocr.utils.parse_parameters import LangDet, LangRec

        _rapidocr_instance = RapidOCR(
            params={
                "Det.lang_type": LangDet.EN,
                "Rec.lang_type": LangRec.LATIN,
            }
        )
        logger.info("Initialized RapidOCR singleton (EN det / LATIN rec)")
    return _rapidocr_instance


def _validate_extracted_pdf_documents(documents: list[LangchainDocument], file_path: str) -> list[LangchainDocument]:
    """
    Raise DocumentProcessingError if extraction produced almost no text for a
    non-trivial PDF file. Catches scanned-image PDFs that were parsed without
    OCR and DRM-protected files that return only metadata.
    """
    from src.main.service.document.document_processor import DocumentProcessingError

    total_chars = sum(len(d.page_content or "") for d in documents)
    try:
        file_bytes = os.path.getsize(file_path)
    except OSError:
        file_bytes = 0

    if total_chars < _MIN_EXTRACTED_PDF_TEXT_CHARS and file_bytes > _MIN_PDF_FILE_SIZE_FOR_VALIDATION:
        # Parametrized status code (CLAUDE.md rule #3): the UI renders
        # `knowledge.uploader.lowExtractionYield` with `{{0}}` chars,
        # `{{1}}` KB, `{{2}}` pages.
        raise DocumentProcessingError(f"lowExtractionYield:{total_chars}:{file_bytes / 1024:.0f}:{len(documents)}")
    return documents


def _configure_huggingface_cache():
    """Configure HuggingFace cache to avoid Windows symlink issues and use local models."""
    try:
        import platform

        current_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.abspath(os.path.join(current_dir, "..", "..", "..", ".."))
        local_models_dir = os.path.join(project_root, "data", "models", "huggingface")

        os.makedirs(local_models_dir, exist_ok=True)

        os.environ["HF_HOME"] = local_models_dir
        os.environ["HUGGINGFACE_HUB_CACHE"] = local_models_dir

        if platform.system() == "Windows":
            os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
            os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"
            logger.info("Configured HuggingFace cache for Windows (symlinks disabled)")

        logger.info("HuggingFace cache configured to use local directory: %s", local_models_dir)
        return local_models_dir

    except (OSError, PermissionError) as ex:
        logger.warning("Failed to configure HuggingFace cache: %s", str(ex))
        return None


def _extract_printed_page_number(text: str) -> int | None:
    """
    Extract the actual printed page number from PDF content.

    Many scanned books have front matter that causes a mismatch between
    sequential PDF page numbers and actual printed page numbers.

    Args:
        text: Page content text

    Returns:
        Extracted page number or None if not found
    """
    if not text or not text.strip():
        return None

    match = re.search(r"^(\d+)\s+", text.strip())

    if match:
        try:
            page_num = int(match.group(1))
            if 1 <= page_num <= 10000:
                return page_num
        except ValueError as e:
            logger.debug("Could not parse page number from %r: %s", match.group(1), e)

    return None


# Import Docling components with fallback to stubs
try:
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline

except ImportError as import_error:
    logger.warning("Failed to import Docling components: %s", str(import_error))
    from src.main.dto.docling_stubs import (
        DocumentConverter,
        InputFormat,
        PdfFormatOption,
        PdfPipelineOptions,
        PyPdfiumDocumentBackend,
        StandardPdfPipeline,
    )


def analyze_pdf_document(file_path: str) -> tuple:
    """
    Analyze a PDF document in a single pass to extract metadata and detect OCR.

    Opens the file once and extracts:
    - Whether Process a PDF document in one go to get metadata and check for OCR.

    This function opens the file just one time to determine:
    - If the document is OCR or scanned (which involves layout detection).
    - The total number of pages.

    Parameters:
    file_path: Path to the PDF file.

    Outputs:
    A tuple containing: (is_ocr: boolean, page_count: integer). Is OCR/scanned (requires layout detection)
    - Total page count

    Args:
        file_path: The path to the PDF file

    Returns:
        tuple: (is_ocr: bool, page_count: int)
    """
    try:
        import pymupdf

        doc = pymupdf.open(file_path)
        total_pages = len(doc)

        if total_pages == 0:
            doc.close()
            return False, 0

        # Sample up to 10 pages for analysis (or all if < 10)
        sample_size = min(10, total_pages)
        sample_pages = [doc[i] for i in range(0, total_pages, max(1, total_pages // sample_size))][:sample_size]

        text_pages = 0
        total_text_len = 0
        low_text_pages = 0  # Pages with very little text

        for page in sample_pages:
            # noinspection PyBroadException
            try:
                text = page.get_text()
                text_len = len(text.strip())
            except Exception:
                # Treat unreadable pages (corrupted content) as image-based so the
                # PDF is classified as OCR-requiring rather than clean.
                low_text_pages += 1
                continue

            if text_len > 100:  # Substantial text
                text_pages += 1
                total_text_len += text_len
            elif text_len < 50:  # Very little text (likely scanned/image)
                low_text_pages += 1

        doc.close()

        # Calculate metrics
        text_coverage = text_pages / sample_size if sample_size > 0 else 0
        avg_text_per_page = total_text_len / sample_size if sample_size > 0 else 0
        low_text_ratio = low_text_pages / sample_size if sample_size > 0 else 0

        # Heuristics for OCR/scanning detection
        # Only detect TRUE OCR/scanned documents (not just large PDFs)
        # This preserves CPU optimization for large clean PDFs

        # Strong indicators of an OCR/scanned document
        has_low_text_coverage = text_coverage < 0.4  # <40% — only truly scanned/image-only PDFs use slow Docling
        has_sparse_text = avg_text_per_page < 200  # <200 chars/page (mostly images)
        has_many_empty_pages = low_text_ratio > 0.5  # >50% pages minimal text

        # Require at least ONE strong indicator for OCR classification
        # Don't use page count - that defeats CPU optimization for large clean PDFs
        is_ocr = has_low_text_coverage or has_sparse_text or has_many_empty_pages

        if is_ocr:
            logger.info(
                "Document needs layout detection (OCR/complex structure): "
                "text_coverage=%.2f, avg_text_per_page=%d, low_text_ratio=%.2f, total_pages=%d",
                text_coverage,
                int(avg_text_per_page),
                low_text_ratio,
                total_pages,
            )
        else:
            logger.info(
                "Simple clean PDF detected: text_coverage=%.2f, avg_text_per_page=%d, low_text_ratio=%.2f, total_pages=%d",
                text_coverage,
                int(avg_text_per_page),
                low_text_ratio,
                total_pages,
            )

        return is_ocr, total_pages

    except (RuntimeError, ValueError, AttributeError, OSError) as ex:
        logger.warning("Failed to analyze PDF document: %s; treating as OCR-requiring", str(ex))
        # An unreadable PDF (e.g. corrupted or old format) is far more likely to be a
        # scanned image than a clean text file.  Defaulting to is_ocr=True ensures it
        # goes through the Docling OCR path rather than the non-OCR fast path, which
        # would silently return zero pages.
        return True, 0


def detect_ocr_document(file_path: str) -> bool:
    """
    Detect if a PDF document is OCR or scanned (requires layout detection).

    Note: This is a convenience wrapper around analyze_pdf_document().
    If you also need page count, use analyze_pdf_document() directly to avoid
    opening the file twice.

    Args:
        file_path: The path to the PDF file

    Returns:
        bool: True if a document appears to be OCR/scanned, False for clean PDFs
    """
    is_ocr, _ = analyze_pdf_document(file_path)
    return is_ocr


class DoclingProgressTracker:
    """Tracks Docling processing progress by monitoring log output"""

    def __init__(
        self,
        job_id: str,
        progress_callback,
        start_progress: int = 10,
        end_progress: int = 30,
        page_count: int = 0,
    ):
        self.job_id = job_id
        self.progress_callback = progress_callback
        self.start_progress = start_progress
        self.end_progress = end_progress
        self.monitoring = False
        self.monitor_thread = None
        self.page_batches_completed = 0
        self.estimated_total_batches = self._estimate_page_batches(page_count)
        self.last_progress = start_progress

        # Set up log handler to capture Docling progress
        self.log_handler = DoclingLogHandler(self)

    def start_monitoring(self):
        """Start monitoring Docling progress"""
        self.monitoring = True

        # Add our custom log handler to capture Docling logs
        docling_logger = logging.getLogger("docling.pipeline.base_pipeline")
        docling_logger.addHandler(self.log_handler)
        docling_logger.setLevel(logging.DEBUG)

        logger.debug("Started Docling progress monitoring for job %s", self.job_id)

    def stop_monitoring(self):
        """Stop monitoring Docling progress"""
        self.monitoring = False

        # Remove our log handler
        docling_logger = logging.getLogger("docling.pipeline.base_pipeline")
        docling_logger.removeHandler(self.log_handler)

        logger.debug("Stopped Docling progress monitoring for job %s", self.job_id)

    @staticmethod
    def _estimate_page_batches(page_count: int) -> int:
        """Estimate number of page batches based on PDF page count"""
        if page_count <= 0:
            return 10  # Default fallback

        # Docling typically processes pages in batches
        # Based on observation, Docling seems to process ~1-3 pages per batch
        estimated_batches = max(1, (page_count + 2) // 3)  # Round up division by 3
        logger.debug("Estimated %d page batches for %d pages", estimated_batches, page_count)
        return estimated_batches

    def update_progress_from_batch(self, batch_info: str):
        """Update progress based on batch completion info"""
        if not self.monitoring:
            return

        try:
            # Parse batch completion info - handle both old and new Docling formats
            # New format: "Finished converting pages 4/8"
            # Old format: "Finished converting page batch X"

            pages_match = re.search(r"Finished converting pages? (\d+)/(\d+)", batch_info)
            if pages_match:
                current_page = int(pages_match.group(1))
                total_pages = int(pages_match.group(2))
                self.page_batches_completed = current_page
                self.estimated_total_batches = total_pages
            elif "Finished converting page" in batch_info:
                self.page_batches_completed += 1

            # Calculate progress between start_progress and end_progress
            progress_range = self.end_progress - self.start_progress
            batch_progress = min(self.page_batches_completed / self.estimated_total_batches, 1.0)
            current_progress = self.start_progress + int(progress_range * batch_progress)

            # Only update if progress has increased significantly
            if current_progress > self.last_progress + 2:
                self.last_progress = current_progress

                if self.progress_callback:
                    # Ensure a progress callback is called immediately
                    import asyncio

                    try:
                        # Try async call first
                        if asyncio.iscoroutinefunction(self.progress_callback):
                            asyncio.create_task(
                                self.progress_callback(
                                    self.job_id,
                                    {
                                        "progress": current_progress,
                                        "message": f"convertingPage:{self.page_batches_completed}:{self.estimated_total_batches}",
                                        "status": "processing",
                                    },
                                )
                            )
                        else:
                            # Fallback to sync call
                            self.progress_callback(
                                self.job_id,
                                {
                                    "progress": current_progress,
                                    "message": f"convertingPage:{self.page_batches_completed}:{self.estimated_total_batches}",
                                    "status": "processing",
                                },
                            )
                    except (TypeError, ValueError, RuntimeError) as callback_error:
                        logger.warning("Error in progress callback: %s", str(callback_error))

                logger.debug(
                    "Docling progress update: %d%% (page %d/%d)",
                    current_progress,
                    self.page_batches_completed,
                    self.estimated_total_batches,
                )

        except (ValueError, ZeroDivisionError, AttributeError) as progress_error:
            logger.warning("Error updating Docling progress: %s", str(progress_error))


class DoclingLogHandler(logging.Handler):
    """Custom log handler to capture Docling progress messages"""

    def __init__(self, progress_tracker: DoclingProgressTracker):
        super().__init__()
        self.progress_tracker = progress_tracker

    def emit(self, record):
        """Handle log record from Docling"""
        try:
            message = record.getMessage()
            # Match both old and new Docling log formats
            if "Finished converting page" in message or "Finished converting pages" in message:
                self.progress_tracker.update_progress_from_batch(message)
        except (AttributeError, TypeError):
            # Ignore errors in log handling to avoid disrupting main processing
            pass


def _normalize_device_type(device_type: str) -> str:
    """
    Normalize a device type to valid Docling/Pydantic device options.

    Args:
        device_type: Raw device type from GPU detection

    Returns:
        Normalized device type compatible with Docling AcceleratorOptions
    """
    if not device_type:
        logger.debug("No device type specified, defaulting to CPU")
        return "cpu"

    device_lower = device_type.lower()

    # Map generic 'gpu' to 'cuda' (the most common case)
    if device_lower == "gpu":
        logger.info("Generic GPU detected -> mapped to CUDA")
        return "cuda"

    # Valid device types for Docling: 'auto', 'cpu', 'mps', 'cuda', 'cuda:N'
    valid_types = ["auto", "cpu", "mps", "cuda"]

    if device_lower in valid_types:
        logger.debug("Valid Docling device type: %s", device_lower)
        return device_lower

    # Map ROCm to cuda for Docling compatibility (AMD discrete GPUs with ROCm)
    if device_lower == "rocm":
        logger.info("AMD ROCm GPU detected -> mapped to CUDA for Docling compatibility")
        return "cuda"

    # Map OpenCL to cpu (Docling doesn't support OpenCL - AMD iGPUs cannot be speeded up)
    if device_lower == "opencl":
        logger.warning(
            "AMD iGPU detected (OpenCL) -> using CPU mode. "
            "iGPU acceleration not supported by Docling/PyTorch. "
            "OCR processing will be slower but accurate."
        )
        return "cpu"

    # Map Vulkan to cpu (Docling doesn't support Vulkan directly)
    if device_lower == "vulkan":
        logger.warning(
            "Vulkan GPU detected (likely iGPU) -> using CPU mode. "
            "Vulkan acceleration not supported by Docling. "
            "Consider using PyMuPDF4LLM for faster CPU processing on clean PDFs."
        )
        return "cpu"

    # Default fallback with warning
    logger.warning(
        "Unknown device type '%s' -> defaulting to CPU mode. Supported types: cuda, mps, rocm, auto, cpu",
        device_type,
    )
    return "cpu"


def _clean_pdf_parser() -> str:
    """Configured clean-PDF parser backend (``pymupdf4llm`` default, or ``liteparse``)."""
    from src.main.utils.config.loader import resolved_config

    return str(resolved_config.get("document_processing", {}).get("pdf_parser", "pymupdf4llm")).strip().lower()


def _liteparse_md_result(file_path: str) -> list | None:
    """Parse a clean PDF with LiteParse and shape it like pymupdf4llm's
    ``page_chunks=True`` output (``[{"text", "metadata": {page, width, height}}]``)
    so the existing transforms + chunking consume it unchanged. Returns ``None`` on
    any failure / unavailability so the caller falls back to pymupdf4llm."""
    try:
        from src.main.service.document.parsers.liteparse_parser import LiteParseParser

        parser = LiteParseParser()
        if not parser.is_available():
            return None
        parsed = parser.parse(file_path)
        if not parsed.ok:
            logger.warning("LiteParse clean-PDF parse failed for %s: %s — falling back to pymupdf4llm", file_path, parsed.error)
            return None
        return [{"text": p.text, "metadata": {"page": p.page_number, "width": p.width, "height": p.height}} for p in parsed.pages]
    except Exception as e:
        logger.warning("LiteParse clean-PDF parse error for %s: %s — falling back to pymupdf4llm", file_path, e)
        return None


class PDFProcessor:
    """
    PDF processor for handling PDF documents with GPU acceleration support.

    This class handles all PDF-specific processing including
    - OCR detection and processing
    - GPU-accelerated processing with Docling
    - Fast CPU processing with PyMuPDF4LLM
    - Progress tracking for long-running operations
    """

    @staticmethod
    def process_pdf(
        file_path: str,
        ocr_enabled: bool = False,
        job_id: str | None = None,
        progress_callback: Callable | None = None,
        db=None,
        user_id: str | None = None,
        relative_file_path: str | None = None,
        multimodal_collector: list | None = None,
    ) -> list[LangchainDocument]:
        """
        Process a PDF file and return a list of LangChain Document objects.

        Args:
            file_path: Path to the PDF file (absolute path for processing)
            ocr_enabled: Whether to enable OCR
            job_id: Job ID for progress tracking (optional)
            progress_callback: Callback function for progress updates (optional)
            db: Database session (optional)
            user_id: User ID for tracking (optional)
            relative_file_path: Relative file path to store in metadata (optional, defaults to file_path)

        Returns:
            List of LangchainDocument objects with page-level content

        Raises:
            DocumentProcessingError: If processing fails
        """
        # Import here to avoid circular imports
        from src.main.service.document.document_processor import (
            DocumentProcessingError,
        )

        # Use a relative path for metadata if provided, otherwise use an absolute path
        metadata_file_path = relative_file_path if relative_file_path else file_path

        try:
            # Use cached device type from LLM manager
            from src.main.service.llm.llm_manager import llm_manager

            device_type = llm_manager.device_type

            # Normalize a device type for compatibility
            device_type = _normalize_device_type(device_type)
            logger.info("Normalized device type: %s", device_type)

            logger.info("Processing document using %s resources", device_type.upper())

            # Verify the file exists before processing
            if not validate_file_path(file_path):
                logger.error("File not found: %s", file_path)
                raise FileNotFoundError(f"File not found: {file_path}")

            logger.info(
                "Starting document processing: %s (progress: 2%%)",
                os.path.basename(file_path),
            )

            # STEP 1: Analyze a document in a single pass (OCR detection + page count)
            is_ocr_document, page_count = analyze_pdf_document(file_path)

            # Check PyTorch-CUDA compatibility early to avoid Docling failures
            cuda_compatible = True
            if device_type == "cuda":
                from src.main.utils.gpu.devices import check_pytorch_cuda_compatibility

                is_compatible, incompatibility_reason = check_pytorch_cuda_compatibility()
                if not is_compatible:
                    logger.warning("CUDA incompatibility detected: %s", incompatibility_reason)
                    logger.info("Will use PyMuPDF4LLM (CPU) instead of Docling due to GPU incompatibility")
                    cuda_compatible = False
                    device_type = "cpu"  # Force CPU mode

            # STEP 2: Determine processing strategy based on OCR detection + device
            use_pymupdf = False

            if is_ocr_document:
                if not ocr_enabled:
                    # Scanned / image-only PDF but the user hasn't opted into OCR.
                    # Fail fast so the worker pool isn't tied up for 10-15 minutes
                    # per Docling run. The task-level pre-check in
                    # process_document_task recognises this error prefix and
                    # short-circuits future redeliveries. Re-running with OCR
                    # enabled from the admin UI will take the Docling path below.
                    # Status code per CLAUDE.md rule #3 — frontend translates.
                    raise ValueError("errorScannedPdfOcrDeferred") from None

                # OCR'd documents with OCR opt-in use Docling (layout detection + hierarchy preservation)
                logger.info("OCR/scanned document detected + ocr_enabled=True -> using Docling for layout detection")

                # Warn if OCR on CPU (will be slower)
                if device_type == "cpu":
                    logger.warning(
                        "OCR processing on CPU will be slower (~20-30 sec/page). For faster processing, use a system with NVIDIA GPU (CUDA) support."
                    )

                use_pymupdf = False
                # Force Docling even on CPU for OCR documents (layout detection is critical)
            elif device_type == "cpu" or not cuda_compatible:
                # Clean PDFs on CPU -> use fast pymupdf4llm
                try:
                    import pymupdf4llm  # noqa: F401

                    use_pymupdf = True
                    if not cuda_compatible:
                        logger.info("Using PyMuPDF4LLM for CPU processing (CUDA incompatible) - Fast mode")
                    else:
                        logger.info("Using PyMuPDF4LLM for faster CPU processing (clean PDF) - Fast mode")
                except ImportError:
                    logger.info("PyMuPDF4LLM not available, falling back to Docling")
            else:
                # Clean PDF + GPU -> use Docling
                logger.info("Using Docling with GPU acceleration (clean PDF)")

            # Process using PyMuPDF4LLM if on CPU and available
            if use_pymupdf:
                docs = PDFProcessor._process_pdf_with_pymupdf(
                    file_path,
                    ocr_enabled,
                    job_id,
                    progress_callback,
                    db,
                    user_id,
                    metadata_file_path,
                )
                return _validate_extracted_pdf_documents(docs, file_path)
            else:
                # Use Docling for GPU or OCR documents, with pypdf4llm fallback on failure
                # Enable OCR if a document is detected as OCR'd/scanned
                docling_ocr_enabled = ocr_enabled or is_ocr_document
                try:
                    docs = PDFProcessor._process_pdf_with_docling(
                        file_path,
                        docling_ocr_enabled,
                        job_id,
                        progress_callback,
                        db,
                        user_id,
                        _configure_huggingface_cache,
                        page_count,
                        multimodal_collector,
                    )

                    # Fallback for scanned PDFs where Docling produced nothing.
                    # Docling's layout detector can classify image-only pages as
                    # "text" from the empty text layer and skip OCR entirely,
                    # returning 0 chars. For auto-detected scanned PDFs, run
                    # RapidOCR directly on rendered page images — fast (~1-3 s
                    # per page, Latin script) and memory-bounded.
                    if is_ocr_document and docs is not None:
                        docling_chars = sum(len(d.page_content or "") for d in docs)
                        if docling_chars < _MIN_EXTRACTED_PDF_TEXT_CHARS:
                            logger.warning(
                                "Docling returned only %d chars for auto-detected scanned PDF '%s' (%d pages). Falling back to RapidOCR direct.",
                                docling_chars,
                                os.path.basename(file_path),
                                page_count,
                            )
                            docs = PDFProcessor._process_pdf_with_rapidocr(
                                file_path,
                                page_count,
                                job_id,
                                progress_callback,
                                metadata_file_path,
                            )

                    # Optional OCR escalation: when the default engine still
                    # under-extracted a scanned PDF AND an LLMWhisperer key is
                    # configured, escalate this one doc. INERT (returns None) when
                    # no key is set, so default behaviour is unchanged.
                    if is_ocr_document:
                        from src.main.service.document.ocr.ocr_escalation import maybe_escalate_ocr

                        escalated = maybe_escalate_ocr(
                            file_path,
                            docs or [],
                            page_count,
                            db,
                            user_id,
                            metadata_file_path,
                            job_id,
                            progress_callback,
                        )
                        if escalated is not None:
                            docs = escalated

                    # noinspection PyTypeChecker
                    return _validate_extracted_pdf_documents(docs or [], file_path)
                except (RuntimeError, ValueError, TypeError, AttributeError) as docling_ex:
                    # CRITICAL: OCR documents MUST use Docling for layout detection
                    # Do NOT fall back to PyMuPDF for OCR documents as it loses layout information
                    if is_ocr_document:
                        logger.error(
                            "Docling processing failed for OCR document: %s. "
                            "Cannot fall back to PyMuPDF4LLM as layout detection is critical. "
                            "Re-raising error.",
                            str(docling_ex),
                        )
                        raise docling_ex from docling_ex

                    # For non-OCR documents, fallback to PyMuPDF4LLM is acceptable
                    logger.warning(
                        "Docling processing failed: %s. Attempting fallback to PyMuPDF4LLM (non-OCR document).",
                        str(docling_ex),
                    )

                    # Try to fall back to PyMuPDF4LLM if available
                    try:
                        # pymupdf4llm already imported above at line 306
                        logger.info("Falling back to PyMuPDF4LLM after Docling failure")
                        docs = PDFProcessor._process_pdf_with_pymupdf(
                            file_path,
                            ocr_enabled,
                            job_id,
                            progress_callback,
                            db,
                            user_id,
                            metadata_file_path,
                        )
                        # noinspection PyTypeChecker
                        return _validate_extracted_pdf_documents(docs or [], file_path)
                    except ImportError:
                        logger.error("PyMuPDF4LLM not available for fallback. Re-raising original Docling error.")
                        raise docling_ex from None

        except Exception as ex:
            logger.error("Error processing document: %s", str(ex))

            # Special handling for slice object errors
            if isinstance(ex, TypeError) and "slice" in str(ex):
                error_msg = (
                    f"Error accessing document pages: Invalid document structure. This is likely due to an empty or corrupted PDF file: {file_path}"
                )
                logger.error(error_msg)
                raise DocumentProcessingError(error_msg) from ex

            logger.exception(ex)
            # If the inner raise already used a status code (CLAUDE.md #3),
            # propagate it unchanged so the wrap doesn't bury it in English.
            from src.main.utils.core.error_codes import to_status_code

            inner = str(ex)
            if inner.isidentifier() and inner[0].islower() and inner.isascii():
                raise DocumentProcessingError(inner) from ex
            error_msg = to_status_code(ex)
            raise DocumentProcessingError(error_msg) from ex
        finally:
            # Force garbage collection to free memory
            import gc

            gc.collect()

    @staticmethod
    def _process_pdf_with_rapidocr(
        file_path: str,
        page_count: int,
        job_id: str | None = None,
        progress_callback: Callable | None = None,
        metadata_file_path: str | None = None,
    ) -> list[LangchainDocument]:
        """
        Per-page OCR extraction using RapidOCR directly. Used as a fallback
        when Docling returns no text for an auto-detected scanned PDF.

        Why bypass Docling: Docling's pipeline is optimized for born-digital
        PDFs with complex layout (tables, multi-column). For pure scanned
        books (image-only pages), Docling's layout detector can classify pages
        as "text" from the embedded (empty) text layer and skip OCR, producing
        empty output. RapidOCR called directly on a rendered page image is
        unconditional and fast (~1-3 s per page on CPU with Latin models).

        Memory: ~50 MB peak per page (pixmap + PNG + OCR inference). Sequential
        per-page processing keeps peak bounded; this function is safe to run
        inside the 6 GB worker container.

        Output: one LangChain Document per page with plain OCR text. Downstream
        chunkers treat pages as natural semantic boundaries for books (which
        is what Bucket C docs are — scanned academic books). Layout is not
        preserved, but for single-column prose it is not needed.

        Args:
            file_path: Absolute path to the PDF
            page_count: Total pages (pre-computed from analyze_pdf_document)
            job_id: Optional job ID for progress callbacks
            progress_callback: Optional callable(job_id, dict) for UI updates
            metadata_file_path: Optional relative path to store in doc metadata

        Returns:
            List of LangchainDocument, one per page.
        """
        import pymupdf

        logger.info(
            "RapidOCR fallback starting for '%s' (%d pages)",
            os.path.basename(file_path),
            page_count,
        )
        start_time = time.time()
        ocr = _get_rapidocr_singleton()
        metadata_path = metadata_file_path or file_path

        # CRITICAL: do NOT swallow Celery SoftTimeLimitExceeded inside the
        # per-page try. If we catch it as a generic Exception and continue,
        # the task runs past the soft time limit and eventually hits the hard
        # limit, which SIGKILLs the worker child, which triggers
        # task_reject_on_worker_lost → redeliver → fresh reprocess → death
        # spiral. Let the soft-timeout propagate so the task fails cleanly
        # and Celery can mark it failed via _mark_reprocess_failed.
        try:
            from celery.exceptions import SoftTimeLimitExceeded as _CelerySoftTimeout
        except ImportError:
            _CelerySoftTimeout = None  # defensive — celery always present in workers
        documents: list[LangchainDocument] = []
        pdf = pymupdf.open(file_path)
        try:
            total = pdf.page_count
            for i in range(total):
                page_text = ""
                try:
                    pix = pdf[i].get_pixmap(dpi=200)
                    png_bytes = pix.tobytes("png")
                    result = ocr(png_bytes)
                    if result is not None and getattr(result, "txts", None):
                        page_text = "\n".join(t for t in result.txts if t)
                except BaseException as page_err:
                    # Re-raise task lifecycle signals: soft/hard timeout from
                    # Celery, SystemExit, KeyboardInterrupt. Those are not
                    # "page failed" situations — they mean the task must stop.
                    if _CelerySoftTimeout is not None and isinstance(page_err, _CelerySoftTimeout):
                        raise
                    if isinstance(page_err, (SystemExit, KeyboardInterrupt, GeneratorExit)):
                        raise
                    logger.warning(
                        "RapidOCR fallback: page %d/%d failed: %s",
                        i + 1,
                        total,
                        page_err,
                    )

                documents.append(
                    LangchainDocument(
                        page_content=page_text,
                        metadata={
                            "source": metadata_path,
                            "file_path": metadata_path,
                            "page_number": i + 1,
                            "page": i + 1,
                            "total_pages": total,
                            "extraction_method": "rapidocr_fallback",
                            # Hierarchy metadata so the Neo4j strict-metadata
                            # validator accepts this document. Scanned OCR
                            # output has no structural markers (no markdown
                            # headers, no TOC), so we model the book as a
                            # single implicit chapter with one section per
                            # page. Validator needs >=30% of chunks to carry
                            # chapter_number or section_title; we give 100%.
                            "chapter_number": 1,
                            "chapter_title": "Document",
                            "section_title": f"Page {i + 1}",
                            "section_id": f"page_{i + 1}",
                        },
                    )
                )

                # Emit progress every 5 pages (not every page — too noisy).
                if job_id and progress_callback and (i + 1) % 5 == 0:
                    pct = 15 + int(((i + 1) / total) * 70)  # 15-85% band
                    try:
                        progress_callback(
                            job_id,
                            {
                                "progress": pct,
                                "message": f"ocrFallbackPage:{i + 1}:{total}",
                                "status": "processing",
                            },
                        )
                    except Exception as cb_err:
                        logger.debug("progress_callback raised: %s", cb_err)
        finally:
            pdf.close()

        elapsed = time.time() - start_time
        total_chars = sum(len(d.page_content or "") for d in documents)
        logger.info(
            "RapidOCR fallback completed for '%s': %d pages, %d chars, %.1fs",
            os.path.basename(file_path),
            len(documents),
            total_chars,
            elapsed,
        )
        return documents

    # noinspection PyMethodParameters
    def _process_pdf_with_pymupdf(
        file_path: str,
        ocr_enabled: bool = False,
        job_id: str | None = None,
        progress_callback: Callable | None = None,
        db=None,
        user_id: str | None = None,
        metadata_file_path: str | None = None,
    ) -> list[LangchainDocument]:
        """Process a PDF file using PyMuPDF4LLM for faster CPU performance"""
        try:
            from io import StringIO
            import queue
            import sys
            import threading

            import pymupdf4llm

            # Update progress - start at a lower value to account for setup time
            if job_id and progress_callback:
                progress_callback(
                    job_id,
                    {
                        "progress": 7,
                        "message": "parserInitPyMuPDF",
                        "status": "processing",
                    },
                )

            logger.info("Converting PDF to markdown with PyMuPDF4LLM")
            start_time = time.time()

            # Create a custom stdout capture to parse PyMuPDF4LLM progress
            class PyMuPDFProgressCapture:
                def __init__(self, _job_id, _progress_callback):
                    self.job_id = _job_id
                    self.progress_callback = _progress_callback
                    self.captured_output = StringIO()
                    self.last_progress = 7  # Start from where setup left off
                    self.progress_queue = queue.Queue()
                    self.processing_thread = None
                    self.simulated_progress_thread = None
                    self.stop_processing = threading.Event()
                    self.line_buffer = ""  # Accumulate stdout fragments into complete lines
                    self.buffer_lock = threading.Lock()  # Thread-safe buffer access
                    self.start_time = time.time()
                    self.real_progress_received = False  # Track if we got real progress

                    # Start progress processing thread
                    if self.job_id and self.progress_callback:
                        self.processing_thread = threading.Thread(target=self._process_progress_updates, daemon=True)
                        self.processing_thread.start()
                        # Start simulated progress thread for smoother UX
                        self.simulated_progress_thread = threading.Thread(target=self._simulate_progress, daemon=True)
                        self.simulated_progress_thread.start()

                def _simulate_progress(self):
                    """Send simulated progress updates during PDF parsing for a smoother UX"""
                    # Simulate progress from the current position to 50% over ~60 seconds if no real progress received
                    simulated_progress = self.last_progress + 1  # Start slightly ahead of current progress
                    while not self.stop_processing.is_set() and simulated_progress < 50:
                        time.sleep(2)  # Update every 2 seconds
                        if self.stop_processing.is_set():
                            break
                        # Only send simulated progress if we haven't received real progress
                        if not self.real_progress_received and simulated_progress > self.last_progress:
                            self.last_progress = simulated_progress
                            try:
                                elapsed = time.time() - self.start_time
                                self.progress_callback(
                                    self.job_id,
                                    {
                                        "progress": simulated_progress,
                                        "message": f"parsingPdfElapsed:{int(elapsed)}",
                                        "status": "processing",
                                    },
                                )
                                logger.debug("Simulated progress: %s%%", simulated_progress)
                            except (TypeError, ValueError, RuntimeError) as e:
                                logger.warning("Simulated progress callback error: %s", e)
                        simulated_progress += 3  # Increment by 3% each time

                # noinspection PyUnusedFunction
                def write(self, output_text):
                    """Write method required by sys.stdout interface"""
                    # Write to captured output for debugging
                    self.captured_output.write(output_text)

                    # Also, write to the real stdout if available (for terminal output)
                    if sys.__stdout__ is not None:
                        sys.__stdout__.write(output_text)

                    # Accumulate fragments into complete lines for progress parsing
                    with self.buffer_lock:
                        self.line_buffer += output_text

                        # Process complete lines (those containing newline)
                        while "\n" in self.line_buffer:
                            line, self.line_buffer = self.line_buffer.split("\n", 1)
                            # Queue complete line for progress processing
                            if line.strip() and self.job_id and self.progress_callback:
                                self.progress_queue.put(line)

                    return len(output_text)  # Return number of characters written

                def flush(self):
                    self.captured_output.flush()
                    if sys.__stdout__ is not None:
                        sys.__stdout__.flush()

                def _process_progress_updates(self):
                    """Background thread to process progress updates without blocking the main thread"""
                    logger.debug("PyMuPDF progress processing thread started")
                    while not self.stop_processing.is_set():
                        try:
                            # Get complete line from queue with timeout to allow checking stop event
                            complete_line = self.progress_queue.get(timeout=0.1)

                            # Debug: log what we're parsing
                            logger.debug("PyMuPDF parsing line: %s", complete_line[:100])

                            # Parse progress from PyMuPDF4LLM output: "[====] ( 51/130)" or "( 51/130)"
                            progress_match = re.search(r"\(\s*(\d+)\s*/\s*(\d+)\s*\)", complete_line)
                            if progress_match:
                                current_page = int(progress_match.group(1))
                                total_pages = int(progress_match.group(2))

                                # Calculate percentage (10% to 50% range for PyMuPDF processing)
                                # Widened from 10-30 so big PDFs don't park the UI at "29%"
                                # for the entire parsing phase — final pages were collapsing
                                # into ~2 visible ticks.
                                percentage = 10 + int((current_page / total_pages) * 40)

                                # Only update if progress increased to avoid spam
                                if percentage > self.last_progress:
                                    self.last_progress = percentage
                                    self.real_progress_received = True  # Mark that we got real progress
                                    try:
                                        self.progress_callback(
                                            self.job_id,
                                            {
                                                "progress": percentage,
                                                "message": f"convertingPdfPages:{current_page}:{total_pages}",
                                                "status": "processing",
                                            },
                                        )
                                        logger.info("PyMuPDF progress: %s/%s pages (%s%%)", current_page, total_pages, percentage)
                                    except (TypeError, ValueError, RuntimeError) as e:
                                        logger.warning("Progress callback error: %s", e)
                            else:
                                # Try to parse progress bar format: "[========    ]" or "[=======]"
                                # PyMuPDF4LLM 0.0.24+ uses [=] style progress bars
                                bar_match = re.search(r"\[([=\s]*)]", complete_line)
                                if bar_match:
                                    bar_content = bar_match.group(1)
                                    equals_count = bar_content.count("=")
                                    total_length = len(bar_content) if len(bar_content) > 0 else 40  # Default bar width

                                    if equals_count > 0:
                                        # Estimate percentage from bar length (10% to 50% range)
                                        bar_percentage = 10 + int((equals_count / max(total_length, equals_count)) * 40)

                                        # Only update if progress increased by at least 5% to avoid spam
                                        if bar_percentage > self.last_progress + 4:
                                            self.last_progress = bar_percentage
                                            self.real_progress_received = True  # Mark that we got real progress
                                            try:
                                                self.progress_callback(
                                                    self.job_id,
                                                    {
                                                        "progress": bar_percentage,
                                                        "message": f"convertingPdfPct:{bar_percentage}",
                                                        "status": "processing",
                                                    },
                                                )
                                                logger.info("PyMuPDF progress bar: %s%%", bar_percentage)
                                            except (TypeError, ValueError, RuntimeError) as e:
                                                logger.warning("Progress callback error: %s", e)

                            # Mark the task as done
                            self.progress_queue.task_done()

                        except queue.Empty:
                            # Timeout occurred, continue to check stop event
                            continue
                        except (ValueError, AttributeError, RuntimeError) as e:
                            logger.warning("Progress processing thread error: %s", e)
                    logger.debug("PyMuPDF progress processing thread stopped")

                def stop(self):
                    """Stop the progress of processing threads"""
                    self.stop_processing.set()
                    if self.processing_thread and self.processing_thread.is_alive():
                        # Wait for the thread to finish with timeout
                        self.processing_thread.join(timeout=1.0)
                    if self.simulated_progress_thread and self.simulated_progress_thread.is_alive():
                        # Wait for the simulated progress thread to finish
                        self.simulated_progress_thread.join(timeout=1.0)

            # Phase 6: pluggable clean-PDF parser. When pdf_parser=liteparse, parse
            # with LiteParse (Apache-2.0) instead of pymupdf4llm (AGPL); the
            # downstream transforms + chunking are parser-agnostic. Falls back to
            # pymupdf4llm on failure. Default (pymupdf4llm) leaves the path unchanged.
            md_result = None
            if _clean_pdf_parser() == "liteparse":
                md_result = _liteparse_md_result(file_path)
                if md_result is not None:
                    logger.info("Clean-PDF parsed via LiteParse for %s (%d pages)", file_path, len(md_result))

            # Capture PyMuPDF4LLM stdout to parse progress
            progress_capture = PyMuPDFProgressCapture(job_id, progress_callback)
            old_stdout = None
            try:
                if md_result is None:
                    # Redirect stdout to capture PyMuPDF4LLM progress
                    old_stdout = sys.stdout
                    sys.stdout = progress_capture

                    # Process with PyMuPDF4LLM with page chunks to preserve page information
                    # show_progress=True will now output to our custom stdout capture
                    # hdr_info=None uses default header detection (font size based)
                    md_result = pymupdf4llm.to_markdown(file_path, page_chunks=True, show_progress=True, hdr_info=None)

            finally:
                # Restore original stdout (only if we redirected it)
                if old_stdout is not None:
                    sys.stdout = old_stdout
                # Stop the progress processing thread
                progress_capture.stop()

            # Shadow comparison reuse: hand this already-computed raw parse to the
            # comparison harness so it doesn't re-pay the ~90s pymupdf parse. Cheap
            # + best-effort; only when shadow is enabled.
            try:
                from src.main.service.document.parser_comparison_service import is_enabled, stash_production_parse

                if is_enabled():
                    from src.main.service.document.parsers.pymupdf_parser import PyMuPdf4LlmParser

                    # Label the stash with the parser actually used this run (pymupdf4llm
                    # OR liteparse) so the comparison reuses it under the right name and
                    # parses the OTHER backend fresh — works whichever is production.
                    _prod_parsed = PyMuPdf4LlmParser.from_raw_result(md_result)
                    _prod_parsed.parser_name = _clean_pdf_parser()
                    stash_production_parse(file_path, _prod_parsed)
            except Exception:
                pass

            # Update with a success message after conversion
            if job_id and progress_callback:
                progress_callback(
                    job_id,
                    {
                        "progress": 50,
                        "message": f"pdfConvertedTime:{format_processing_time(start_time)}",
                        "status": "processing",
                    },
                )

            # Process the result with page information preservation
            page_documents = PDFProcessor._process_pymupdf_result_with_pages(md_result, file_path, metadata_file_path)

            # Import shared chunking method
            from src.main.service.document.document_processor import DocumentProcessor

            return DocumentProcessor.apply_chunking_and_return_documents_with_pages(
                page_documents, file_path, db, user_id, metadata_file_path, job_id, progress_callback
            )

        except ImportError as ex:
            logger.warning("PyMuPDF4LLM not available: %s. Falling back to Docling.", str(ex))
            return PDFProcessor._process_pdf_with_docling(
                file_path, ocr_enabled, job_id, progress_callback, db, user_id, _configure_huggingface_cache
            )
        except (SoftTimeLimitExceeded, SystemExit, KeyboardInterrupt, GeneratorExit):
            # Per memory note feedback_celery_propagate_task_signals.md:
            # Celery task loops MUST re-raise SoftTimeLimitExceeded so the
            # task aborts cleanly. Without this re-raise, the bare
            # `except Exception` below caught the timeout, ran the plain
            # pymupdf fallback inside the same already-expired budget, and
            # the next yield point fired SoftTimeLimitExceeded again — the
            # task ended up reported as failed AFTER an extra retry storm.
            raise
        except Exception as ex:
            logger.warning("PyMuPDF4LLM layout failed: %s — trying plain pymupdf text extraction", str(ex))

            # Intermediate fallback: plain pymupdf text → page documents → chunking
            # Avoids heavy Docling for PDFs that simply lack StructTreeRoot
            try:
                import pymupdf

                doc = pymupdf.open(file_path)
                page_documents = []
                # noinspection PyTypeChecker
                for page_num, page in enumerate(doc, start=1):
                    page_text = page.get_text("text")
                    if page_text and page_text.strip():
                        page_documents.append(
                            LangchainDocument(
                                page_content=page_text,
                                metadata={
                                    "source": file_path,
                                    "page": page_num,
                                    "page_number": page_num,
                                    "total_pages": len(doc),
                                },
                            )
                        )
                doc.close()

                if page_documents:
                    logger.info("pymupdf plain-text fallback extracted %d pages", len(page_documents))
                    if job_id and progress_callback:
                        progress_callback(
                            job_id,
                            {
                                "progress": 50,
                                "message": "pdfPlainTextFallback",
                                "status": "processing",
                            },
                        )

                    from src.main.service.document.document_processor import DocumentProcessor

                    return DocumentProcessor.apply_chunking_and_return_documents_with_pages(
                        page_documents, file_path, db, user_id, metadata_file_path, job_id, progress_callback
                    )
                logger.warning("pymupdf plain-text fallback returned no pages — deferring OCR (Docling not invoked)")
            except Exception as fallback_ex:
                logger.warning("pymupdf plain-text fallback also failed: %s — deferring OCR (Docling not invoked)", str(fallback_ex))

            # Plain pymupdf could not extract text either — this is a scanned PDF
            # disguised as clean (classifier missed it). Fail fast with the same
            # marker the pre-check recognises instead of tying the worker up in
            # Docling for the next 10-15 minutes. The user can retry with OCR
            # enabled from the admin UI once the main queue has drained.
            if ocr_enabled:
                return PDFProcessor._process_pdf_with_docling(
                    file_path, ocr_enabled, job_id, progress_callback, db, user_id, _configure_huggingface_cache
                )
            # Status code per CLAUDE.md rule #3 — frontend translates.
            raise ValueError("errorScannedPdfOcrDeferred") from None

    @staticmethod
    def _process_pdf_with_docling(
        file_path: str,
        ocr_enabled: bool = False,
        job_id: str | None = None,
        progress_callback: Callable | None = None,
        db=None,
        user_id: str | None = None,
        configure_cache_func: Callable | None = None,
        page_count: int = 0,
        multimodal_collector: list | None = None,
    ) -> list[LangchainDocument]:
        """Process a PDF file using Docling (supports GPU acceleration).

        When `multimodal_collector` is supplied, image / table / equation
        elements found in the converted document are appended as
        `MultimodalElementDraft` instances. The caller persists them
        once the document_id is known.
        """
        try:
            # Use cached device type from LLM manager
            from src.main.service.llm.llm_manager import llm_manager

            device_type = llm_manager.device_type

            # Normalize device type for Docling compatibility
            device_type = _normalize_device_type(device_type)
            logger.info("Normalized device type for Docling: %s", device_type)

            # Check for any GPU-related device type (gpu, cuda, opencl, etc.)
            has_gpu: bool = bool(device_type) and device_type.lower() not in ["cpu", "auto"]

            # Check PyTorch-CUDA compatibility if trying to use CUDA
            if has_gpu and device_type.lower() == "cuda":
                from src.main.utils.gpu.devices import check_pytorch_cuda_compatibility

                is_compatible, incompatibility_reason = check_pytorch_cuda_compatibility()
                if not is_compatible:
                    logger.warning("CUDA incompatibility detected: %s", incompatibility_reason)
                    logger.info("Forcing Docling to use CPU mode due to GPU incompatibility")
                    device_type = "cpu"
                    has_gpu = False

            logger.info(
                "LLM manager device type: %s, using GPU for Docling: %s",
                device_type,
                has_gpu,
            )

            # Update progress
            if job_id and progress_callback:
                progress_callback(
                    job_id,
                    {
                        "progress": 5,
                        "message": "doclingInit",
                        "status": "processing",
                    },
                )

            # Setup environment for optimal performance
            setup_docling_environment(has_gpu, device_type)

            # Configure local model cache for Docling models
            if configure_cache_func and configure_cache_func():
                # Set Docling-specific cache directory
                logger.info("Configured Docling to use local model cache")

            # Configure pipeline options with proper AcceleratorOptions
            pipeline_options = PdfPipelineOptions()

            # Configure AcceleratorOptions according to official Docling documentation
            # See: https://docling-project.github.io/docling/examples/run_with_accelerator/
            try:
                from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions

                # Map device types to the official AcceleratorDevice enum
                if device_type == "cuda":
                    accelerator_device = AcceleratorDevice.CUDA
                elif device_type == "mps":
                    accelerator_device = AcceleratorDevice.MPS
                elif device_type == "cpu":
                    accelerator_device = AcceleratorDevice.CPU
                else:
                    # Fallback to AUTO for unknown device types
                    accelerator_device = AcceleratorDevice.AUTO

                # Create AcceleratorOptions with proper device configuration
                accelerator_options = AcceleratorOptions(num_threads=8, device=accelerator_device)  # Reasonable default

                pipeline_options.accelerator_options = accelerator_options
                logger.info(
                    "Configured Docling AcceleratorOptions: device=%s, threads=8",
                    accelerator_device.value,
                )

            except ImportError as ex:
                logger.warning(
                    "Could not import AcceleratorOptions, using stub configuration: %s",
                    str(ex),
                )
                # Use stub classes as fallback
                from src.main.dto.docling_stubs import AcceleratorDevice, AcceleratorOptions

                # Create stub AcceleratorOptions with CPU fallback
                accelerator_options = AcceleratorOptions(num_threads=8, device=AcceleratorDevice.CPU)
                pipeline_options.accelerator_options = accelerator_options
                logger.info("Using stub AcceleratorOptions with CPU device")

            # Configure other pipeline options
            pipeline_options = configure_docling_pipeline_options(pipeline_options, has_gpu, ocr_enabled)

            # Create format options
            format_options = {
                InputFormat.PDF: PdfFormatOption(
                    pipeline_cls=StandardPdfPipeline,
                    backend=PyPdfiumDocumentBackend,
                    pipeline_options=pipeline_options,
                )
            }

            # Create a converter with optimized settings
            converter = DocumentConverter(
                format_options=format_options,
                # Additional optimization settings could go here
            )

            logger.info("Converting PDF with Docling (GPU: %s, OCR: %s)", has_gpu, ocr_enabled)

            # Update progress
            if job_id and progress_callback:
                progress_callback(
                    job_id,
                    {
                        "progress": 10,
                        "message": "doclingConverting",
                        "status": "processing",
                    },
                )

            start_time = time.time()

            # Set up progress tracking for Docling (10-70% to match PyMuPDF)
            docling_progress_tracker = None
            if job_id and progress_callback:
                docling_progress_tracker = DoclingProgressTracker(
                    job_id,
                    progress_callback,
                    start_progress=10,
                    end_progress=70,
                    page_count=page_count,
                )
                docling_progress_tracker.start_monitoring()

            try:
                # Convert the document
                conversion_result = converter.convert(file_path)
            finally:
                # Stop progress tracking
                if docling_progress_tracker:
                    docling_progress_tracker.stop_monitoring()

            logger.info("Docling conversion completed in %s", format_processing_time(start_time))

            # Update progress
            if job_id and progress_callback:
                progress_callback(
                    job_id,
                    {
                        "progress": 70,
                        "message": f"pdfConvertedTime:{format_processing_time(start_time)}",
                        "status": "processing",
                    },
                )

            if multimodal_collector is not None:
                try:
                    from src.main.service.document_processing.multimodal_pipeline import (
                        collect_drafts,
                    )

                    drafts = collect_drafts(conversion_result.document)
                    multimodal_collector.extend(drafts)
                    logger.info("Collected %d multimodal drafts from Docling result", len(drafts))
                except Exception as ex:
                    logger.warning("Multimodal extraction skipped due to error: %s", ex)

            # Extract page-level documents with page information
            page_documents = PDFProcessor._extract_page_documents_from_docling_result(conversion_result, file_path, job_id, progress_callback)

            # Import shared chunking method
            from src.main.service.document.document_processor import DocumentProcessor

            return DocumentProcessor.apply_chunking_and_return_documents_with_pages(
                page_documents, file_path, db, user_id, None, job_id, progress_callback
            )

        except Exception as ex:
            logger.error("Error processing with Docling: %s", str(ex))

            # Check for specific Windows symlink errors
            if "WinError 1314" in str(ex) or "symlink" in str(ex).lower():
                logger.error(
                    "Windows symlink privilege error detected. This may be due to insufficient privileges for creating symlinks in HuggingFace cache."
                )
                logger.info("Consider running as administrator or using PyMuPDF4LLM fallback.")

            # Check for HuggingFace download errors
            if "huggingface" in str(ex).lower() or "snapshot_download" in str(ex):
                logger.error("HuggingFace model download error. Check network connectivity and cache permissions.")

            logger.exception(ex)
            raise

    @staticmethod
    def _concatenate_paragraph_lines(text: str) -> str:
        """
        Concatenate paragraph lines that are split mid-sentence while preserving headers and spacing.

        PDFs often break paragraphs across multiple lines. This function rejoins lines that are
        part of the same paragraph while keeping:
        - Lines with extra spacing (headers, page numbers)
        - Blank lines (paragraph breaks)
        - Lines ending with sentence-ending punctuation

        Args:
            text: The raw Markdown text with split paragraphs

        Returns:
            Text with paragraph lines concatenated
        """
        if not text or len(text.strip()) < 10:
            return text

        lines = text.split("\n")
        result_lines = []
        i = 0

        while i < len(lines):
            current_line = lines[i]
            current_stripped = current_line.strip()

            # Keep blank lines (paragraph breaks)
            if not current_stripped:
                result_lines.append(current_line)
                i += 1
                continue

            # Keep lines with significant leading whitespace (likely headers/indented content)
            # Check if the line has more than 10 spaces at the start
            leading_spaces = len(current_line) - len(current_line.lstrip())
            if leading_spaces > 10:
                result_lines.append(current_line)
                i += 1
                continue

            # Check if this line should be concatenated with the next
            # Concatenate if:
            # 1. The next line exists
            # 2. The next line is not blank
            # 3. The current line doesn't end with sentence-ending punctuation (., !, ?, :)
            # 4. Next line doesn't have significant indentation (not a header)
            should_concatenate = False
            if i + 1 < len(lines):
                next_line = lines[i + 1]
                next_stripped = next_line.strip()
                next_leading_spaces = len(next_line) - len(next_line.lstrip())

                # Check if the current line ends mid-sentence
                ends_with_sentence = current_stripped and current_stripped[-1] in ".!?:"

                # Check if the next line is a continuation (not blank, not heavily indented)
                is_next_continuation = next_stripped and next_leading_spaces <= 10

                should_concatenate = (
                    is_next_continuation
                    and not ends_with_sentence
                    and not current_stripped.endswith("**")  # Not a Markdown bold end
                    and not current_stripped.startswith("#")  # Not a Markdown header
                )

            if should_concatenate:
                # Concatenate with the next line, adding a space
                next_stripped = lines[i + 1].strip()
                current_stripped = current_stripped + " " + next_stripped
                i += 1  # Skip the next line since we've merged it

                # Continue merging while possible
                while i + 1 < len(lines):
                    next_line = lines[i + 1]
                    next_stripped = next_line.strip()
                    next_leading_spaces = len(next_line) - len(next_line.lstrip())

                    if not next_stripped or next_leading_spaces > 10:
                        break  # Stop at the blank line or indented line

                    ends_with_sentence = current_stripped and current_stripped[-1] in ".!?:"
                    if ends_with_sentence:
                        break  # Stop after sentence-ending punctuation

                    current_stripped = current_stripped + " " + next_stripped
                    i += 1

                result_lines.append(current_stripped)
            else:
                # Keep line as-is
                result_lines.append(current_line)

            i += 1

        return "\n".join(result_lines)

    @staticmethod
    def _enhance_markdown_with_headers(text: str) -> str:
        """
        Enhance Markdown text by adding proper Markdown headers for detected chapters.

        PyMuPDF4LLM outputs plain text without Markdown headers. This function detects
        chapter-like patterns and converts them to proper Markdown headers (# Chapter X).

        Supports:
        - "CHAPTER 1", "Chapter One", "Ch. 1"
        - Roman numerals: "I.", "II.", "Chapter I"
        - Simple numbers: "1.", "2."
        - Numbered with text: "1 Introduction"

        Args:
            text: The raw Markdown text from PyMuPDF4LLM

        Returns:
            Enhanced Markdown with proper headers
        """
        if not text or len(text.strip()) < 10:
            return text

        # First, concatenate paragraph lines that are split mid-sentence
        text = PDFProcessor._concatenate_paragraph_lines(text)

        # Roman numeral conversion map
        roman_to_int = {
            "i": 1,
            "ii": 2,
            "iii": 3,
            "iv": 4,
            "v": 5,
            "vi": 6,
            "vii": 7,
            "viii": 8,
            "ix": 9,
            "x": 10,
            "xi": 11,
            "xii": 12,
            "xiii": 13,
            "xiv": 14,
            "xv": 15,
            "xvi": 16,
            "xvii": 17,
            "xviii": 18,
            "xix": 19,
            "xx": 20,
        }

        # Spelled-out numbers map
        word_to_int = {
            "one": "1",
            "two": "2",
            "three": "3",
            "four": "4",
            "five": "5",
            "six": "6",
            "seven": "7",
            "eight": "8",
            "nine": "9",
            "ten": "10",
            "eleven": "11",
            "twelve": "12",
            "thirteen": "13",
            "fourteen": "14",
            "fifteen": "15",
            "sixteen": "16",
            "seventeen": "17",
            "eighteen": "18",
            "nineteen": "19",
            "twenty": "20",
        }

        lines = text.split("\n")
        enhanced_lines = []
        i = 0

        while i < len(lines):
            line = lines[i]
            line_stripped = line.strip()
            chapter_detected = False

            # Initialize chapter_match before pattern matching (maybe set in Pattern 1)
            chapter_match = None

            # Pattern 0: "CHAPTER" on one line, number on the next line (e.g., "**CHAPTER**\n###### **1**")
            # First clean the line by removing ALL Markdown formatting for pattern matching
            cleaned_line = re.sub(r"^[#\s]*", "", line_stripped)  # Remove leading # and spaces
            cleaned_line = re.sub(r"[*]+", "", cleaned_line).strip()  # Remove all asterisks
            if re.match(r"^(?:chapter|chap\.?|ch\.?)$", cleaned_line.lower(), re.IGNORECASE):
                # Look ahead for chapter number on next line
                if i + 1 < len(lines):
                    next_line = lines[i + 1].strip()
                    # Remove Markdown formatting (**, ######, etc.) to extract the number
                    cleaned_next = re.sub(r"[*#]+", "", next_line).strip()
                    # Check if it's a number or roman numeral
                    if re.match(r"^\d+$", cleaned_next):
                        chapter_num = cleaned_next
                        enhanced_lines.append(f"\n# Chapter {chapter_num}\n")
                        logger.debug("Detected chapter pattern (split lines): Chapter %s", chapter_num)
                        i += 2  # Skip both lines
                        chapter_detected = True
                    elif cleaned_next.lower() in roman_to_int:
                        chapter_num = roman_to_int[cleaned_next.lower()]
                        enhanced_lines.append(f"\n# Chapter {chapter_num}\n")
                        logger.debug("Detected chapter pattern (split lines, roman): Chapter %s", chapter_num)
                        i += 2  # Skip both lines
                        chapter_detected = True

            if not chapter_detected:
                # Pattern 1: "CHAPTER X" or "Chapter X" (with optional Markdown formatting)
                # Only match Markdown headers or short standalone lines (< 80 chars)
                # to avoid false positives on content like "**Chapter 1.** T'ien-pao was..."
                is_header = line_stripped.startswith("#")
                is_short = len(line_stripped) < 80
                if is_header or is_short:
                    chapter_match = re.match(
                        r"^[#*\s]*(?:chapter|chap\.?|ch\.?)\s*([ivxlcdm]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen"
                        r"|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?:\s*[-:.]?\s*(.*))?[*\s]*$",
                        line_stripped,
                        re.IGNORECASE,
                    )

            if chapter_match and not chapter_detected:
                chapter_id = chapter_match.group(1).lower()
                # noinspection PyUnresolvedReferences
                chapter_title = chapter_match.group(2) if chapter_match.lastindex is not None and chapter_match.lastindex >= 2 else ""

                # Clean bold/italic markers from captured title (e.g., "**" artifacts)
                if chapter_title:
                    chapter_title = re.sub(r"[*_]+", "", chapter_title).strip()

                # Convert roman numerals or words to numbers
                if chapter_id in roman_to_int:
                    chapter_num = str(roman_to_int[chapter_id])
                elif chapter_id in word_to_int:
                    chapter_num = word_to_int[chapter_id]
                else:
                    chapter_num = chapter_id

                # Build the header
                if chapter_title and chapter_title.strip():
                    enhanced_lines.append(f"\n# Chapter {chapter_num}: {chapter_title.strip()}\n")
                else:
                    enhanced_lines.append(f"\n# Chapter {chapter_num}\n")

                logger.debug("Detected chapter pattern: Chapter %s", chapter_num)
                chapter_detected = True

            if not chapter_detected:
                # Pattern 2: Just a roman numeral on its own line (e.g., "I.", "II.")
                roman_match = re.match(r"^([ivxlcdm]+)\.?\s*$", line_stripped, re.IGNORECASE)
                if roman_match:
                    roman = roman_match.group(1).lower()
                    if roman in roman_to_int:
                        chapter_num = roman_to_int[roman]
                        enhanced_lines.append(f"\n# Chapter {chapter_num}\n")
                        logger.debug("Detected roman numeral chapter: %s -> Chapter %d", roman.upper(), chapter_num)
                        chapter_detected = True

            if not chapter_detected:
                # Pattern 3: Number with title (e.g., "1 Introduction", "2. Methods")
                # But avoid matching page numbers or list items
                num_title_match = re.match(r"^(\d+)\.?\s+([A-Z][a-zA-Z\s]{2,50})$", line_stripped)
                if num_title_match:
                    num = num_title_match.group(1)
                    title = num_title_match.group(2).strip()
                    # Only convert if it looks like a section header (not too long, starts with capital)
                    if len(title) < 50 and title[0].isupper():
                        enhanced_lines.append(f"\n## {num}. {title}\n")
                        logger.debug("Detected numbered section: %s. %s", num, title)
                        chapter_detected = True

            if not chapter_detected:
                # Keep the original line
                enhanced_lines.append(line)

            i += 1

        return "\n".join(enhanced_lines)

    @staticmethod
    def _strip_open_access_boilerplate(text: str) -> str:
        """
        Thin wrapper around the shared `strip_publisher_boilerplate` util so
        the markdown_content reprocess path (`document_processing/documents.py`)
        and the PDF parse path stay aligned on the same pattern set. New
        publisher patterns go into `utils/markdown_boilerplate.py`.
        """
        from src.main.utils.text.markdown import strip_publisher_boilerplate

        return strip_publisher_boilerplate(text)

    @staticmethod
    def _clean_pymupdf_code_blocks(text: str) -> str:
        """
        Clean up PyMuPDF4LLM's code block artifacts.

        PyMuPDF4LLM sometimes wraps normal text in code blocks (```).
        This function removes unnecessary code block markers while preserving
        legitimate code blocks.

        Args:
            text: The Markdown text with potential code block artifacts

        Returns:
            Cleaned Markdown text
        """
        if not text:
            return text

        lines = text.split("\n")
        cleaned_lines = []
        in_code_block = False
        code_block_content = []

        for line in lines:
            if line.strip().startswith("```"):
                if in_code_block:
                    # End of code block
                    # Check if content looks like normal text (not code)
                    content = "\n".join(code_block_content)
                    if PDFProcessor._is_likely_prose(content):
                        # It's prose, not code - remove the code block markers
                        cleaned_lines.extend(code_block_content)
                    else:
                        # Keep as a code block
                        cleaned_lines.append("```")
                        cleaned_lines.extend(code_block_content)
                        cleaned_lines.append("```")
                    code_block_content = []
                    in_code_block = False
                else:
                    # Start of code block
                    in_code_block = True
            elif in_code_block:
                code_block_content.append(line)
            else:
                cleaned_lines.append(line)

        # Handle unclosed code block
        if code_block_content:
            cleaned_lines.extend(code_block_content)

        return "\n".join(cleaned_lines)

    @staticmethod
    def _is_likely_prose(text: str) -> bool:
        """Check if text is likely prose (normal text) rather than code."""
        if not text or len(text.strip()) < 20:
            return True

        # Count indicators of prose vs. code
        prose_indicators = 0
        code_indicators = 0

        # Prose indicators
        if re.search(r"[.!?]\s+[A-Z]", text):  # Sentence boundaries
            prose_indicators += 2
        if re.search(r"\b(the|and|is|are|was|were|have|has|been|being)\b", text, re.IGNORECASE):
            prose_indicators += 2
        if len(re.findall(r"[A-Za-z]+", text)) > 10:  # Many words
            prose_indicators += 1

        # Code indicators
        if re.search(r"[{}\[\]();]", text):  # Code punctuation
            code_indicators += 2
        if re.search(r"^\s*(def|class|function|import|from|var|let|const)\s", text, re.MULTILINE):
            code_indicators += 3
        if re.search(r"[=<>!]+", text):  # Operators
            code_indicators += 1

        return prose_indicators > code_indicators

    @staticmethod
    def _process_pymupdf_result_with_pages(md_result, file_path: str, metadata_file_path: str | None = None) -> list[LangchainDocument]:
        """
        Process PyMuPDF4LLM result preserving page information.

        Args:
            md_result: Result from pymupdf4llm.to_markdown() with page_chunks=True
            file_path: Path to the source PDF file
            metadata_file_path: Optional path for metadata (defaults to file_path)

        Returns:
            List of LangchainDocument objects with page-level content
        """
        metadata_file_path = metadata_file_path or file_path
        documents = []

        # Try to extract the book title from the first page or document metadata
        book_title: str = ""

        try:
            if isinstance(md_result, list) and len(md_result) > 0:
                # page_chunks=True returns a list of dicts with 'text' and 'metadata'
                first_page = md_result[0]
                if isinstance(first_page, dict) and "metadata" in first_page:
                    book_title = first_page["metadata"].get("title") or ""
                    if book_title:
                        logger.info("Extracted book title from PyMuPDF metadata: %s", book_title)
        except (KeyError, IndexError, TypeError) as ex:
            logger.debug("Could not extract book title from PyMuPDF result: %s", str(ex))

        if isinstance(md_result, list):
            # Process each page
            for page_data in md_result:
                if isinstance(page_data, dict):
                    # Extract text and metadata
                    page_text = page_data.get("text", "")
                    page_metadata = page_data.get("metadata", {})

                    # Get page number (pymupdf4llm uses "page_number" key, 1-indexed)
                    page_num = page_metadata.get("page_number", page_metadata.get("page", 1))

                    # Enhance text with proper Markdown headers
                    enhanced_text = PDFProcessor._enhance_markdown_with_headers(page_text)

                    # Clean up code block artifacts
                    enhanced_text = PDFProcessor._clean_pymupdf_code_blocks(enhanced_text)

                    # Strip per-page open-access publisher boilerplate
                    enhanced_text = PDFProcessor._strip_open_access_boilerplate(enhanced_text)

                    # Extract the printed page number if available
                    printed_page = _extract_printed_page_number(enhanced_text)

                    # Build document metadata
                    doc_metadata = {
                        "source": metadata_file_path,
                        "file_name": os.path.basename(file_path),
                        "type": "pdf",
                        "page": page_num,
                        "pdf_page": page_num,  # Sequential PDF page number
                    }

                    # Add a printed page number if detected
                    if printed_page:
                        doc_metadata["printed_page"] = printed_page

                    # Add a book title if available
                    if book_title:
                        doc_metadata["book_title"] = book_title

                    # Copy additional metadata from PyMuPDF
                    for key in ["title", "author", "subject", "keywords"]:
                        if page_metadata.get(key):
                            doc_metadata[key] = page_metadata[key]

                    try:
                        from src.main.service.document.chunk_position import page_bbox_from_pymupdf_metadata

                        page_bbox = page_bbox_from_pymupdf_metadata(page_metadata)
                    except Exception:
                        page_bbox = None
                    if page_bbox:
                        doc_metadata["page_bbox"] = page_bbox

                    doc = LangchainDocument(
                        page_content=enhanced_text,
                        metadata=doc_metadata,
                    )
                    documents.append(doc)
                else:
                    # Fallback for unexpected format
                    logger.warning("Unexpected page data format: %s", type(page_data))

        elif isinstance(md_result, str):
            # Single string result (no page chunks)
            enhanced_text = PDFProcessor._enhance_markdown_with_headers(md_result)
            enhanced_text = PDFProcessor._clean_pymupdf_code_blocks(enhanced_text)
            enhanced_text = PDFProcessor._strip_open_access_boilerplate(enhanced_text)

            doc = LangchainDocument(
                page_content=enhanced_text,
                metadata={
                    "source": metadata_file_path,
                    "file_name": os.path.basename(file_path),
                    "type": "pdf",
                    "page": 1,
                },
            )
            documents.append(doc)

        logger.info("Processed PyMuPDF result into %d page documents", len(documents))
        return documents

    @staticmethod
    def _extract_page_documents_from_docling_result(
        conversion_result,
        file_path: str,
        job_id: str | None = None,
        progress_callback: Callable | None = None,
    ) -> list[LangchainDocument]:
        """
        Extract page-level documents from a Docling conversion result.

        Args:
            conversion_result: Result from Docling DocumentConverter.convert()
            file_path: Path to the source PDF file
            job_id: Optional job ID for progress tracking
            progress_callback: Optional callback for progress updates

        Returns:
            List of LangchainDocument objects with page-level content
        """
        metadata_file_path = file_path
        documents = []

        # Try to extract the book title from Docling document metadata
        book_title: str = ""

        try:
            doc = conversion_result.document
            if hasattr(doc, "name") and doc.name:
                book_title = doc.name
                logger.info("Extracted book title from Docling metadata: %s", book_title)
            elif hasattr(doc, "title") and doc.title:
                book_title = doc.title
                logger.info("Extracted book title from Docling metadata: %s", book_title)
        except (AttributeError, TypeError) as ex:
            logger.debug("Could not extract book title from Docling result: %s", str(ex))

        try:
            # Try to extract page-level content from a Docling result
            doc = conversion_result.document

            # Check if we can iterate over pages
            if hasattr(doc, "pages") and doc.pages:
                total_pages = len(doc.pages)
                logger.info("Extracting content from %d pages", total_pages)

                for page_idx, page in enumerate(doc.pages):
                    # Update progress
                    if job_id and progress_callback and page_idx % 10 == 0:
                        progress = 70 + int((page_idx / total_pages) * 5)
                        progress_callback(
                            job_id,
                            {
                                "progress": progress,
                                "message": f"extractingPage:{page_idx + 1}:{total_pages}",
                                "status": "processing",
                            },
                        )

                    # Extract page content
                    try:
                        # Try to get Markdown export for this page
                        if hasattr(page, "export_to_markdown"):
                            md_text = page.export_to_markdown()
                        elif hasattr(page, "text"):
                            md_text = page.text
                        else:
                            # Fallback: convert page elements to text
                            md_text = str(page)

                        # Enhance Markdown with proper headers
                        md_text = PDFProcessor._enhance_markdown_with_headers(md_text)
                        md_text = PDFProcessor._strip_open_access_boilerplate(md_text)

                        # Extract the printed page number if available
                        printed_page = _extract_printed_page_number(md_text)

                        # Build metadata
                        metadata = {
                            "source": metadata_file_path,
                            "file_name": os.path.basename(file_path),
                            "type": "pdf",
                            "page": page_idx + 1,
                            "pdf_page": page_idx + 1,
                        }

                        if printed_page:
                            metadata["printed_page"] = printed_page

                        if book_title:
                            metadata["book_title"] = book_title

                        try:
                            from src.main.service.document.chunk_position import page_bbox_from_docling_page

                            page_bbox = page_bbox_from_docling_page(page)
                        except Exception:
                            page_bbox = None
                        if page_bbox:
                            metadata["page_bbox"] = page_bbox

                        doc_obj = LangchainDocument(
                            page_content=md_text,
                            metadata=metadata,
                        )
                        documents.append(doc_obj)

                    except (AttributeError, ValueError, TypeError) as page_ex:
                        logger.warning("Could not extract content from page %d: %s", page_idx + 1, str(page_ex))

            else:
                # Fallback: export an entire document as Markdown
                logger.info("No page-level access, exporting full document")
                md_text = doc.export_to_markdown()

                # Enhance Markdown with proper headers
                md_text = PDFProcessor._enhance_markdown_with_headers(md_text)
                md_text = PDFProcessor._strip_open_access_boilerplate(md_text)

                metadata = {
                    "source": metadata_file_path,
                    "file_name": os.path.basename(file_path),
                    "type": "pdf",
                    "page": 1,
                }
                if book_title:
                    metadata["book_title"] = book_title

                doc_obj = LangchainDocument(
                    page_content=md_text,
                    metadata=metadata,
                )
                documents.append(doc_obj)

        except (AttributeError, ValueError, TypeError) as extract_ex:
            logger.warning(
                "Could not extract page-level content: %s. Using full document.",
                str(extract_ex),
            )
            # Fallback: extract full document content
            md_text = conversion_result.document.export_to_markdown()
            # Enhance Markdown with proper headers for chapters
            md_text = PDFProcessor._enhance_markdown_with_headers(md_text)
            md_text = PDFProcessor._strip_open_access_boilerplate(md_text)

            # Try to extract a book title if not already extracted
            if not book_title:
                try:
                    doc = conversion_result.document
                    if hasattr(doc, "name") and doc.name:
                        book_title = doc.name
                        logger.info("Extracted book title from Docling metadata (fallback): %s", book_title)
                    elif hasattr(doc, "title") and doc.title:
                        book_title = doc.title
                        logger.info("Extracted book title from Docling metadata (fallback): %s", book_title)
                except (AttributeError, TypeError) as e:
                    logger.debug("No usable title in Docling metadata: %s", e)

            metadata = {
                "source": metadata_file_path,
                "file_name": os.path.basename(file_path),
            }
            # Add a book title if extracted (for Neo4j graph Book node)
            if book_title:
                metadata["book_title"] = book_title
            doc_obj = LangchainDocument(
                page_content=md_text,
                metadata=metadata,
            )
            documents.append(doc_obj)

        logger.info(
            "Successfully extracted %d page documents from Docling result",
            len(documents),
        )
        return documents

    @staticmethod
    def extract_pdf_metadata(file_path: str) -> dict[str, Any]:
        """
        Extract metadata from a PDF file using fallback methods.

        Args:
            file_path: Path to the PDF file

        Returns:
            A dictionary containing extracted metadata
        """
        from src.main.service.metadata_extractor import metadata_extractor

        return metadata_extractor.extract_pdf_metadata(file_path)


# Module-level instance for convenience
pdf_processor = PDFProcessor()

# Re-export for convenience
__all__ = [
    "DoclingLogHandler",
    "DoclingProgressTracker",
    "PDFProcessor",
    "_normalize_device_type",
    "analyze_pdf_document",
    "detect_ocr_document",
    "pdf_processor",
]
