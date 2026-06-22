"""PDF/EPUB to markdown extraction for the dataset generator pipeline.

GPU acceleration strategy:
  - Clean PDFs  → PyMuPDF4LLM (CPU, fast, no GPU needed)
  - OCR/scanned → Docling with CUDA when available

Docling is initialized once per worker process and reused across all books.
GPU detection bypasses llm_manager to avoid the full service stack.
"""

import os

from scripts.dataset_generator.core.models import BookInfo, FileType
from src.main.utils.core.logger import get_logger
from src.main.utils.documents.utils import extract_epub_to_markdown

logger = get_logger(__name__)

# Process-level Docling singleton to avoid re-loading layout detection models
# per book (each init costs several seconds). Key is f"{device}:{ocr_enabled}".
_DOCLING_CACHE: dict[str, object] = {}


def _detect_device() -> str:
    """Detect GPU device type for extraction (bypasses the llm_manager service stack).

    Reads CUDA_VISIBLE_DEVICES to support per-worker GPU pinning; falls back
    to torch.cuda.is_available() for the single-worker / sequential path.
    """
    # Empty CUDA_VISIBLE_DEVICES means GPUs explicitly hidden by the caller
    cuda_env = os.environ.get("CUDA_VISIBLE_DEVICES")
    if cuda_env is not None and cuda_env.strip() == "":
        return "cpu"
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except ImportError:
        pass
    return "cpu"


def _get_docling_converter(device: str, ocr_enabled: bool):
    """Get or build a process-level Docling DocumentConverter singleton.

    Models are downloaded/loaded on first call; subsequent calls are instant.
    The converter is keyed by (device, ocr_enabled) so different worker configs
    stay isolated.
    """
    cache_key = f"{device}:{ocr_enabled}"
    if cache_key in _DOCLING_CACHE:
        return _DOCLING_CACHE[cache_key]

    try:
        from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline
    except ImportError:
        logger.warning("Docling not available — OCR path disabled")
        return None

    has_gpu = device not in ("cpu",)
    try:
        from src.main.utils.documents.utils import configure_docling_pipeline_options

        pipeline_options = configure_docling_pipeline_options(PdfPipelineOptions(), has_gpu, ocr_enabled)
    except Exception:
        pipeline_options = PdfPipelineOptions()
        pipeline_options.do_ocr = ocr_enabled

    try:
        from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions

        _device_map = {"cuda": AcceleratorDevice.CUDA, "mps": AcceleratorDevice.MPS, "cpu": AcceleratorDevice.CPU}
        accel = _device_map.get(device, AcceleratorDevice.AUTO)
        pipeline_options.accelerator_options = AcceleratorOptions(num_threads=4, device=accel)
    except ImportError:
        pass

    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_cls=StandardPdfPipeline,
                backend=PyPdfiumDocumentBackend,
                pipeline_options=pipeline_options,
            )
        }
    )
    _DOCLING_CACHE[cache_key] = converter
    logger.info("Initialized Docling converter (device=%s, ocr=%s)", device, ocr_enabled)
    return converter


def extract_text(book: BookInfo, ocr_enabled: bool = False) -> tuple[str | None, int]:
    """Extract Markdown text from a book file.

    For PDFs:
    - Clean PDFs use PyMuPDF4LLM directly (fast, CPU, no Docling overhead)
    - OCR/scanned PDFs use a per-process Docling converter with GPU when available

    For EPUBs, uses the existing extract_epub_to_markdown utility.

    Args:
        book: BookInfo with file_path and file_type
        ocr_enabled: Whether to enable OCR for scanned PDFs

    Returns:
        Tuple of (markdown_text, page_or_chapter_count). Returns (None, 0) on failure.
    """
    match book.file_type:
        case FileType.PDF:
            return _extract_pdf(book.file_path, ocr_enabled)
        case FileType.EPUB:
            return _extract_epub(book.file_path)
        case _:
            logger.error("Unsupported file type: %s", book.file_type)
            return None, 0


def _extract_pdf(file_path: str, ocr_enabled: bool = False) -> tuple[str | None, int]:
    """Extract PDF to markdown.

    Uses a two-tier strategy:
    1. Analyse the document once to detect OCR/clean
    2. Scanned/OCR docs use the Docling singleton (GPU when available)
    3. Clean docs use PyMuPDF4LLM (CPU, faster for batch processing)
    """
    try:
        from src.main.service.document.document_processor_pdf import analyze_pdf_document

        is_ocr_document, page_count = analyze_pdf_document(file_path)

        # Defer scanned/OCR PDFs unless --ocr is explicitly requested. Running
        # Docling OCR inline is very slow and we process scanned books in a
        # separate dedicated --ocr pass.
        if is_ocr_document and not ocr_enabled:
            logger.info("[defer-ocr] Skipping scanned PDF (run with --ocr to process): %s", file_path)
            return None, 0

        if ocr_enabled or is_ocr_document:
            return _extract_pdf_with_docling(file_path, ocr_enabled or is_ocr_document, page_count)
        else:
            return _extract_pdf_with_pymupdf(file_path, page_count)

    except Exception as e:
        logger.error("PDF extraction failed for %s: %s", file_path, e)
        return None, 0


def _extract_pdf_with_pymupdf(file_path: str, page_count: int = 0) -> tuple[str | None, int]:
    """Extract clean PDF to markdown using PyMuPDF4LLM (fast CPU path)."""
    try:
        from src.main.utils.documents.utils import extract_pdf_to_markdown

        markdown, extracted_pages = extract_pdf_to_markdown(file_path, page_chunks=False)
        if not markdown or not markdown.strip():
            logger.warning("PyMuPDF4LLM returned empty content for %s", file_path)
            return None, 0

        final_pages = extracted_pages or page_count or 0
        logger.debug("Extracted %d pages from PDF via PyMuPDF4LLM: %s", final_pages, file_path)
        return markdown, final_pages

    except Exception as e:
        logger.error("PyMuPDF4LLM extraction failed for %s: %s", file_path, e)
        return None, 0


def _extract_pdf_with_docling(file_path: str, ocr_enabled: bool, page_count: int = 0) -> tuple[str | None, int]:
    """Extract OCR/scanned PDF using a process-level Docling singleton with GPU when available.

    This path is taken for scanned/image-only PDFs. Keeps one Docling converter
    alive per worker process to avoid re-loading the layout detection models for
    every book (each init is several seconds).
    """
    device = _detect_device()
    converter = _get_docling_converter(device, ocr_enabled)

    if converter is None:
        logger.warning("Docling unavailable, falling back to PyMuPDF4LLM for %s", file_path)
        return _extract_pdf_with_pymupdf(file_path, page_count)

    try:
        result = converter.convert(file_path)
        markdown = result.document.export_to_markdown()
        if not markdown or not markdown.strip():
            logger.warning("Docling returned empty content for %s, falling back to PyMuPDF4LLM", file_path)
            return _extract_pdf_with_pymupdf(file_path, page_count)

        # Count pages from Docling result if available
        try:
            pages = len(result.document.pages) if hasattr(result.document, "pages") else page_count
        except Exception:
            pages = page_count

        logger.debug("Extracted %d pages from PDF via Docling (device=%s): %s", pages, device, file_path)
        return markdown, pages

    except Exception as e:
        logger.warning("Docling extraction failed for %s: %s, falling back to PyMuPDF4LLM", file_path, e)
        return _extract_pdf_with_pymupdf(file_path, page_count)


def _extract_epub(file_path: str) -> tuple[str | None, int]:
    """Extract EPUB to markdown using the existing utility."""
    try:
        result = extract_epub_to_markdown(file_path)
        markdown = result[0] if result else None
        chapter_count = result[1] if result and len(result) > 1 else 0

        if not markdown:
            logger.warning("EPUB extraction returned empty content for %s", file_path)
            return None, 0

        return markdown, chapter_count or 0

    except Exception as e:
        logger.error("EPUB extraction failed for %s: %s", file_path, e)
        return None, 0
