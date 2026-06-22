"""
Tabular Document Processing Service.

This module handles spreadsheet / delimited-file ingestion (CSV, TSV, XLSX, XLS)
and converts them into clean, chunkable GitHub-flavored Markdown tables:

- CSV / TSV: delimiter auto-detection, BOM handling, utf-8 with latin-1 fallback,
  quoting via the csv module's reader.
- XLSX / XLS: one logical section per worksheet (sheet name rendered as a heading).
- Header-row detection and GFM table rendering. Very wide / large tables are
  emitted as multiple LangChain Documents (one per row group), with the header
  repeated on every chunk so each chunk is self-describing for retrieval.
- Column width / cell length caps to avoid pathological blobs.

The output matches the shape produced by the EPUB / DOCX parsers: a list of
``LangchainDocument`` objects whose ``page_content`` is Markdown and whose
metadata carries title, file_type, word_count and section markers. Chunking and
embedding are handled downstream by the shared chunking service.
"""

from collections.abc import Callable
import csv
import io
import os
import time

from langchain_core.documents import Document as LangchainDocument

from src.main.utils.core.logger import get_logger
from src.main.utils.documents.utils import format_processing_time, validate_file_path

logger = get_logger(__name__)

# Caps to keep rendered tables sane.
_MAX_CELL_CHARS = 300  # truncate any single cell beyond this
_MAX_COLS = 64  # ignore columns beyond this (extremely wide sheets)
_ROWS_PER_CHUNK = 200  # rows per emitted Document (header repeated each chunk)

_TABULAR_EXTENSIONS = (".csv", ".tsv", ".xlsx", ".xls")


def _is_tabular_extension(file_extension: str) -> bool:
    return file_extension.lower() in _TABULAR_EXTENSIONS


def _truncate_cell(value: object) -> str:
    """Render a cell to a single-line, length-capped, pipe-safe Markdown string."""
    if value is None:
        text = ""
    else:
        text = str(value)
    # Collapse newlines/tabs so a cell stays on one Markdown table row.
    text = text.replace("\r", " ").replace("\n", " ").replace("\t", " ").strip()
    # Escape pipes so they don't break the Markdown table.
    text = text.replace("|", "\\|")
    if len(text) > _MAX_CELL_CHARS:
        text = text[: _MAX_CELL_CHARS - 1].rstrip() + "…"
    return text


def _looks_like_header(row: list[str]) -> bool:
    """
    Heuristic: a header row has mostly non-empty, non-purely-numeric cells.

    Spreadsheets and CSVs almost always carry a header row of labels. We treat
    the first row as a header unless it is dominated by numeric values (in which
    case the data has no header and we synthesise generic column names).
    """
    cells = [c for c in row if c.strip()]
    if not cells:
        return False
    numeric = 0
    for c in cells:
        stripped = c.strip().replace(",", "").replace("%", "").replace("$", "")
        try:
            float(stripped)
            numeric += 1
        except ValueError:
            pass
    # If more than half the populated cells are numbers, it's probably data.
    return numeric <= len(cells) / 2


def _render_markdown_tables(
    rows: list[list[str]],
    section_title: str | None,
) -> list[str]:
    """
    Render a 2D grid of (already truncated) string cells into one or more
    GitHub-flavored Markdown table chunks.

    Each chunk repeats the header row so it is self-describing. Returns a list of
    Markdown strings (one per row group). Returns an empty list for an empty grid.
    """
    rows = [r for r in rows if any(cell.strip() for cell in r)]
    if not rows:
        return []

    width = min(max(len(r) for r in rows), _MAX_COLS)

    # Normalise every row to the same column count.
    def _pad(r: list[str]) -> list[str]:
        r = r[:width]
        return r + [""] * (width - len(r))

    rows = [_pad(r) for r in rows]

    if _looks_like_header(rows[0]):
        header = rows[0]
        data_rows = rows[1:]
    else:
        header = [f"Column {i + 1}" for i in range(width)]
        data_rows = rows

    # Ensure header cells are non-empty (Markdown tables need a label per column).
    header = [h if h.strip() else f"Column {i + 1}" for i, h in enumerate(header)]

    header_line = "| " + " | ".join(header) + " |"
    separator_line = "| " + " | ".join(["---"] * width) + " |"

    chunks: list[str] = []
    if not data_rows:
        # Header-only table.
        body = [header_line, separator_line]
        if section_title:
            body.insert(0, f"## {section_title}\n")
        chunks.append("\n".join(body))
        return chunks

    total = len(data_rows)
    for start in range(0, total, _ROWS_PER_CHUNK):
        group = data_rows[start : start + _ROWS_PER_CHUNK]
        lines: list[str] = []
        if section_title:
            part = ""
            if total > _ROWS_PER_CHUNK:
                part = f" (rows {start + 1}–{start + len(group)})"
            lines.append(f"## {section_title}{part}\n")
        lines.append(header_line)
        lines.append(separator_line)
        for r in group:
            lines.append("| " + " | ".join(r) + " |")
        chunks.append("\n".join(lines))
    return chunks


def _read_delimited(file_path: str) -> list[list[str]]:
    """Read a CSV / TSV file into a list of string rows.

    Auto-detects the delimiter, strips a UTF-8 BOM and falls back to latin-1 if
    the file is not valid UTF-8.
    """
    raw: bytes
    with open(file_path, "rb") as fh:
        raw = fh.read()

    # Strip UTF-8 BOM if present, then decode (utf-8 → latin-1 fallback).
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")

    sample = text[:8192]
    ext = os.path.splitext(file_path)[1].lower()
    delimiter = "\t" if ext == ".tsv" else ","
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
        delimiter = dialect.delimiter
    except csv.Error:
        # Sniffer failed (e.g. single column) — keep the extension-based default.
        logger.debug("CSV sniffer failed for %s, using delimiter %r", file_path, delimiter)

    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    return [list(row) for row in reader]


def _read_spreadsheet(file_path: str) -> list[tuple[str, list[list[str]]]]:
    """Read an XLSX / XLS file into a list of (sheet_name, rows) tuples.

    Empty sheets are skipped. Legacy ``.xls`` requires the optional ``xlrd``
    engine; a clear error is raised if it is not installed.
    """
    import pandas as pd

    ext = os.path.splitext(file_path)[1].lower()
    engine = "openpyxl" if ext == ".xlsx" else "xlrd"

    try:
        sheets = pd.read_excel(file_path, sheet_name=None, header=None, dtype=str, engine=engine)
    except ImportError as imp_err:
        # Almost certainly the missing xlrd engine for legacy .xls.
        raise RuntimeError(f"Reading {ext} requires the '{engine}' library which is not installed.") from imp_err

    result: list[tuple[str, list[list[str]]]] = []
    for sheet_name, frame in sheets.items():
        # NaN → empty string; everything to str.
        frame = frame.fillna("")
        rows = [[str(cell) for cell in row] for row in frame.values.tolist()]
        if any(any(cell.strip() for cell in r) for r in rows):
            result.append((str(sheet_name), rows))
    return result


class TabularProcessor:
    """Processor for spreadsheet / delimited tabular documents."""

    @staticmethod
    def process_tabular(
        file_path: str,
        job_id: str | None = None,
        progress_callback: Callable | None = None,
        _db=None,
        _user_id: str | None = None,
        relative_file_path: str | None = None,
    ) -> list[LangchainDocument]:
        """
        Process a tabular file (CSV/TSV/XLSX/XLS) into Markdown-table Documents.

        Returns:
            List of LangchainDocument objects (one per row group / sheet section).

        Raises:
            DocumentProcessingError: If processing fails or yields no content.
        """
        from src.main.service.document.document_processor import DocumentProcessingError

        start_time = time.time()
        file_extension = os.path.splitext(file_path)[1].lower()
        logger.info("Starting tabular processing (%s): %s", file_extension, file_path)

        try:
            validate_file_path(file_path)
        except Exception as e:
            logger.error("File validation failed: %s", str(e))
            raise DocumentProcessingError(f"Invalid file path: {e!s}") from e

        if progress_callback and job_id:
            progress_callback(
                job_id,
                {"progress": 10, "message": "readingTabularFile", "status": "processing"},
            )

        try:
            sections: list[tuple[str | None, list[list[str]]]]
            if file_extension in (".csv", ".tsv"):
                rows = _read_delimited(file_path)
                # Truncate every cell.
                rows = [[_truncate_cell(c) for c in r] for r in rows]
                sections = [(None, rows)]
            elif file_extension in (".xlsx", ".xls"):
                raw_sheets = _read_spreadsheet(file_path)
                sections = []
                for sheet_name, sheet_rows in raw_sheets:
                    truncated = [[_truncate_cell(c) for c in r] for r in sheet_rows]
                    sections.append((sheet_name, truncated))
            else:
                raise DocumentProcessingError(f"Unsupported tabular extension: {file_extension}")

            if progress_callback and job_id:
                progress_callback(
                    job_id,
                    {"progress": 50, "message": "renderingTables", "status": "processing"},
                )

            file_name = os.path.basename(file_path)
            title = os.path.splitext(file_name)[0]
            documents: list[LangchainDocument] = []
            section_index = 0
            for sheet_name, rows in sections:
                table_chunks = _render_markdown_tables(rows, sheet_name)
                for chunk_md in table_chunks:
                    word_count = len(chunk_md.split())
                    metadata = {
                        "source": relative_file_path or file_path,
                        "file_type": file_extension.lstrip("."),
                        "file_name": file_name,
                        "title": title,
                        "processing_method": "tabular",
                        "word_count": str(word_count),
                        "section": str(section_index),
                        "page": section_index,
                    }
                    if sheet_name:
                        metadata["sheet_name"] = sheet_name
                    documents.append(LangchainDocument(page_content=chunk_md, metadata=metadata))
                    section_index += 1

            if not documents:
                raise DocumentProcessingError("No tabular content extracted from file")

            total_chars = sum(len(d.page_content) for d in documents)
            logger.info(
                "Tabular processing completed in %s. %d section(s), %d chars.",
                format_processing_time(start_time),
                len(documents),
                total_chars,
            )

            if progress_callback and job_id:
                progress_callback(
                    job_id,
                    {"progress": 70, "message": "tabularProcessingComplete", "status": "processing"},
                )

            return documents

        except DocumentProcessingError:
            raise
        except Exception as e:
            logger.exception("Tabular processing failed: %s", str(e))
            raise DocumentProcessingError(f"Failed to process tabular file: {e!s}") from e


def process_tabular(
    file_path: str,
    job_id: str | None = None,
    progress_callback: Callable | None = None,
    db=None,
    user_id: str | None = None,
    relative_file_path: str | None = None,
) -> list[LangchainDocument]:
    """Convenience function that delegates to :class:`TabularProcessor`."""
    return TabularProcessor.process_tabular(
        file_path=file_path,
        job_id=job_id,
        progress_callback=progress_callback,
        _db=db,
        _user_id=user_id,
        relative_file_path=relative_file_path,
    )


__all__ = ["_TABULAR_EXTENSIONS", "TabularProcessor", "_is_tabular_extension", "process_tabular"]
