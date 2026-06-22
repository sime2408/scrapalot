"""File text extraction for PDF, DOCX, plain text, and unknown formats."""

from __future__ import annotations

from io import BytesIO

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Extensions handled as plain text without any third-party library.
_TEXT_LIKE_EXTENSIONS = frozenset({"txt", "md", "json", "csv", "log"})


def _decode_bytes(content: bytes) -> str:
    """Decode ``content`` as UTF-8, falling back to latin-1 (errors='ignore')."""
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return content.decode("latin-1", errors="ignore")


def _extract_pdf(file_content: BytesIO) -> str:
    """Extract concatenated page text from a PDF using ``pypdf``."""
    import pypdf

    reader = pypdf.PdfReader(file_content)
    return "\n\n".join(page.extract_text() for page in reader.pages)


def _extract_docx(file_content: BytesIO) -> str:
    """Extract paragraph text from a DOCX using ``python-docx``."""
    import docx

    document = docx.Document(file_content)
    return "\n\n".join(paragraph.text for paragraph in document.paragraphs)


def extract_file_text(
    file_content: BytesIO,
    file_name: str,
    break_on_unprocessable: bool = True,
) -> str:
    """Extract text content from a file.

    Supports plain-text variants (txt/md/json/csv/log), PDF (via
    ``pypdf``), and DOCX (via ``python-docx``). Unknown extensions are
    attempted as plain text.

    Args:
        file_content: file bytes as ``BytesIO``
        file_name: filename used only for extension lookup
        break_on_unprocessable: if ``True`` raises on unsupported files,
            otherwise returns a stub string

    Raises:
        ValueError: when ``break_on_unprocessable`` is ``True`` and the
            file cannot be processed.
    """
    extension = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""

    try:
        if extension in _TEXT_LIKE_EXTENSIONS:
            return _decode_bytes(file_content.read())

        if extension == "pdf":
            try:
                return _extract_pdf(file_content)
            except ImportError as exc:
                logger.warning("pypdf not installed, cannot extract PDF text")
                if break_on_unprocessable:
                    raise ValueError("PDF extraction requires pypdf package") from exc
                return f"[PDF file: {file_name} - text extraction not available]"

        if extension in {"docx", "doc"}:
            try:
                return _extract_docx(file_content)
            except ImportError as exc:
                logger.warning("python-docx not installed, cannot extract DOCX text")
                if break_on_unprocessable:
                    raise ValueError("DOCX extraction requires python-docx package") from exc
                return f"[Word document: {file_name} - text extraction not available]"

        logger.warning("Unknown file type: %s, attempting text extraction", extension)
        try:
            return _decode_bytes(file_content.read())
        except Exception as exc:
            if break_on_unprocessable:
                raise ValueError(f"Unsupported file type: {extension}") from exc
            return f"[Unprocessable file: {file_name}]"

    except Exception as e:
        logger.exception("Error extracting text from %s: %s", file_name, e)
        if break_on_unprocessable:
            raise
        return f"[Error extracting text from {file_name}: {e!s}]"
