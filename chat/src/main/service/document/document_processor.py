"""
Document Processing Service.

This module provides the core document processing framework including
- Shared utilities for all document types
- Intelligent chunking via ChunkingService
- Document enrichment and metadata handling

Format-specific processing is implemented in:
- document_processor_pdf.py - PDF-specific processing
- document_processor_epub.py - EPUB-specific processing
- document_processor_docx.py - DOCX-specific processing
"""

from collections.abc import Callable
import itertools
import json
import os
import re
from typing import Any

from langchain_core.documents import Document as LangchainDocument

from src.main.service.rag.chunking.chunking_service import get_chunking_service
from src.main.utils.core.logger import get_logger
from src.main.utils.text.formatting import normalize_whitespace

logger = get_logger(__name__)


def _sanitize_chapter_title(title: str) -> str:
    """Strip leftover markdown formatting from a candidate chapter title.

    The per-Tier `[*_]+` strips miss malformed markdown remnants left by
    upstream splitters: orphan `**` markers when source has two bold runs
    spanning a title (``the** **essentials**``), markdown link tails when
    the splitter captured the description but left the close-bracket plus
    URL (``Joy of Gardening](file.htm)``). Applied at the boundary in
    ``_assign_cross_page_chapter_metadata`` so every Tier benefits without
    each having to repeat the cleanup. Canonical cases: b0e44f64 (Sampling
    techniques for forest inventories) and 1987453b (Garden of Inspiration).
    """
    if not title:
        return title
    # Strip markdown link tail anywhere: `text](url)` → `text` (no opening `[`
    # required — the upstream splitter drops it).
    out = re.sub(r"\]\([^)]*\)", "", title)
    # Strip ALL `*` runs (orphan bold markers — re.sub(r"[*_]+", ...) per-Tier
    # only catches `*` already; this is a defensive second pass).
    out = re.sub(r"\*+", "", out)
    # Strip `_` only at word boundaries so filename fragments like
    # `epub_c01_r1` survive but `_italic_` markers go.
    out = re.sub(r"(?<!\w)_+|_+(?!\w)", "", out)
    # Strip leading separator run (`– `, `— `, `- `, `: `, `, `, `. `) when
    # followed by a capital letter or digit. Catches en-dash titles like
    # ``# Chapter I – The Knowledge of Self`` where Pattern B's
    # ``chapter\s+([IVXLC]+|\d+)[:.]?\s*(.*)`` regex captures the trailing
    # ``– The Knowledge of Self`` verbatim. Gating on capital-or-digit
    # tail keeps sentence-fragment garbage (``, the objectives of the``)
    # untouched — those are caught by `_is_likely_real_title` downstream.
    # Signal-2+ cumulative evidence: 7200710c Al-Ghazali Inner Path
    # (2 chapters labelled "– The Knowledge of …") + ffa08a8f UFO-encyclopedia
    # corpus (21 chapter titles prefixed with em-dash) + 938ead64 + 7bcd19e4.
    out = re.sub(r"^[\s\-–—:.,;]+(?=[A-Z0-9])", "", out)
    # Collapse repeated whitespace introduced by the strips.
    out = normalize_whitespace(out)
    return out or title


_PAGE_ANCHOR_TITLE_RE = re.compile(r"^(?:page|pg|p)0*\d{1,5}(?:\s*\(\d+\))?$", re.IGNORECASE)


def is_page_anchor_title(title: str | None) -> bool:
    """True when ``title`` looks like a pymupdf4llm-layout page anchor id.

    pymupdf4llm-layout emits per-page H-level anchors like ``# page0007``
    inside the markdown body. The chunker's auto-promotion + hierarchy
    metadata extraction were both reading those as legitimate H1 chapter
    titles, polluting `chunk.cmetadata.chapter_title` with `page0002`,
    `page0029 (2)`, etc. The Neo4j-side filter at `node_factory._clean_chapter_title`
    only ran during graph ingest — pgvector chunks stayed polluted and
    Cat-F replays reproduced the same garbage forever.

    Examples that match: ``page0029``, ``page0029 (2)``, ``pg12``,
    ``p027``, ``PAGE0001``. Caller convention: when True, treat the title
    as empty / fall back to a different signal (section_heading, etc.).

    Verified incident: 9fa59f47 Awakening To Reality (Pregadio 2009),
    Cat-F replay 2026-05-21 — 99 polluted titles before, 131 after
    (replay reproduced the bug because the chunker write path lacked
    this filter).
    """
    if not title:
        return False
    return bool(_PAGE_ANCHOR_TITLE_RE.match(title.strip()))


# Multilingual chapter keyword set. Used by the 10 chapter-detection regex
# sites in this module + _detect_chapters_in_chunks / _detect_chapters_from_*.
# Languages currently in production corpus:
#   English: chapter, chap.
#   Spanish: capítulo / capitol, lección / leccion
#   French:  chapitre
#   German:  kapitel
#   Italian: capitolo
#   Romanian: capitolul
#   Croatian / Serbian: poglavlje, glava
# Verified via regression scan 2026-05-22: zero false-positive risk on 243
# parse_done English books (no line-start non-English keyword hits). The 5
# affected non-English docs (Zavala ES, HELLY FR, Vidas Valientes ES, Mantle
# ES, Harris ES) all collapsed to single chapter_title under the prior
# English-only regex because Pattern A/B/C never matched their headings.
CHAPTER_KEYWORDS = (
    r"chapter|chap\.?|"
    r"cap[íi]tulo|lecci[óo]n|"
    r"chapitre|"
    r"kapitel|"
    r"capitolo|capitolul|"
    r"poglavlje|glava"
)
PART_KEYWORDS = r"part|book|section"
ALL_CHAPTER_KEYWORDS = f"{PART_KEYWORDS}|{CHAPTER_KEYWORDS}"


_ARCHIVAL_FILENAME_TITLE_RE = re.compile(r"^[A-Za-z0-9]+(?:_[A-Za-z0-9]+){2,}$")
_ARCHIVAL_CAMEL_TOKEN_RE = re.compile(r"[A-Z][a-z]+[A-Z][a-zA-Z]+")


def is_archival_filename_title(title: str | None) -> bool:
    """True when ``title`` looks like a publisher-archival filename slug.

    Anna's Archive copies of academic-journal PDFs frequently carry
    publisher-archival level-1 outline entries shaped like
    ``JSS_068_1h_Kauffmann_SocialAndReligiousInstitutionsOfLawaPartIII``:
    underscore-separated, no spaces, at least one CamelCase token. The PDF
    outline reader ``PDFChapterDetector._detect_from_toc`` accepts these as
    legitimate chapter_titles unless this helper rejects them, polluting
    every chunk in the doc.

    Criteria (ALL must hold):
      * No spaces.
      * Match ``^[A-Za-z0-9]+(?:_[A-Za-z0-9]+){2,}$`` (≥3 underscore-tokens).
      * At least one token contains a CamelCase run
        (``[A-Z][a-z]+[A-Z][a-zA-Z]+``) — distinguishes archival slugs
        from snake_case identifiers like ``epub_c01_r1``.
      * At least one token is length ≥ 6 and pure-alpha — rules out
        short id-only strings.

    Caller convention: when True, treat the title as empty / drop the
    outline entry so the downstream fallback chain (regex on markdown,
    ``_detect_chapters_in_chunks``, ``_renumber_chapters_from_chunk_titles``)
    takes over and uses the real H1 article titles.

    Verified incident: 553e7a08 Journal of the Siam Society 68 (post Cat-I
    restore 2026-05-22) — 64 polluted chapter_titles across 1233 chunks.
    Cross-corpus regression scan: 43 docs / 633 distinct polluted titles,
    all from the JSS Anna's Archive series. Zero non-JSS false positives
    across 8082 distinct chapter_titles in the corpus.
    """
    if not title:
        return False
    t = title.strip()
    if " " in t:
        return False
    if not _ARCHIVAL_FILENAME_TITLE_RE.match(t):
        return False
    tokens = t.split("_")
    if not any(_ARCHIVAL_CAMEL_TOKEN_RE.search(tok) for tok in tokens):
        return False
    return any(len(tok) >= 6 and tok.isalpha() for tok in tokens)


class DocumentProcessingError(Exception):
    """Error during document processing."""


class DocumentProcessor:
    """
    Document processor for handling various document formats.

    This class provides the shared framework for document processing.
    Format-specific processing is delegated to:
    - PDFProcessor (document_processor_pdf.py)
    - EPUBProcessor (document_processor_epub.py)
    - DOCXProcessor (document_processor_docx.py)
    """

    @staticmethod
    def get_file_type_from_path(file_path: str) -> str:
        """
        Determine a file type from a file extension.

        Args:
            file_path: Path to the file

        Returns:
            File type string (e.g., 'pdf', 'epub', 'docx', 'markdown', 'text', 'csv', 'rtf')
        """
        file_extension = os.path.splitext(file_path)[1].lower()
        file_type_map = {
            ".pdf": "pdf",
            ".epub": "epub",
            ".md": "markdown",
            ".markdown": "markdown",
            ".txt": "text",
            ".docx": "docx",
            ".csv": "csv",
            ".tsv": "tsv",
            ".xlsx": "xlsx",
            ".xls": "xls",
            ".rtf": "rtf",
        }
        return file_type_map.get(file_extension, "pdf")

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
        """Process a PDF file and return a list of LangChain Document objects.

        Delegates to PDFProcessor. When `multimodal_collector` is given,
        Docling-extracted images / tables / equations are appended to it
        as `MultimodalElementDraft` instances for downstream persistence.

        Raises:
            DocumentProcessingError: If processing fails
        """
        from src.main.service.document.document_processor_pdf import PDFProcessor

        return PDFProcessor.process_pdf(
            file_path=file_path,
            ocr_enabled=ocr_enabled,
            job_id=job_id,
            progress_callback=progress_callback,
            db=db,
            user_id=user_id,
            relative_file_path=relative_file_path,
            multimodal_collector=multimodal_collector,
        )

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

        Delegates to EPUBProcessor for actual processing.

        Args:
            file_path: Path to the EPUB file (absolute path for processing)
            job_id: Job ID for progress tracking (optional)
            progress_callback: Callback function for progress updates (optional)
            db: Database session (optional)
            user_id: User ID for tracking (optional)
            relative_file_path: Relative file path to store in metadata (optional)

        Returns:
            List of LangchainDocument objects with chapter-level content

        Raises:
            DocumentProcessingError: If processing fails
        """
        from src.main.service.document.document_processor_epub import EPUBProcessor

        return EPUBProcessor.process_epub(
            file_path=file_path,
            job_id=job_id,
            progress_callback=progress_callback,
            db=db,
            user_id=user_id,
            relative_file_path=relative_file_path,
        )

    @staticmethod
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

        Delegates to DOCXProcessor for actual processing.

        Args:
            file_path: Path to the DOCX file (absolute path for processing)
            job_id: Job ID for progress tracking (optional)
            progress_callback: Callback function for progress updates (optional)
            db: Database session (optional)
            user_id: User ID for tracking (optional)
            relative_file_path: Relative file path to store in metadata (optional)

        Returns:
            List of LangchainDocument objects with full content

        Raises:
            DocumentProcessingError: If processing fails
        """
        from src.main.service.document.document_processor_docx import DOCXProcessor

        return DOCXProcessor.process_docx(
            file_path=file_path,
            job_id=job_id,
            progress_callback=progress_callback,
            _db=db,
            _user_id=user_id,
            relative_file_path=relative_file_path,
        )

    @staticmethod
    def process_tabular(
        file_path: str,
        job_id: str | None = None,
        progress_callback: Callable | None = None,
        db=None,
        user_id: str | None = None,
        relative_file_path: str | None = None,
    ) -> list[LangchainDocument]:
        """
        Process a tabular file (CSV/TSV/XLSX/XLS) into Markdown-table Documents.

        Delegates to TabularProcessor for actual processing.

        Args:
            file_path: Path to the tabular file (absolute path for processing)
            job_id: Job ID for progress tracking (optional)
            progress_callback: Callback function for progress updates (optional)
            db: Database session (optional)
            user_id: User ID for tracking (optional)
            relative_file_path: Relative file path to store in metadata (optional)

        Returns:
            List of LangchainDocument objects with Markdown table content

        Raises:
            DocumentProcessingError: If processing fails
        """
        from src.main.service.document.document_processor_tabular import TabularProcessor

        return TabularProcessor.process_tabular(
            file_path=file_path,
            job_id=job_id,
            progress_callback=progress_callback,
            _db=db,
            _user_id=user_id,
            relative_file_path=relative_file_path,
        )

    @staticmethod
    def apply_chunking_and_return_documents_with_pages(
        page_documents: list[LangchainDocument],
        file_path: str,
        db=None,
        user_id: str | None = None,
        metadata_file_path: str | None = None,
        job_id: str | None = None,
        progress_callback: Callable | None = None,
    ) -> list[LangchainDocument]:
        """
        Apply intelligent chunking to page-level documents while preserving page number metadata.

        Args:
            page_documents: List of LangChain documents with page information
            file_path: Path to the source file
            db: Database session for user preference lookup (optional)
            user_id: User ID for preference-based strategy selection (optional)
            metadata_file_path: Path for metadata storage (optional)
            job_id: Job ID for progress tracking (optional)
            progress_callback: Callback function for progress updates (optional)

        Returns:
            List of chunked LangChain Document objects with preserved page numbers
        """
        if job_id and progress_callback:
            progress_callback(
                job_id,
                {
                    "progress": 70,
                    "message": f"chunkingPages:{len(page_documents)}",
                    "status": "processing",
                },
            )

        logger.info("Chunking %d page documents while preserving page numbers", len(page_documents))

        user_settings_cache = None
        if db is not None and user_id is not None:
            user_settings_cache = DocumentProcessor._get_user_document_settings(db, user_id)
            if user_settings_cache:
                logger.info("Cached user document settings for %d pages", len(page_documents))

        all_chunked_documents = []

        # One collapsed-table rebuild budget shared across every page of THIS
        # document, so total LLM rebuilds are bounded per-document (a 42-page
        # racing form can't fire 8-rebuilds-per-page).
        try:
            from src.main.service.document.table_repair import new_budget

            _table_repair_budget = new_budget()
        except Exception:
            _table_repair_budget = None

        for page_doc in page_documents:
            try:
                page_number = page_doc.metadata.get("page")

                document_metadata = {
                    "source": metadata_file_path,
                    "file_name": os.path.basename(file_path),
                    "type": DocumentProcessor.get_file_type_from_path(file_path),
                    "title": os.path.splitext(os.path.basename(file_path))[0],
                    "page": page_number,
                }

                for key, value in page_doc.metadata.items():
                    if key not in document_metadata:
                        document_metadata[key] = value

                if user_settings_cache is not None:
                    logger.debug("Applying user-specific chunking to page %s", page_number)
                else:
                    logger.debug("Using default chunking for page %s", page_number)

                # Repair <br>-collapsed dense tables (pymupdf4llm/Docling flatten
                # multi-row cells into one <br>-joined cell) BEFORE chunking, so
                # both the chunks and the reassembled stored content carry the
                # reconstructed grid. No-op (no LLM call) on pages without a
                # collapsed table; never fatal — on any failure we keep the
                # original page text.
                try:
                    from src.main.service.document.table_repair import repair_collapsed_tables

                    repaired_page = repair_collapsed_tables(page_doc.page_content or "", budget=_table_repair_budget)
                    if repaired_page and repaired_page != page_doc.page_content:
                        page_doc.page_content = repaired_page
                except Exception as _tr_err:
                    logger.warning("table_repair skipped for page %s: %s", page_number, str(_tr_err))

                page_chunk_results = DocumentProcessor._apply_intelligent_chunking(
                    page_doc.page_content,
                    file_path,
                    user_id,
                    db,
                    document_metadata,
                    metadata_file_path,
                    user_settings_cache,
                )

                num_chunks_on_page = len(page_chunk_results)

                page_text = page_doc.page_content or ""
                page_bbox = page_doc.metadata.get("page_bbox")
                cumulative_offset = 0
                for i, chunk_result in enumerate(page_chunk_results):
                    chunk_text = chunk_result.get("text", "")
                    chunk_metadata_from_chunking = chunk_result.get("metadata", {})

                    page_top_margin = 5.0
                    page_content_height = 90.0

                    if num_chunks_on_page > 0:
                        chunk_height_percent = page_content_height / num_chunks_on_page
                        position_top = page_top_margin + (i * chunk_height_percent)
                        position_bottom = position_top + chunk_height_percent
                    else:
                        position_top = page_top_margin
                        position_bottom = page_top_margin + page_content_height

                    try:
                        from src.main.service.document.chunk_position import chunk_position_json

                        chunk_pos = chunk_position_json(
                            page=page_number,
                            page_text=page_text,
                            chunk_text=chunk_text,
                            page_bbox=page_bbox,
                            fallback_offset=cumulative_offset,
                        )
                        cumulative_offset = chunk_pos.get("char_offset_end", cumulative_offset)
                    except Exception:
                        chunk_pos = None

                    chunk_metadata = {
                        **chunk_metadata_from_chunking,
                        **document_metadata,
                        # Global chunk index. `len(all_chunked_documents)` is
                        # the count BEFORE the upcoming append, so it is the
                        # correct next sequential index. The previous
                        # `len(...) + i` formula double-counted in the inner
                        # per-page loop (len grew by 1 per iteration AND i
                        # incremented), producing chunk_index values of 0, 2,
                        # 4, ... 2*(N-1) instead of 0..N-1.
                        "chunk_index": len(all_chunked_documents),
                        "page_chunk_index": i,
                        "page": page_number,
                        "position_top_percent": round(position_top, 2),
                        "position_bottom_percent": round(position_bottom, 2),
                    }
                    if chunk_pos is not None:
                        chunk_metadata["position_json"] = chunk_pos

                    chunk_doc = LangchainDocument(page_content=chunk_text, metadata=chunk_metadata)
                    all_chunked_documents.append(chunk_doc)

                logger.debug("Page %s chunked into %d chunks", page_number, len(page_chunk_results))

            except (ValueError, KeyError, AttributeError, TypeError) as ex:
                logger.warning(
                    "Error chunking page %s: %s. Skipping page.",
                    page_doc.metadata.get("page", "unknown"),
                    str(ex),
                )
                continue

        logger.info(
            "Successfully chunked %d pages into %d total chunks with preserved page numbers",
            len(page_documents),
            len(all_chunked_documents),
        )

        # Post-process: assign chapter metadata across all chunks using full document context
        all_chunked_documents = DocumentProcessor._assign_cross_page_chapter_metadata(all_chunked_documents, page_documents, file_path)

        if job_id and progress_callback:
            progress_callback(
                job_id,
                {
                    "progress": 75,
                    "message": f"chunkingComplete:{len(all_chunked_documents)}",
                    "status": "processing",
                },
            )

        return all_chunked_documents

    @staticmethod
    def _assign_cross_page_chapter_metadata(
        chunked_documents: list[LangchainDocument],
        page_documents: list[LangchainDocument],
        file_path: str = "",
    ) -> list[LangchainDocument]:
        """
        Assign chapter metadata to chunks using the full document context.

        Per-page chunking processes each page independently, so chapter detection
        cannot work across pages. This post-processing step:
        1. Tries font-based PDF detection (TOC or font-size heuristics)
        2. Falls back to regex detection on the Markdown text
        3. Maps each page to a chapter number and title
        4. Updates all chunk metadata with correct chapter info
        """
        if not page_documents or not chunked_documents:
            return chunked_documents

        # Step 1: Try font-based detection for PDFs
        from src.main.service.document.pdf_chapter_detector import PDFChapterDetector

        font_chapters = PDFChapterDetector.detect_chapters(file_path)

        # Check if page numbers are meaningful (not all 0/None)
        has_real_pages = len({d.metadata.get("page", 0) for d in page_documents if d.metadata.get("page", 0) > 0}) > 1

        if font_chapters:
            sorted_chapters = sorted(font_chapters, key=lambda c: c[0])
            for ch_page, ch_num, ch_title in sorted_chapters:
                logger.info("Chapter detected (font-based) at page %d: Chapter %d - %s", ch_page, ch_num, ch_title)

            # Filter out front/back matter from chapter list
            _skip_titles = {
                "contents",
                "table of contents",
                "list of figures",
                "list of tables",
                "list of figures and tables",
                "list of illustrations",
                "conventions",
                "acknowledgments",
                "acknowledgements",
                "about the author",
                "about the authors",
                "preface",
                "foreword",
                "notes",
                "endnotes",
                "footnotes",
                "glossary",
                "bibliography",
                "references",
                "works cited",
                "works quoted",
                "index",
                "appendix",
                "appendixes",
                "appendices",
                "colophon",
                "copyright",
            }
            content_chapters = [(pg, num, title) for pg, num, title in sorted_chapters if title.lower().strip() not in _skip_titles]
            # Re-number filtered chapters sequentially
            renumbered = []
            for i, (pg, _, title) in enumerate(content_chapters, 1):
                renumbered.append((pg, i, title))

            if has_real_pages:
                # Build page-to-chapter mapping from font-based results
                page_chapter_map = {}
                for page_doc in page_documents:
                    page_num = page_doc.metadata.get("page", 0)
                    assigned_ch = (0, "")
                    for ch_page, ch_num, ch_title in renumbered:
                        if ch_page <= page_num:
                            assigned_ch = (ch_num, ch_title)
                        else:
                            break
                    page_chapter_map[page_num] = assigned_ch
            else:
                # No page numbers — store chapter list for content-based assignment
                # noinspection PyTypeChecker
                page_chapter_map: dict = {
                    0: renumbered[-1][1:3] if renumbered else (0, ""),
                    "_chapters": [(num, title) for _, num, title in renumbered],
                }

        else:
            # Fallback: regex on Markdown text
            page_chapter_map = DocumentProcessor._detect_chapters_from_text(page_documents)

        if not page_chapter_map:
            # Last resort: scan the already-chunked text for chapter boundaries.
            # Many PDFs/EPUBs lose page-level headings during chunking (e.g., fallback
            # sliding-window chunking) but still contain "Chapter N" markers inline.
            # Without this, the whole book ends up as a single chapter.
            inline_chapters = DocumentProcessor._detect_chapters_in_chunks(chunked_documents)
            if inline_chapters:
                logger.info(
                    "No page/font chapters found; detected %d chapters from chunk text content",
                    len(inline_chapters),
                )
                for doc in chunked_documents:
                    ch_num = doc.metadata.get("_inline_chapter_num", 0)
                    ch_title = doc.metadata.get("_inline_chapter_title", "")
                    doc.metadata["chapter_number"] = ch_num
                    doc.metadata["chapter_title"] = ch_title or (f"Chapter {ch_num}" if ch_num else "Introduction")
                    doc.metadata.pop("_inline_chapter_num", None)
                    doc.metadata.pop("_inline_chapter_title", None)
                return DocumentProcessor._consolidate_placeholder_chapter_titles(chunked_documents)

            # Last-last resort: chunkers that ran per-page (enhanced_markdown invoked
            # by apply_chunking_and_return_documents_with_pages) tag chunks with the
            # H1 title from THEIR page only. The chunking strategy auto-promotes new
            # H1s to chapters but loses cross-page state. Aggregate all unique H1
            # titles seen across the whole document and renumber chapters globally.
            renumbered = DocumentProcessor._renumber_chapters_from_chunk_titles(chunked_documents)
            if renumbered > 1:
                logger.info(
                    "Renumbered %d distinct chapters from per-page H1 titles for %s",
                    renumbered,
                    file_path or "(unknown)",
                )
            else:
                logger.warning(
                    "No chapters detected for document %s — all chunks will stay in default chapter",
                    file_path or "(unknown)",
                )
            return DocumentProcessor._consolidate_placeholder_chapter_titles(chunked_documents)

        # Check if page numbers are meaningful (not all 0/None)
        has_real_pages = len({v for v in page_chapter_map if isinstance(v, int) and v > 0}) > 1

        if has_real_pages:
            # Page-based mapping (original approach — works when pages are distinct)
            updated_count = 0
            for doc in chunked_documents:
                page_num = doc.metadata.get("page", 0)
                ch_num, ch_title = page_chapter_map.get(page_num, (0, ""))
                doc.metadata["chapter_number"] = ch_num
                doc.metadata["chapter_title"] = ch_title if ch_title else f"Chapter {ch_num}"
                if ch_num > 0:
                    updated_count += 1
        else:
            # Content-based mapping: match chapter headings to chunk text.
            # When the upstream detector returned an explicit chapter list
            # under "_chapters" (Tier 3 from a TOC section, or font-based path),
            # that list is AUTHORITATIVE — chunks always get labelled from it,
            # even if the chunker pre-stamped each chunk with a stray local-H1
            # title (e.g. "). " from a paragraph fragment, "VIRUS INHIBITORS"
            # from a running header). Without overriding, those bogus labels
            # survive into pgvector and absorb 30+ chunks each.
            authoritative_list = "_chapters" in page_chapter_map
            if authoritative_list:
                unique_chapters = page_chapter_map.pop("_chapters")
            else:
                chapter_list = sorted(
                    [(ch_num, ch_title) for ch_num, ch_title in page_chapter_map.values() if isinstance(ch_num, int) and ch_num > 0],
                    key=lambda c: c[0],
                )
                seen = set()
                unique_chapters = []
                for ch in chapter_list:
                    if ch[0] not in seen:
                        seen.add(ch[0])
                        unique_chapters.append(ch)

            # Sentence-fragment guard: reject chapter titles starting with
            # punctuation or a lowercase letter — they are mid-sentence body
            # text propagated into a header field by an upstream splitter
            # bug. The chunker-side guard in `_extract_hierarchy_metadata`
            # cleans the per-chunk metadata; this guard cleans the
            # authoritative chapter list before it is ever written back into
            # chunk metadata via the content-matcher write below. Catches
            # Building with Straw Bales (c37828be) chapter 11 where 89
            # chunks otherwise inherited `") , applied when there is no risk
            # of frost…"` from a Tier-3 chapter list that included the
            # garbage entry.
            def _valid_title(_t: str) -> bool:
                if not _t:
                    return False
                _s = _t.strip()
                if not _s:
                    return False
                _f = _s[0]
                if not _f.isalnum() and _f not in ('"', "'", "“", "‘", "«"):
                    return False
                return not (_f.isalpha() and _f.islower())

            unique_chapters = [(n, _sanitize_chapter_title(t) if _valid_title(t) else "") for (n, t) in unique_chapters]

            # Back-matter / front-matter title filter (added 2026-05-14
            # after the Cottrill 1993 Ruminants doc locked 286/294
            # chunks on "Subject Index"). Apply the same skip-list the
            # font-based path uses (line 374) so the content matcher's
            # chapter_match_keys exclude back-matter that should never
            # appear as a real chapter title. Without this, Pattern D
            # collects ALL H1/H2 headers from the doc (including index,
            # glossary, references, etc.); the matcher then finds a
            # single match for one of these in a TOC chunk or body
            # cross-reference and the monotonic gate locks current_ch
            # on the back-matter chapter for the rest of the walk.
            # Signal=3: Botany for Gardeners + Ruminants 1993 before/after
            # Cat-I retry. Rule 11.4 threshold met.
            _back_matter_titles = {
                "contents",
                "table of contents",
                "list of figures",
                "list of tables",
                "list of figures and tables",
                "list of illustrations",
                "conventions",
                "acknowledgments",
                "acknowledgements",
                "about the author",
                "about the authors",
                "preface",
                "foreword",
                # "introduction" added 2026-05-29 (Cat-E P5): front-
                # matter "Introduction" sections (common in
                # non-fiction books) were being labeled with the
                # first real chapter's number because chunker
                # initializes current_chapter=1 for explicit-chapter
                # docs and stamps the Introduction (encountered
                # BEFORE Chapter 1 in source order) with ch=1.
                # Without zeroing, the Introduction body bleeds into
                # Chapter 1's chunk grouping in RAG retrieval and
                # cross-collection graph queries. Signal: cc32d8f5
                # Alchemy of Dreams 12 Introduction chunks falsely
                # labeled ch=1.
                "introduction",
                "prologue",
                "notes",
                "endnotes",
                "footnotes",
                "glossary",
                "bibliography",
                "references",
                "works cited",
                "works quoted",
                "index",
                "subject index",
                "author index",
                "name index",
                "appendix",
                "appendixes",
                "appendices",
                "colophon",
                "copyright",
                "frontispiece",
                "title page",
                "dedication",
                "epigraph",
                # Added 2026-05-14 after bulk Cat-F retry surfaced
                # these as new lock-on-back-matter sources:
                "resources",
                "citations",
                "further reading",
                "recommended reading",
                "additional resources",
                "selected bibliography",
                "metric conversion chart",
                "metric conversion charts",
                "conversion chart",
                "conversion charts",
                "abbreviations",
                "key terms",
                "index of scientific names",
                "index of common names",
                "image credits",
                "photo credits",
                "credits",
                "permissions",
                "publisher",
                "publishing information",
                "imprint",
                "isbn",
            }

            def _is_back_matter(_t: str) -> bool:
                # Strip trailing punctuation (`Glossary.`, `Glossary:`,
                # `Resources!`) before comparing — many docs end the
                # title with a period or other punctuation that would
                # otherwise dodge the set lookup.
                _norm = re.sub(r"\s+", " ", _t.strip().lower())
                _norm = _norm.rstrip(".,;:!?")
                _norm = normalize_whitespace(_norm)
                if _norm in _back_matter_titles:
                    return True
                # "Subject Index" / "Author Index" / "Name Index" pattern
                if re.match(r"^(subject|author|name|topic|general)\s+index$", _norm):
                    return True
                # Any heading with "Index of <something>" — index variants
                return bool(re.match(r"^index\s+of\s+\S", _norm))

            unique_chapters = [(n, t) for (n, t) in unique_chapters if not _is_back_matter(t)]

            # Position-based fallback: when the upstream detector recorded
            # body-side line numbers (Patterns A-D in `_detect_chapters_from_text`
            # — which match `# chapter N` headers AT their body start), we can
            # estimate each chunk's source line from its chunk_index and assign
            # the chapter whose body-line ≤ that estimate. Activates only when
            # the matcher otherwise finds nothing (TOC chunks saturate matches
            # but body chunks may not repeat the title verbatim). Tier 3 (TOC
            # parse) does NOT stash this fallback because its line numbers are
            # TOC-side, not body-side, and would mislead the position estimator.
            position_fallback = page_chapter_map.pop("_chapters_position_fallback", None)
            position_lines_sorted: list[tuple[int, int, str]] = []
            position_total_lines = 0
            # Char-offset variant (Tier 3 body-marker scan): when present,
            # the matcher uses each chunk's ``position_json.char_offset_start``
            # for exact position lookup instead of the chunk_index linear
            # interpolation, which over-approximates for unevenly-sized
            # chunks.
            position_char_offsets_sorted: list[tuple[int, int, str]] = []
            position_total_chars = 0
            if position_fallback:
                position_lines_sorted = sorted(position_fallback["lines"], key=lambda c: c[0])
                position_total_lines = position_fallback["total_lines"]
                if "char_offsets" in position_fallback:
                    position_char_offsets_sorted = sorted(position_fallback["char_offsets"], key=lambda c: c[0])
                    position_total_chars = position_fallback.get("total_chars", 0)
                # Apply the same back-matter filter to position fallback —
                # otherwise position-based assignment could still pin
                # back-matter chunks to "Subject Index" / "Glossary" etc.
                # even when chapter_match_keys excludes them.
                position_lines_sorted = [(li, n, t) for (li, n, t) in position_lines_sorted if not _is_back_matter(t)]
                position_char_offsets_sorted = [(off, n, t) for (off, n, t) in position_char_offsets_sorted if not _is_back_matter(t)]
                # Sanitize titles in position fallback so position-based chunk
                # writes (lines ~919-940 below) don't propagate orphan `**` or
                # `](url)` remnants. The unique_chapters list above is already
                # sanitized but the position fallback paths read separate
                # title tuples derived from the raw Tier 3 / 3.5 / 3.7 body
                # markers.
                position_lines_sorted = [(li, n, _sanitize_chapter_title(t)) for (li, n, t) in position_lines_sorted]
                position_char_offsets_sorted = [(off, n, _sanitize_chapter_title(t)) for (off, n, t) in position_char_offsets_sorted]

            # Global skip-content-match gate: when the chunker has already
            # established a strong per-chunk chapter signal (≥30% of
            # chunks tagged AND ≥3 distinct chapter_numbers), skip the
            # content-matching pass entirely. The content matcher's
            # signal is short title fragments appearing verbatim in body
            # text — for books where those fragments echo across many
            # chunks (TOC + body back-references + cross-chapter citations)
            # the matcher silently rewrites a clean 13-chapter detection
            # down to ~5. Observed on "Advances in Pig Welfare" (Spinka
            # 2017): chunker detected 13 chapters from MD headers, content
            # matcher then overwrote 532/581 chunks with current_ch, and
            # the compactor renumbered max=13 down to 6 distinct.
            chunker_distinct = len(
                {
                    d.metadata.get("chapter_number")
                    for d in chunked_documents
                    if isinstance(d.metadata.get("chapter_number"), int) and d.metadata.get("chapter_number") > 0
                }
            )
            chunker_tagged = sum(1 for d in chunked_documents if (d.metadata.get("chapter_number") or 0) > 0)
            # Skip content-matching when the chunker has a strong signal,
            # REGARDLESS of authoritative_list. The "authoritative list always
            # wins" comment was true for the per-chunk override loop, but in
            # practice the content-matching pass is a low-recall heuristic
            # — short title fragments echoing across body text — that can
            # crush a 13-chapter detection down to 5 distinct
            # chapter_numbers (then compactor renumbers max=13 to 6). When
            # the chunker has already tagged 30%+ of chunks across 3+
            # distinct chapters, its per-chunk MD-header signal is strictly
            # better than the content-matcher's; the authoritative list and
            # the chunker normally agree because both come from the same
            # source markdown anyway.
            skip_content_match = chunker_tagged >= 0.30 * len(chunked_documents) and chunker_distinct >= 3
            logger.info(
                "Content-match gate: chunker_tagged=%d/%d, chunker_distinct=%d, authoritative_list=%s, skip=%s",
                chunker_tagged,
                len(chunked_documents),
                chunker_distinct,
                authoritative_list,
                skip_content_match,
            )

            # Build match keys: use first significant words of title for fuzzy matching
            chapter_match_keys: list[tuple[int, str, str]] = []
            if skip_content_match:
                logger.info(
                    "Chunker already established %d/%d chunks across %d chapters — skipping content-matching override",
                    chunker_tagged,
                    len(chunked_documents),
                    chunker_distinct,
                )
            else:
                for ch_num, ch_title in unique_chapters:
                    title_lower = ch_title.lower().strip()
                    # Use first 4 words (minimum 3 chars each) as match key
                    words = [w for w in title_lower.split() if len(w) >= 3]
                    match_key = " ".join(words[:4]) if words else title_lower
                    chapter_match_keys.append((ch_num, ch_title, match_key))

            # Assign chapters by content matching with TOC detection.
            # Strip pipes for pymupdf4llm TOC table format.
            current_ch = (0, "Introduction")
            updated_count = 0
            backwards_blocks = 0
            total_chunks_for_pos = max(len(chunked_documents) - 1, 1)
            # `preserve_existing` was historically gated on "no authoritative
            # list" — i.e. the legacy path where per-page chunker H1s were
            # the only signal we had. But the same gate must also fire when
            # the skip-content-match decision above said the chunker has a
            # strong signal (>=30% tagged AND >=3 distinct chapters):
            # otherwise the final override below (`if ... or not preserve_existing`)
            # still rewrites every chunk to the running current_ch — which
            # is `(0, "Introduction")` for the entire document since
            # chapter_match_keys is empty under skip — collapsing the
            # 13-chapter detection back down to ~5.
            preserve_existing = (skip_content_match or not authoritative_list) and any(
                (doc.metadata.get("chapter_number") or 0) > 0 for doc in chunked_documents
            )

            # Pre-build a normalised lowercase view of each chunk.
            # pymupdf4llm-layout splits long H1/H3 titles across multiple
            # bold runs (e.g. `### **Understanding Equity and** **Equality
            # in Sustainable** **Irrigation Water Management**`) so the
            # first-4-words match_key fails — "equality" lives in a
            # different bold run than "understanding equity and", and the
            # raw substring search can't cross `** **`. The only chapter
            # in 4a84ec1c whose first 4 words happen to share a single
            # bold run is "Price Volatility and Water", so the matcher
            # locked on it via candidate=single-match at chunk 3 and the
            # monotonic gate then rejected every other chapter going
            # forward, collapsing 12 TOC chapters → 2 distinct. Same root
            # cause on f4f05a98, 6b3e7878, baf798b3.
            # Strip `*`, `_`, `|` and collapse whitespace so emphasis
            # markers don't break substring match.
            def _normalise_for_match(_text: str) -> str:
                _t = _text.lower()
                _t = re.sub(r"[*_|]+", " ", _t)
                _t = re.sub(r"\s+", " ", _t)
                return _t

            for doc in chunked_documents:
                text_lower = _normalise_for_match(doc.page_content)
                # TOC dot-leader detector: chunks with ≥2 dot-leader page
                # references (`. . . . . 273` style) are TOC region chunks.
                # Without this, content matcher's max-of-2-matches rule falls
                # for the highest chapter number even when the chunk is
                # listing all chapters in a TOC, jumping current_ch forward
                # incorrectly. Observed on a7049056 (Amazonian Black Earths)
                # where chunk_index=10 in TOC text got tagged chapter 22.
                toc_dot_leader_count = len(re.findall(r"\.\s*\.\s*\.\s*\.\s*\d{1,4}", doc.page_content))
                # `**N. Title** **page**` style TOCs have no dot-leaders,
                # so the dot-leader detector misses them. The splitter
                # tags those chunks with section_heading="Contents" /
                # "Table of Contents". Without this, a TOC tail chunk
                # that contains only the LAST chapter's entry produces 1
                # match, candidate locks on it, and the monotonic gate
                # then rejects every earlier chapter going forward.
                # Gate the check on chunk_index<=15 so a body subsection
                # literally titled "Contents" (literature reviews,
                # appendix listings) isn't misclassified.
                _sh = (doc.metadata.get("section_heading") or "").strip().lower()
                _ci = doc.metadata.get("chunk_index", 0) or 0
                is_toc_section_heading = _sh in ("contents", "table of contents", "chapters") and _ci <= 15
                is_toc_chunk = toc_dot_leader_count >= 2 or is_toc_section_heading
                # Publisher-boilerplate suppression: Springer/Wiley/etc. per-chapter
                # copyright blocks embed the book series title in license text at the
                # start of each chapter's first chunk (e.g. "S. Singh et al. (eds.),
                # Smart Plant Breeding for Vegetable Crops, https://doi.org/..."). The
                # first-4-word match_key matches that boilerplate, locking
                # current_ch to one chapter. Detect the boilerplate in the first 500
                # chars; when present, only accept matches whose substring position is
                # BEYOND that region.
                _pub_tokens = ("et al. (eds.)", "https://doi.org/", "under exclusive license", "springer nature", "pte ltd.")
                _pub_blob_end = 500 if any(tok in text_lower[:500] for tok in _pub_tokens) else 0
                # Count how many chapter titles appear in this chunk
                matches = []
                for ch_num, ch_title, match_key in chapter_match_keys:
                    _t_lower = ch_title.lower()
                    _title_pos = text_lower.find(_t_lower) if _t_lower else -1
                    _mkey_pos = text_lower.find(match_key) if len(match_key) > 8 else -1
                    if _title_pos < 0 and _mkey_pos < 0:
                        continue
                    if _pub_blob_end > 0:
                        _earliest = min(p for p in (_title_pos, _mkey_pos) if p >= 0)
                        if _earliest < _pub_blob_end:
                            continue
                    matches.append((ch_num, ch_title))
                # If exactly 1 match → this chunk is IN that chapter
                # If 2+ matches → likely a TOC/overview chunk, skip (keep current_ch)
                #
                # MONOTONIC GATE: chunks are walked in chunk_index order, so
                # chapter_number assignment must be NON-DECREASING. Without this,
                # body prose mid-book that mentions an earlier chapter title
                # (e.g. "as discussed in the Political Economy chapter") triggers
                # a backwards jump — observed in production on
                # "Adjustment and Agriculture in Africa": chapter 2 owned
                # chunk_idx {2, 6, 9, 10, 24, 25, 125-173} scattered through the
                # entire book. The fix: a candidate chapter is accepted only
                # when its number is >= current_ch's; a lower-numbered match is
                # treated as a back-reference and ignored.
                candidate: tuple[int, str] | None = None
                if is_toc_chunk:
                    candidate = None  # TOC region — keep current_ch, do not jump
                elif len(matches) == 1:
                    candidate = matches[0]
                elif len(matches) == 2:
                    # 2 matches could be a transition between chapters — use the higher one
                    candidate = max(matches, key=lambda x: x[0])
                if candidate is not None:
                    if candidate[0] >= current_ch[0]:
                        current_ch = candidate
                    else:
                        backwards_blocks += 1
                        # Keep current_ch — this is a back-reference, not a chapter start.

                # Per-chunk preserve gate: when the chunker has ALREADY
                # detected a chapter for this chunk via MD headers (Step 2
                # MarkdownHeaderTextSplitter + step 3 H1/H2 matcher) AND
                # this content-matching pass did NOT find a chapter title
                # in the chunk text, the chunker's signal is strictly
                # better than ours — preserve it. Without this gate the
                # content-based mode silently overwrites a clean
                # 13-chapter detection with whatever low-recall content
                # match was current_ch at the time, collapsing to ~5
                # chapters (observed on Advances in Pig Welfare).
                _chunk_existing = doc.metadata.get("chapter_number") or 0
                # Cat-E P5: Back-matter / front-matter section_heading
                # guard MUST fire BEFORE the preserve gate. The preserve
                # gate trusts whatever chapter_number the chunker
                # stamped — but the chunker has no special handling for
                # front-matter sections (Preface, Introduction). With
                # `doc_has_explicit_chapters=True`, the chunker
                # initializes current_chapter=1 and stamps Preface
                # chunks with ch=1 BEFORE Chapter 1 actually starts.
                # Without zeroing these out, the preserve gate locks
                # ch=1 onto the front-matter and the real Chapter 1
                # body chunks share the same chapter_number. Same logic
                # applies to back-matter (Resources, Glossary). Signal:
                # cc32d8f5 Alchemy of Dreams 2026-05-29 — after P2 v8
                # + P3 cleaned up the TOC pollution, front-matter
                # chunks 1-12 still carried ch=1 instead of ch=0
                # because the preserve gate at line ~998 fired first.
                _sh_raw = (doc.metadata.get("section_heading") or "").strip()
                if _sh_raw and _is_back_matter(_sh_raw):
                    # Clear chapter_title so the chunk isn't pinned to the
                    # previous "real chapter". Empty title → no false
                    # back-matter chapter labels in chunk metadata. The
                    # chunk's content still indexes correctly; just no
                    # chapter attribution.
                    doc.metadata["chapter_number"] = 0
                    doc.metadata["chapter_title"] = ""
                    continue
                # Per-chunk preserve gate: trust chunker chapter_number when
                # we have no new info this iteration. Original gate had
                # `not authoritative_list` which blocked the preserve path
                # for any doc that hit the authoritative list (Tier 3 / font
                # detection) — but for those docs the chunker's MD-header
                # detection is still strictly better than `current_ch` (which
                # never advances when chapter_match_keys is empty under skip).
                # When skip_content_match is in effect, allow preserve to fire
                # regardless of authoritative_list.
                if (skip_content_match or not authoritative_list) and _chunk_existing > 0 and not matches and not position_lines_sorted:
                    if (doc.metadata.get("chapter_number") or 0) > 0:
                        updated_count += 1
                    continue
                # Section-heading guard kept above the preserve gate
                # (moved 2026-05-29). The duplicate check below would
                # be unreachable; collapse to a no-op safeguard.
                _sh_raw = (doc.metadata.get("section_heading") or "").strip()
                if _sh_raw and _is_back_matter(_sh_raw):
                    doc.metadata["chapter_number"] = 0
                    doc.metadata["chapter_title"] = ""
                    continue
                # Section-heading → chapter-match-keys lookup. When chunker's
                # section_heading IS one of our authoritative chapter titles
                # (or contained within one), trust it instead of position
                # fallback. Captures the case where chunks of chapter N
                # are physically located in chapter M's "position region"
                # because of out-of-order layout, font-detection slippage,
                # or PDF page-order quirks.
                _sh_matched_chapter: tuple[int, str] | None = None
                # Use `unique_chapters` (always populated from `_chapters`)
                # rather than `chapter_match_keys` (which is empty when
                # skip_content_match=True). The section_heading lookup
                # must work in both modes.
                if _sh_raw and unique_chapters:
                    _sh_norm = _sh_raw.lower().strip()
                    # 2-pass match: exact title wins over substring overlap.
                    # The original single-pass had iteration-order dependence:
                    # if Chapter 2 "Why Become A Multi-Orgasmic Man?" preceded
                    # Chapter 5 "Become a Multi-Orgasmic Man" in
                    # unique_chapters, the substring branch (_sh_norm in
                    # _ct_norm) would lock chunks intended for Chapter 5 onto
                    # Chapter 2. Verified 2026-05-29 on doc a38515fc: chunks
                    # 7-8 of Chapter 5 body collapsed onto Chapter 2. Run an
                    # exact pass first, fall back to substring only if exact
                    # finds nothing.
                    if len(_sh_norm) >= 5:
                        for _ck_num, _ck_title in unique_chapters:
                            if not _ck_title:
                                continue
                            if _sh_norm == _ck_title.lower().strip():
                                _sh_matched_chapter = (_ck_num, _ck_title)
                                break
                        if _sh_matched_chapter is None:
                            for _ck_num, _ck_title in unique_chapters:
                                if not _ck_title:
                                    continue
                                _ct_norm = _ck_title.lower().strip()
                                # Substring branch — section_heading inside
                                # chapter title (e.g. "Going to Market" inside
                                # "Chapter Fifteen Going to Market") OR the
                                # reverse.
                                if _sh_norm in _ct_norm or _ct_norm in _sh_norm:
                                    _sh_matched_chapter = (_ck_num, _ck_title)
                                    break
                if _sh_matched_chapter is not None:
                    current_ch = _sh_matched_chapter
                    doc.metadata["chapter_number"] = current_ch[0]
                    doc.metadata["chapter_title"] = current_ch[1]
                    if (doc.metadata.get("chapter_number") or 0) > 0:
                        updated_count += 1
                    continue
                elif position_char_offsets_sorted:
                    # Char-offset position-based assignment is AUTHORITATIVE
                    # when available: the chunker stamped each chunk with
                    # its exact char range in source markdown, and Tier 3
                    # scanned the body for ``**CHAPTER**`` markers — so we
                    # know precisely which chapter each chunk falls inside.
                    # Bypass content-matcher (which silently locks on a
                    # sparse TOC-tail match) and the monotonic gate (which
                    # then rejects every other chapter as backwards).
                    _pos = doc.metadata.get("position_json") or {}
                    _start = _pos.get("char_offset_start")
                    _end = _pos.get("char_offset_end")
                    if isinstance(_start, int) and isinstance(_end, int) and _end > _start:
                        # Use chunk midpoint so a chunk straddling a
                        # chapter marker (e.g. boundary chunk with marker
                        # ~10% into its range) is attributed to the
                        # chapter whose body dominates the chunk.
                        chunk_mid = (_start + _end) // 2
                        # Default for chunks BEFORE the first detected
                        # chapter marker: empty title (front-matter zone).
                        # Earlier code used the literal "Introduction" as
                        # placeholder; that mislabelled multi-section
                        # front-matter (Foreword + Preface + Author's Note)
                        # as a single bogus "Introduction" chapter even
                        # when the source had no Introduction section.
                        # Corpus-wide impact: 148 docs / 1409 chunks where
                        # section_heading != "Introduction" but chapter_title
                        # had been forced to "Introduction" by this default.
                        # Canonical case: 7200710c Al-Ghazali Inner Path
                        # — 62 chunks across Foreword + Confessions + Moral
                        # Teachings collapsed under (0, "Introduction").
                        pos_ch: tuple[int, str] = (0, "")
                        for char_off, num, title in position_char_offsets_sorted:
                            if char_off <= chunk_mid:
                                pos_ch = (num, title)
                            else:
                                break
                        current_ch = pos_ch
                elif not matches and position_lines_sorted:
                    # Line-based position fallback (Patterns A-D produced
                    # body line numbers, no char offsets available).
                    chunk_idx = doc.metadata.get("chunk_index", 0) or 0
                    estimated_line = (chunk_idx / total_chunks_for_pos) * position_total_lines
                    # Same fix as char-offset path above — empty title for
                    # front-matter zone, not hardcoded "Introduction".
                    pos_ch_line: tuple[int, str] = (0, "")
                    for line, num, title in position_lines_sorted:
                        if line <= estimated_line:
                            pos_ch_line = (num, title)
                        else:
                            break
                    current_ch = pos_ch_line
                # When the content scan found nothing AND preserve mode is on,
                # leave existing chunking metadata untouched.
                if matches or position_lines_sorted or not preserve_existing:
                    doc.metadata["chapter_number"] = current_ch[0]
                    # Empty title is the correct signal for pre-first-chapter
                    # (front-matter) chunks. Synthesising "Chapter 0" pollutes
                    # the chapter_title field with a placeholder that downstream
                    # graph + hierarchy code then has to filter back out. Real
                    # chapters (>=1) still get "Chapter N" placeholder when the
                    # title is missing, matching the existing convention.
                    if current_ch[1]:
                        doc.metadata["chapter_title"] = current_ch[1]
                    elif current_ch[0] > 0:
                        doc.metadata["chapter_title"] = f"Chapter {current_ch[0]}"
                    else:
                        doc.metadata["chapter_title"] = ""
                if (doc.metadata.get("chapter_number") or 0) > 0:
                    updated_count += 1

        # `num_chapters` must reflect the chapter coverage AFTER content matching,
        # not the per-page page→chapter collapse. For single-page synthetic input
        # (markdown_imported docs), page_chapter_map has only one entry → naive
        # `{v[0] for v in values()}` always yields 1, which then misfires the
        # `_renumber_chapters_from_chunk_titles` fallback below and overwrites a
        # perfectly good Tier-3 + content-based assignment with whatever the
        # chunker stamped onto each chunk's local H1 (e.g. "). ", "VIRUS INHIBITORS").
        num_chapters_pagewise = len({v[0] for v in page_chapter_map.values() if isinstance(v, tuple) and v[0] > 0})
        num_chapters_assigned = len(
            {(doc.metadata.get("chapter_number") or 0) for doc in chunked_documents if (doc.metadata.get("chapter_number") or 0) > 0}
        )
        num_chapters = max(num_chapters_pagewise, num_chapters_assigned)
        if num_chapters > 0:
            logger.info(
                "Assigned chapter metadata to %d/%d chunks (%d chapters detected, mode=%s)",
                updated_count,
                len(chunked_documents),
                num_chapters,
                "page-based" if has_real_pages else "content-based",
            )
            if not has_real_pages and "backwards_blocks" in locals() and backwards_blocks > 0:
                logger.info(
                    "Monotonic gate blocked %d backwards-chapter assignments (back-references in body prose)",
                    backwards_blocks,
                )

        # Final upgrade pass: when font/regex/content detection only finds a
        # single chapter, fall back to renumbering by distinct H1 titles in
        # chunk metadata. enhanced_markdown's per-page chunker tags each chunk
        # with that page's first H1, so books with thematic H1s ('Cover',
        # 'Introduction', 'The Stone'…) end up with rich metadata that the
        # page/font/regex paths missed.
        if num_chapters <= 1:
            distinct_titles = {
                (doc.metadata.get("chapter_title") or "").strip() for doc in chunked_documents if (doc.metadata.get("chapter_title") or "").strip()
            }
            if len(distinct_titles) >= 2:
                renumbered = DocumentProcessor._renumber_chapters_from_chunk_titles(chunked_documents)
                if renumbered > 1:
                    logger.info(
                        "Upgraded chapter detection: renumbered %d chapters from per-page H1 titles",
                        renumbered,
                    )

        # Compact pass: when Pattern E (or any path that pre-numbers more
        # candidates than the content matcher actually assigns) leaves
        # gaps in chapter_number — e.g. {0, 2, 9, 12, 17, ..., 102} for 33
        # distinct chapters — renumber to {1..33} so the resulting graph
        # / hierarchy / UI doesn't expose phantom missing chapters. The
        # renumber function is idempotent on already-dense numberings, so
        # this is safe to run after every fallback.
        # Compacted pass is gated by skip_content_match: when the chunker
        # had a strong signal we trust its numbering verbatim, even if there
        # are gaps (the chunker may legitimately number 1, 2, 4, 5, 7, ...
        # because some MD-headers are not chapter headings). Renumbering by
        # chunk_titles in that case folds distinct chapters together
        # (observed: 13 chunker chapters renumbered down to 5 because
        # the chunker emitted some duplicate titles).
        _skip_compact = locals().get("skip_content_match", False)
        distinct_nums = {doc.metadata.get("chapter_number") for doc in chunked_documents if isinstance(doc.metadata.get("chapter_number"), int)}
        if distinct_nums and not _skip_compact:
            max_num = max(distinct_nums)
            distinct_count = len(distinct_nums)
            if max_num > distinct_count:
                renumbered = DocumentProcessor._renumber_chapters_from_chunk_titles(chunked_documents)
                logger.info(
                    "Compacted chapter numbering: max=%d → %d distinct chapters",
                    max_num,
                    renumbered,
                )

        # Post-assignment lock detection. When content matching produces a
        # catastrophic skew where one chapter_number swallows >70% of chunks
        # AND >=3 distinct chapter_numbers exist, the upstream chapter
        # detection extracted titles that don't actually anchor to body
        # content (canonical case: DK Garden Plants 46e467fd — Tier 3 pulled
        # 9 titles from the TOC region, but the body uses different ALL-CAPS
        # H5/H6 headers like `###### GARDENS in SHADE`, so substring matching
        # finds the first title once and locks every subsequent chunk on it).
        # Trigger LLM Tier 0 fallback + linear redistribution by chunk_index.
        # signal=21 distinct parse_done docs (systemic_blockers entry
        # CHUNKER_CHAPTER_TITLE_LOCK_POST_PATCHES 2026-05-16).
        total_chunks = len(chunked_documents)
        if total_chunks >= 50:
            from collections import Counter

            ch_dist = Counter()
            for doc in chunked_documents:
                ch_dist[doc.metadata.get("chapter_number") or 0] += 1
            distinct_nonzero = sum(1 for k, _v in ch_dist.items() if k > 0)
            if distinct_nonzero >= 3 and ch_dist:
                top_ch, top_count = ch_dist.most_common(1)[0]
                lock_pct = top_count / total_chunks
                if top_ch > 0 and lock_pct > 0.70:
                    logger.warning(
                        "Chapter lock detected: ch=%s swallowed %d/%d chunks (%.0f%%). Triggering LLM Tier 0 fallback.",
                        top_ch,
                        top_count,
                        total_chunks,
                        100.0 * lock_pct,
                    )
                    full_text = "\n".join(p.page_content or "" for p in page_documents)
                    llm_chapters = DocumentProcessor._detect_chapters_via_llm(full_text)
                    if llm_chapters and len(llm_chapters) >= 3:
                        n_chap = len(llm_chapters)
                        chunks_per_chap = max(1, total_chunks // n_chap)
                        for i, doc in enumerate(chunked_documents):
                            ch_idx = min(i // chunks_per_chap, n_chap - 1)
                            _line, ch_num, ch_title = llm_chapters[ch_idx]
                            doc.metadata["chapter_number"] = ch_num
                            doc.metadata["chapter_title"] = ch_title
                        logger.info(
                            "LLM Tier 0 lock-recovery: redistributed %d chunks across %d LLM-detected chapters (linear by chunk_index)",
                            total_chunks,
                            n_chap,
                        )
                    else:
                        logger.info(
                            "LLM Tier 0 lock-recovery: LLM returned <3 chapters — keeping locked assignment",
                        )

        return DocumentProcessor._consolidate_placeholder_chapter_titles(chunked_documents)

    @staticmethod
    def _consolidate_placeholder_chapter_titles(
        chunked_documents: list[LangchainDocument],
    ) -> list[LangchainDocument]:
        """
        Replace `Chapter N` placeholder chapter_titles with the real title from
        sibling chunks that share the same chapter_number.

        Placeholders are emitted by:
        - `_detect_chapters_in_chunks` fallback at line ~1180 when the body
          regex catches a standalone `CHAPTER N` line whose real title is
          on the NEXT line (EPUB typographic openers like Foley 2019
          `Farming for the Long Haul` 1cd00ce9, Kleppel `Emergent Agriculture`
          84ea0789).
        - Page-based mapping at line ~483 when a page has no H1 but inherits
          a chapter_number from an earlier chapter.

        Strategy: build chapter_number → Counter[real_title] mapping (skipping
        placeholders and zero/negative chapter_numbers), then for each chunk
        whose chapter_title matches `^Chapter \\d+$`, replace with the
        most-common real title for that chapter_number. Section_title gets
        the same treatment when it is also a placeholder.

        Cumulative-evidence signal=2 (Kleppel + Foley as of 2026-05-14);
        patch authorised by user override of Rule 11.4.
        """
        if not chunked_documents:
            return chunked_documents

        from collections import Counter as _Counter

        _placeholder_re = re.compile(r"^Chapter\s+\d+$")
        _page_num_chapter_re = re.compile(r"^\d{1,4}\s+(?:CHAPTER|Chapter)\b")
        _markdown_only_re = re.compile(r"^[*_\-=~+#\s]+$")

        def _is_likely_real_title(t: str) -> bool:
            """Strict structural gate — body-text fragments and TOC artifacts MUST fail."""
            if not t:
                return False
            s = t.strip()
            # Length sanity (real chapter titles fit in this window).
            if len(s) < 3 or len(s) > 150:
                return False
            # Must start with letter/digit (or opening quote), not punctuation or lowercase.
            first = s[0]
            if not (first.isalnum() or first in '"“‘'):
                return False
            if first.isalpha() and first.islower():
                return False
            # No pure-markdown markup ("**", "##").
            if _markdown_only_re.match(s):
                return False
            # Real titles aren't long body paragraphs — cap word count.
            if len(s.split()) > 20:
                return False
            # Body text usually has multiple sentence-ending periods; titles don't.
            if s.count(". ") >= 2:
                return False
            # Reject the placeholder pattern itself (must never count as a real title).
            if _placeholder_re.match(s):
                return False
            # Reject "<page-num> CHAPTER N" TOC artifacts (`148  CHAPTER 13`).
            return not _page_num_chapter_re.match(s)

        ch_num_to_real_titles: dict[int, _Counter] = {}
        for doc in chunked_documents:
            ch_num = doc.metadata.get("chapter_number")
            ch_title = doc.metadata.get("chapter_title") or ""
            if not isinstance(ch_num, int) or ch_num <= 0:
                continue
            if not _is_likely_real_title(ch_title):
                continue
            ch_num_to_real_titles.setdefault(ch_num, _Counter())[ch_title] += 1

        consolidated = 0
        for doc in chunked_documents:
            ch_num = doc.metadata.get("chapter_number")
            ch_title = doc.metadata.get("chapter_title") or ""
            if not isinstance(ch_num, int) or ch_num <= 0:
                continue
            if not _placeholder_re.match(ch_title):
                continue
            real_titles = ch_num_to_real_titles.get(ch_num)
            if not real_titles:
                continue
            real_title = real_titles.most_common(1)[0][0]
            doc.metadata["chapter_title"] = real_title
            if doc.metadata.get("section_title") and _placeholder_re.match(doc.metadata["section_title"]):
                doc.metadata["section_title"] = real_title
            consolidated += 1

        if consolidated > 0:
            logger.info(
                "Consolidated %d placeholder chapter_titles into real titles from sibling chunks",
                consolidated,
            )

        return DocumentProcessor._clear_stale_section_heading_at_chapter_boundary(chunked_documents)

    @staticmethod
    def _clear_stale_section_heading_at_chapter_boundary(
        chunked_documents: list[LangchainDocument],
    ) -> list[LangchainDocument]:
        """
        Clear `section_heading` on the first chunk of a new chapter when the
        chunk inherited the PREVIOUS chapter's title via the chunker's
        per-page H1 stamping. Without this guard, every chapter N → N+1
        transition leaves the first chunk of N+1 carrying
        `section_heading = UPPER(prev_chapter_title)`, which pollutes
        `document_hierarchy` with duplicate sub-roots (e.g. `Energy → {ENERGY,
        TACTICAL DISPOSITIONS}`) and inflates DocumentSummaryService output
        (~2× expected summary count).

        Strict gate (Hypothesis B per the audit on Art of War 87b1967f):
          - chunk.section_heading != "" (something to clear)
          - chunk.chapter_number > prev_chunk.chapter_number (chapter advanced)
          - UPPER(chunk.section_heading) == UPPER(prev_chunk.chapter_title)
            (the heading is exactly the previous chapter title, indicating
            it's stale carryover and not a legitimate sub-section heading)

        Observed cross-corpus signal=8 prior books (Art of War 87b1967f
        2026-05-15, plus 7 prior docs). Targeted to catch 11 chunks in
        Art of War alone. False-positive surface kept narrow by requiring
        EXACT case-folded match plus monotonic chapter advance — legitimate
        forward-references to other chapter titles inside body text never
        survive both gates.
        """
        if not chunked_documents:
            return chunked_documents

        cleared = 0
        prev_chapter_title = ""
        prev_chapter_number: int | None = None

        for doc in chunked_documents:
            md = doc.metadata
            ch_num = md.get("chapter_number")
            ch_title = (md.get("chapter_title") or "").strip()
            sec = (md.get("section_heading") or "").strip()

            if (
                sec
                and isinstance(ch_num, int)
                and isinstance(prev_chapter_number, int)
                and ch_num > prev_chapter_number
                and prev_chapter_title
                and sec.upper() == prev_chapter_title.upper()
            ):
                md["section_heading"] = ""
                cleared += 1

            if isinstance(ch_num, int):
                prev_chapter_number = ch_num
                if ch_title:
                    prev_chapter_title = ch_title

        if cleared > 0:
            logger.info(
                "Cleared %d stale section_heading values at chapter-boundary transitions",
                cleared,
            )

        # Tier-4 ALL-CAPS section-heading promotion. Cumulative-evidence
        # signal #2 of `mixed_vocabulary_h1_structural_promotion_disabled`
        # (doc 07bc9b9e Living Through Alchemy + 27622398 Tao of Internal
        # Alchemy, both 2026-05-29). When the chunker collapsed all
        # chunks onto 1-3 chapter_numbers but each chunk carries a
        # distinct ALL-CAPS section_heading — typical of PDF→md
        # extractors that preserve the outline metadata as section but
        # strip the marker from the rendered body — promote
        # section_heading → chapter_title so retrieval queries can
        # resolve to clean section ranges instead of a single bucket
        # like "Induction" swallowing the whole book.
        #
        # Strict gates — ALL must pass before promotion fires:
        #   1. distinct chapter_numbers ≤ 3                (collapse confirmed)
        #   2. distinct section_headings ≥ 8               (rich section data)
        #   3. ≥80 % of distinct sections are ALL-CAPS     (structural markers,
        #                                                   not random Title-Case)
        #   4. No section_heading is back-matter            (Index / Resources /
        #                                                   Glossary / etc. —
        #                                                   the existing
        #                                                   _is_back_matter
        #                                                   filter excludes
        #                                                   these from real
        #                                                   chapter slots)
        try:
            _section_headings = [(d.metadata.get("section_heading") or "").strip() for d in chunked_documents]
            _ch_nums_int = {n for n in (d.metadata.get("chapter_number") for d in chunked_documents) if isinstance(n, int) and n > 0}
            _distinct_sec = {s for s in _section_headings if s}
            if len(_ch_nums_int) <= 3 and len(_distinct_sec) >= 8:
                _allcaps_count = sum(1 for s in _distinct_sec if s.upper() == s and any(c.isalpha() for c in s))
                _backmatter_re = re.compile(
                    r"^(index|resources?|glossary|acknowledg(?:e)?ments?|"
                    r"bibliography|notes?|appendix|appendices|references?|"
                    r"about the author|contents?|preface|foreword|"
                    r"introduction|epilogue|afterword|copyright|colophon)$",
                    re.IGNORECASE,
                )
                _backmatter_count = sum(1 for s in _distinct_sec if _backmatter_re.match(s))
                if _allcaps_count >= 0.8 * len(_distinct_sec) and _backmatter_count == 0:
                    _section_first_seen: dict[str, int] = {}
                    for s in _section_headings:
                        if s and s not in _section_first_seen:
                            _section_first_seen[s] = len(_section_first_seen) + 1
                    _src = (chunked_documents[0].metadata.get("source") if chunked_documents else "") or "(unknown)"
                    logger.info(
                        "Tier-4 ALL-CAPS section promotion firing: %d distinct sections, %d collapsed ch_nums — promoting section_heading→chapter_title for %s",
                        len(_distinct_sec),
                        len(_ch_nums_int),
                        _src,
                    )

                    # Cat-E F3: 4-signal body-fragment gate to prevent
                    # the section_heading→chapter_title promotion from
                    # accepting body prose that the chunker accidentally
                    # captured as section_heading. Same logic the
                    # Pattern C lookahead branch already uses (commits
                    # e5bcc50 + ae847a9 + 10abed6). Verified on doc
                    # cc32d8f5 Alchemy of Dreams 2026-05-29: the string
                    # "Regardless of the symbolism in the" (cumulative
                    # signal #2 of `pattern_c_lookahead_does_not_cover_
                    # all_chapter_title_write_sites`, with Roger Bacon
                    # as #1) was passing into chapter_title via this
                    # site because Tier-4 had no fragment filter.
                    def _is_body_fragment(_text: str) -> bool:
                        if not _text:
                            return False
                        _t = _text.strip()
                        if _t and _t[0].islower():
                            return True
                        _stop_set = {
                            "of",
                            "in",
                            "on",
                            "at",
                            "to",
                            "by",
                            "for",
                            "or",
                            "and",
                            "but",
                            "the",
                            "a",
                            "an",
                            "is",
                            "are",
                            "was",
                            "were",
                            "be",
                            "been",
                            "has",
                            "have",
                            "had",
                            "that",
                            "this",
                            "which",
                            "who",
                            "whom",
                            "from",
                            "into",
                            "onto",
                            "than",
                            "then",
                        }
                        _w = _t.rstrip(".,;:!?").split()
                        if _w and _w[-1].lower() in _stop_set and len(_t) >= 4:
                            return True
                        if len(_w) > 10:
                            return True
                        return bool(re.search(r",\s+[a-z]", _text))

                    for doc in chunked_documents:
                        _sh = (doc.metadata.get("section_heading") or "").strip()
                        if _sh and _sh in _section_first_seen and not _is_body_fragment(_sh):
                            doc.metadata["chapter_number"] = _section_first_seen[_sh]
                            doc.metadata["chapter_title"] = _sh
        except Exception as _tier4_err:
            logger.warning("Tier-4 promotion failed (non-fatal): %s", _tier4_err)

        return chunked_documents

    @staticmethod
    def _renumber_chapters_from_chunk_titles(
        chunked_documents: list[LangchainDocument],
    ) -> int:
        """
        Aggregate distinct chapter_title values from chunk metadata in document
        order and renumber chapter_number globally.

        Used as a final fallback when neither font-based nor regex chapter
        detection finds anything, but per-page chunking has already tagged
        chunks with their local H1 title (each page's chunking strategy
        auto-promoted unique H1 headers to chapter 1, 2, 3... within that page only).

        Returns the number of distinct chapters detected.
        """
        if not chunked_documents:
            return 0

        # Collect distinct titles in first-occurrence order; carry forward the
        # last seen title to chunks whose page lacked an H1 entirely.
        title_to_num: dict = {}
        last_title: str = ""
        for doc in chunked_documents:
            t = (doc.metadata.get("chapter_title") or "").strip()
            if t and t not in title_to_num:
                title_to_num[t] = len(title_to_num) + 1

        # Refuse to renumber if we still only see one (or zero) distinct title —
        # the data is no better than what we already have.
        if len(title_to_num) < 2:
            return len(title_to_num)

        for doc in chunked_documents:
            t = (doc.metadata.get("chapter_title") or "").strip()
            if t and t in title_to_num:
                last_title = t
                doc.metadata["chapter_number"] = title_to_num[t]
                doc.metadata["chapter_title"] = t
            elif last_title:
                # Chunk whose page had no H1 — inherit the previous chapter
                doc.metadata["chapter_number"] = title_to_num[last_title]
                doc.metadata["chapter_title"] = last_title
            else:
                # Cat-E F1: front-matter chunks (no carry-forward yet
                # because we have not seen the first H1 chapter title yet)
                # must NOT inherit the last chapter — they were polluting
                # downstream retrieval with `chapter_number=<last>`. Stamp
                # them as chapter 0 with section_heading as the title so
                # RAG can scope "from the Preface" / "from the Introduction"
                # correctly. Verified on doc cc32d8f5 Alchemy of Dreams
                # 2026-05-29: Preface (chunks 3-11) + Introduction (chunks
                # 12-17) had carried chapter_number=11 (the LAST chapter)
                # with empty chapter_title.
                _sh = (doc.metadata.get("section_heading") or "").strip()
                doc.metadata["chapter_number"] = 0
                doc.metadata["chapter_title"] = _sh

        # Cat-E F2: back-fill empty chapter_title from the first chunk that
        # carries one for the same chapter_number. The H1 parser at Pattern
        # B (line ~2828) correctly captures "# Chapter 5: Language of the
        # Soul" but per-page processing then leaves some chunks of the
        # same chapter with an empty chapter_title. Verified on doc
        # cc32d8f5 Alchemy of Dreams 2026-05-29: H1s with a colon
        # (`# Chapter 5: …`, `# Chapter 9: …`, `# Chapter 11: …`)
        # produced chunks with the correct chapter_number but empty
        # chapter_title. Non-colon H1s (`# Dreaming Possibilities`,
        # `# Sacred Quest-`) were unaffected — strong signal the colon
        # split was dropping the right-hand side at downstream join.
        _ch_num_to_authoritative_title: dict[int, str] = {}
        for doc in chunked_documents:
            _ch_num = doc.metadata.get("chapter_number")
            _ch_title = (doc.metadata.get("chapter_title") or "").strip()
            if isinstance(_ch_num, int) and _ch_num > 0 and _ch_title and _ch_num not in _ch_num_to_authoritative_title:
                _ch_num_to_authoritative_title[_ch_num] = _ch_title

        for doc in chunked_documents:
            _ch_num = doc.metadata.get("chapter_number")
            if (
                isinstance(_ch_num, int)
                and _ch_num > 0
                and not (doc.metadata.get("chapter_title") or "").strip()
                and _ch_num in _ch_num_to_authoritative_title
            ):
                doc.metadata["chapter_title"] = _ch_num_to_authoritative_title[_ch_num]

        return len(title_to_num)

    @staticmethod
    def _detect_chapters_in_chunks(
        chunked_documents: list[LangchainDocument],
    ) -> list[tuple]:
        """
        Scan already-chunked documents for inline "Chapter N" markers and assign
        each chunk to the chapter it falls into.

        Used as a last-resort fallback when page-level and regex detection fail
        (typically when the chunking strategy fell back to sliding-window).

        Mutates chunk metadata in place, setting `_inline_chapter_num` and
        `_inline_chapter_title` on each chunk. Returns the list of
        (chapter_num, chapter_title) tuples for summary logging.
        """
        if not chunked_documents:
            return []

        # Patterns ordered by specificity; first match wins per chunk.
        # Each pattern has a group for chapter number and optional title.
        import re as _re

        _patterns = [
            # "Chapter 3: Foo" / "CHAPTER 3 — Foo" / "Capítulo 3 — Foo" / "Chapitre 3" / ...
            _re.compile(
                rf"^\s*(?:{CHAPTER_KEYWORDS})\s+([IVXLC]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten|"
                r"eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)"
                r"(?:\s*[.:—–-]\s*(.+))?$",
                _re.IGNORECASE | _re.MULTILINE,
            ),
            # "Part 2" / "Book 3"
            _re.compile(
                rf"^\s*(?:{PART_KEYWORDS})\s+([IVXLC]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten)" r"(?:\s*[.:—–-]\s*(.+))?$",
                _re.IGNORECASE | _re.MULTILINE,
            ),
            # Markdown heading with explicit chapter number "## 3. Title"
            _re.compile(
                r"^\s*#{1,3}\s+(\d+)\s*[.:]\s+(.+)$",
                _re.MULTILINE,
            ),
        ]

        _roman_map = {
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
            "xxi": 21,
            "xxii": 22,
            "xxiii": 23,
            "xxiv": 24,
            "xxv": 25,
            "one": 1,
            "two": 2,
            "three": 3,
            "four": 4,
            "five": 5,
            "six": 6,
            "seven": 7,
            "eight": 8,
            "nine": 9,
            "ten": 10,
            "eleven": 11,
            "twelve": 12,
            "thirteen": 13,
            "fourteen": 14,
            "fifteen": 15,
            "sixteen": 16,
            "seventeen": 17,
            "eighteen": 18,
            "nineteen": 19,
            "twenty": 20,
        }

        def _normalize_num(raw: str) -> int:
            low = raw.lower().strip()
            if low in _roman_map:
                return _roman_map[low]
            try:
                return int(low)
            except ValueError:
                return 0

        found_chapters: list[tuple] = []
        current_ch_num = 0
        current_ch_title = ""

        for doc in chunked_documents:
            text = doc.page_content or ""
            # Only check the first ~400 chars — chapter markers appear at the top
            prefix = text[:400]

            for pat in _patterns:
                m = pat.search(prefix)
                if m:
                    num_raw = m.group(1)
                    num = _normalize_num(num_raw)
                    if num <= 0 or num > 200:  # sanity check
                        continue
                    # noinspection PyUnresolvedReferences
                    title_raw = (m.group(2) or "").strip() if m.lastindex and m.lastindex >= 2 else ""
                    title = title_raw[:80] if title_raw else f"Chapter {num}"

                    # Body-prose forward-reference guard. Pattern 1/2 above
                    # capture anything after the chapter/part number, so a
                    # sentence in prose like "Chapter 6 draws together areas
                    # for future research across the diverse case studies..."
                    # turns into chapter_title="draws together areas..."
                    # and mislabels every subsequent chunk as the wrong
                    # chapter. Real chapter titles use Title Case (uppercase
                    # first letter); body-prose forward-references start with
                    # a lowercase verb. Combined with a >5-word threshold
                    # this catches forward-references while preserving
                    # legitimate short foreign-language titles like Italian
                    # "prima parte" or English "appendix e". Canonical
                    # incident: Ferne Edwards 2023 Food Resistance Movements
                    # chunks 58-70 misclassified as chapter 6 because
                    # Pattern 1 matched the forward-pointer in chapter 1
                    # narrative.
                    if title_raw and title_raw[0].isalpha() and title_raw[0].islower() and len(title_raw.split()) > 5:
                        continue

                    # Only advance chapter if num > current (avoids mistaking back-references)
                    if num > current_ch_num:
                        current_ch_num = num
                        current_ch_title = title
                        found_chapters.append((num, title))
                        break

            doc.metadata["_inline_chapter_num"] = current_ch_num
            doc.metadata["_inline_chapter_title"] = current_ch_title

        # Only return if we actually found multiple distinct chapters
        distinct = {(n, t) for n, t in found_chapters}
        if len(distinct) < 2:
            # Clean up temporary metadata — nothing useful detected
            for doc in chunked_documents:
                doc.metadata.pop("_inline_chapter_num", None)
                doc.metadata.pop("_inline_chapter_title", None)
            return []
        return found_chapters

    @staticmethod
    def _detect_chapters_from_toc_section(
        full_lines: list[str],
        page_line_offsets: dict[int, tuple[int, int]],
    ) -> dict[int, tuple] | None:
        """
        Tier 3 chapter detection: parse the chapter list from an explicit markdown TOC
        section (between a `#+ **Contents**`-style header and the figure list / running
        headers / a large gap of non-TOC content).

        Designed for `markdown_imported` documents whose source markdown was Docling-
        exported from a PDF and lacks `#`-prefixed chapter headings in the body but DOES
        contain a recognisable Contents section near the top. Avoids the false positives
        that a naive whole-document scan produces (front-matter publisher addresses
        matching `II _New Fetter Lane_`, page running headers like `VIRUS INHIBITORS 145`,
        figure captions like `22. Micrograph of...`).

        Returns:
            Same shape as `_detect_chapters_from_text`: page→(chapter_num, chapter_title).
            None when no usable TOC section is found — caller falls through to Patterns
            A/B/C/D.
        """
        toc_header = re.compile(
            r"^\s*#+\s*\**\s*(?:table\s+of\s+contents|contents|chapters)\s*\**\s*$",
            re.IGNORECASE,
        )
        # The `[A-Z](?:[a-z]|\s+[A-Z])` alternation accepts both classic
        # title-case starts (`Apple`, `Botany`) AND single-letter-word
        # starts (`A Crop Stress Index`, `An Overview`, `On Sustainability`).
        # The earlier `[A-Z][a-z]` 2-char anchor incorrectly rejected
        # `4. A Crop Stress Index to Predict Climatic Effects on Row-Crop`
        # because the second char was a space, not lowercase. Regression
        # scan against 231 production docs: 44 docs gain 1-12 additional
        # legitimate chapter matches, zero docs lose existing matches.
        toc_entry = re.compile(r"^\s*([IVXLC]+|\d{1,2})[.\s]+\[?\s*([A-Z](?:[a-z]|\s+[A-Z])[A-Za-z0-9\-\s,:.()\[\]]{2,80})\s*$")
        figure_caption = re.compile(
            r"^\s*\d{1,3}\s*[.\s]+\s*"
            r"(?:Electron\b|Micrograph\b|Photo(?:graph)?\b|Figure\b|Fig\.\s|Plate\b"
            r"|Cross-section\b|Diagram\b|Section through\b)",
            re.IGNORECASE,
        )
        running_header = re.compile(r"^\s*\d{1,4}\s+[A-Z][A-Z\s]{4,}\s*$")
        toc_page_noise = re.compile(r"^[\s\[\]0-9IVXLCivxlc]+$")
        toc_page_running = re.compile(
            r"^[ivxlcdmIVXLCDM]+\s+(CONTENTS|PLATES|FIGURES|TABLES)\s*$",
            re.IGNORECASE,
        )

        # Tier 3 only fires when the `Contents` header is in the TOP 10% of the
        # document — that's where real chapter TOCs sit. EPUB exports often have
        # a SECOND `## Contents` near the END (the "Landmarks" listing of HTML
        # links to title page / cover / etc.), and matching that pulls in fake
        # chapters from URL-suffixed entries like `1. [Cover](cover.xhtml)` while
        # suppressing the body-resident `# chapter N Title` headers that
        # Patterns A-D would handle correctly.
        max_toc_line = max(50, len(full_lines) // 10)
        toc_start = next(
            (i for i, line in enumerate(full_lines[:max_toc_line]) if toc_header.match(line)),
            None,
        )
        if toc_start is None:
            return None

        roman = {
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
            "xxi": 21,
            "xxii": 22,
            "xxiii": 23,
            "xxiv": 24,
            "xxv": 25,
        }

        def _clean_title(raw: str) -> str:
            t = raw.strip().rstrip(".")
            # Strip TOC dot-leader runs (Tier 3.5 parity, commit 39f58ce).
            # Production PDF→md extractors emit `Title . . . . . . 145` style
            # rows; without this strip, the title carries literal `. . . . .`
            # tails into chunk chapter_title.
            t = re.sub(r"(\s*\.\s*){3,}.*$", "", t)
            t = re.sub(r"\s+\d{1,4}\s*$", "", t)
            t = re.sub(r"[\[\]]+", "", t)
            t = normalize_whitespace(t)
            return t

        max_gap = 30
        gap = 0
        raw_chapters: list[tuple[int, int, str]] = []

        for i in range(toc_start + 1, len(full_lines)):
            s = full_lines[i].strip()
            if not s:
                gap += 1
                if gap > max_gap:
                    break
                continue
            if figure_caption.match(s) or running_header.match(s):
                break
            if toc_page_noise.match(s) or toc_page_running.match(s):
                continue
            # Strip markdown emphasis (**bold**, _italic_) so bold-wrapped TOC entries
            # like `**1** **Introduction** 1` reach Tier 3 instead of Pattern D.
            cleaned = re.sub(r"\*+", " ", s)
            cleaned = re.sub(r"(?<![A-Za-z])_+|_+(?![A-Za-z])", " ", cleaned)
            cleaned = normalize_whitespace(cleaned)
            m = toc_entry.match(cleaned)
            if m:
                num_str = m.group(1).lower()
                ch_num = roman.get(num_str, int(num_str) if num_str.isdigit() else 0)
                if 1 <= ch_num <= 50:
                    title = _clean_title(m.group(2))
                    if title and len(title) >= 3:
                        raw_chapters.append((i, ch_num, title))
                        gap = 0
                        continue
            gap += 1
            if gap > max_gap:
                break

        # Dedupe by chapter number (TOC entries are authoritative; first wins).
        seen: set[int] = set()
        chapters: list[tuple[int, int, str]] = []
        for li, n, t in raw_chapters:
            if n in seen:
                continue
            seen.add(n)
            chapters.append((li, n, t))

        if len(chapters) < 3:
            return None

        logger.info(
            "Tier 3 TOC-section detection: %d chapters from `Contents` section starting at line %d",
            len(chapters),
            toc_start,
        )
        for ch_line, ch_num, ch_title in chapters:
            logger.debug("  Tier 3 chapter %d: %s (line %d)", ch_num, ch_title, ch_line)

        # Build the page→chapter mapping the same way the regex Patterns A-D path does.
        # For single-page synthetic input (markdown_imported), this collapses to "last
        # chapter wins" — so we ALSO stash the full chapter list under "_chapters" so
        # the content-based matcher in _assign_cross_page_chapter_metadata can see all
        # chapters, not just the last one. Mirrors what the font-based path does.
        page_chapter_map: dict[int, tuple] = {}
        for page_num, (_start_line, end_line) in sorted(page_line_offsets.items()):
            assigned_ch: tuple[int, str] = (0, "")
            for ch_line, ch_num, ch_title in chapters:
                if ch_line <= end_line:
                    assigned_ch = (ch_num, ch_title)
                else:
                    break
            page_chapter_map[page_num] = assigned_ch

        if len(page_line_offsets) <= 1:
            page_chapter_map["_chapters"] = [(num, title) for _, num, title in chapters]

        # Body-marker scan for position-recovery: some multi-author edited
        # volumes (Springer, CRC Press, etc.) prefix each chapter body with
        # a standalone ``**CHAPTER**`` marker line. Capturing those body
        # line numbers lets the content-matcher fall back to position-based
        # assignment when chapter titles are hoisted out of page_content
        # into ``section_heading`` metadata by the splitter — so the
        # substring-matcher can't find them anywhere in the chunk text and
        # current_ch ends up locked on whatever sparse match the TOC tail
        # produced. Observed on 4a84ec1c, f4f05a98, 6b3e7878, baf798b3.
        # Match TWO body-marker patterns:
        #  (a) Springer / CRC Press standalone bold `**CHAPTER**` line
        #      (no number) — used on 4a84ec1c.
        #  (b) Springer / Wiley H6 numbered `###### **Chapter N**` line
        #      — used on f4f05a98, `7b` doc and 604ae877.
        # Pattern (b) is much more common (4/218 docs) and gives a
        # numbered handle which is sometimes useful for alignment when
        # Tier 3 returned a non-contiguous chapter list.
        body_marker_re_unnum = re.compile(r"^\s*\*+\s*CHAPTER\s*\*+\s*$", re.IGNORECASE)
        body_marker_re_h6num = re.compile(r"^######\s+\*+\s*Chapter\s+(?P<num>\d{1,3}|[IVXLC]+)\s*\*+\s*$", re.IGNORECASE)
        toc_end_line = chapters[-1][0] if chapters else toc_start
        # Pre-compute line → char_offset for the doc once.
        line_char_offsets: list[int] = [0] * (len(full_lines) + 1)
        running = 0
        for li, ln in enumerate(full_lines):
            line_char_offsets[li] = running
            running += len(ln) + 1
        line_char_offsets[len(full_lines)] = running
        total_chars = running

        # Walk the body after the TOC region collecting BOTH marker
        # variants. The H6-numbered variant gives us a chapter number
        # AND lets us reach forward to the next H3/H4 line for the
        # title. The unnumbered `**CHAPTER**` variant only gives a
        # position; we pair it sequentially with Tier 3 chapters.
        h6_numbered_markers: list[tuple[int, int, str]] = []
        unnum_marker_lines: list[int] = []
        for i in range(toc_end_line + 1, len(full_lines)):
            stripped = full_lines[i].rstrip()
            m_num = body_marker_re_h6num.match(stripped)
            if m_num:
                num_str = m_num.group("num")
                if num_str.isdigit():
                    n = int(num_str)
                else:
                    n = roman.get(num_str.lower(), 0)
                if not (1 <= n <= 200):
                    continue
                # Reach forward up to 8 lines for the H3/H4 title.
                title = f"Chapter {n}"
                for j in range(i + 1, min(i + 8, len(full_lines))):
                    s = full_lines[j].rstrip()
                    if not s:
                        continue
                    m_t = re.match(r"^#{3,4}\s+(.+?)\s*$", s)
                    if m_t:
                        t = re.sub(r"\*+", " ", m_t.group(1))
                        t = normalize_whitespace(t)
                        if t and len(t) >= 3:
                            title = t
                        break
                h6_numbered_markers.append((i, n, title))
                continue
            if body_marker_re_unnum.match(stripped):
                unnum_marker_lines.append(i)

        # Strip TOC-side leading punctuation that creeps in when titles are
        # extracted from `Chapter N\n: Title` shapes. Without this the colon
        # leaks into chapter_title downstream — verified 2026-05-29 on doc
        # a38515fc Multi-Orgasmic Man: chunk 1 was stamped with chapter_title
        # ": What Can I Expect To Feel?" (TOC entry for Chapter 7) instead of
        # the Introduction title it actually belonged to.
        def _clean_title(_t: str) -> str:
            return re.sub(r"^[\s:\-]+", "", _t or "").strip()

        # Prefer H6 numbered markers when present in sufficient quantity:
        # they're the real ground-truth body sequence and self-describe
        # number + title. Falls back to unnumbered `**CHAPTER**`
        # paired with Tier 3 chapters.
        position_char_offsets: list[tuple[int, int, str]] = []
        if len(h6_numbered_markers) >= 3 and len(h6_numbered_markers) >= len(chapters):
            for marker_line, n, title in h6_numbered_markers:
                position_char_offsets.append((line_char_offsets[marker_line], n, _clean_title(title)))
            page_chapter_map["_chapters_position_fallback"] = {
                "char_offsets": position_char_offsets,
                "total_chars": total_chars,
                "lines": [(li, n, _clean_title(t)) for li, n, t in h6_numbered_markers],
                "total_lines": len(full_lines),
            }
            logger.info(
                "Tier 3 body-marker scan: %d numbered `###### **Chapter N**` markers used (Tier 3 had %d TOC chapters)",
                len(h6_numbered_markers),
                len(chapters),
            )
        elif unnum_marker_lines and len(unnum_marker_lines) >= len(chapters) // 2:
            for marker_line, (_, ch_num, ch_title) in zip(unnum_marker_lines, chapters, strict=False):
                position_char_offsets.append((line_char_offsets[marker_line], ch_num, _clean_title(ch_title)))
            page_chapter_map["_chapters_position_fallback"] = {
                "char_offsets": position_char_offsets,
                "total_chars": total_chars,
                "lines": [
                    (marker_line, ch_num, _clean_title(ch_title))
                    for marker_line, (_, ch_num, ch_title) in zip(unnum_marker_lines, chapters, strict=False)
                ],
                "total_lines": len(full_lines),
            }
            logger.info(
                "Tier 3 body-marker scan: %d `**CHAPTER**` markers paired with %d Tier 3 chapters",
                len(unnum_marker_lines),
                len(chapters),
            )

        return page_chapter_map

    @staticmethod
    def _detect_chapters_from_keyword_toc(
        full_lines: list[str],
        page_line_offsets: dict,
    ) -> dict[int, tuple] | None:
        """
        Tier 3.5 — keyword-form TOC detector.

        Triggers on books whose TOC has NO ``## Contents`` markdown anchor
        but DOES contain a tight cluster of bold ``**Chapter N** **Title**``
        entries. Designed for sources like Godfrey 1994 'Agrochemicals from
        Natural Products' where the TOC is split across pre-/post-Contents
        zones and Tier 3 anchors on the wrong line.

        Returns the same shape as ``_detect_chapters_from_toc_section`` —
        ``page_chapter_map`` dict with optional ``_chapters`` entry — or
        ``None`` when the strict gates fail.

        Strict gates (designed to avoid body-footnote false positives):
          1. Lines must START with bold (`** ` or `**`) — body refs like
             ``as discussed in Chapter 5 below`` are not bold-wrapped at
             the line start.
          2. Best cluster: at least 5 entries within a 100-line window.
          3. Numbering monotonic with gap ≤ 3 between consecutive entries.
          4. Cluster ``max(num) - min(num) ≤ len(cluster) * 2`` (no large
             holes — real TOCs number 1, 2, 3, …).
          5. Final chapter count after dedupe must be in [3, 50].

        Verified against all 16 prior parse_done agriculture books: zero
        of them have any bold ``**Chapter N**`` lines, so this method
        never even reaches the cluster scan for them. The Godfrey
        Agrochemicals book (3394e8a4) returns 9 chapters with this method.
        """
        # Sentinel: the line MUST start with `**` so body footnote mentions
        # like `as discussed in Chapter 5 below` cannot match. After the
        # sentinel passes, normalize the whole line by stripping all `**`
        # / `*` / `_` markers (some publishers split bold across multiple
        # `**...**` runs, e.g. `**Chapter 5 Animal Health** **Products**`).
        bold_sentinel = re.compile(rf"^\s*\*\*\s*(?:{ALL_CHAPTER_KEYWORDS})\b", re.IGNORECASE)
        # Post-strip regex: `Chapter [<scrambled prefix> ]<num>[<page>]<title>`
        chapter_after_strip = re.compile(
            r"^\s*"
            rf"(?:{ALL_CHAPTER_KEYWORDS})\s+"
            r"(?:([A-Z][A-Za-z\s\-,:.()]{0,40}?)\s+)?"
            r"(\d{1,2})\b"
            r"\s*\.?\s*"
            r"([A-Z][A-Za-z0-9\-\s,:.()\[\]]{2,80}?)\s*$",
            re.IGNORECASE,
        )

        candidates: list[tuple[int, int, str]] = []
        for i, line in enumerate(full_lines):
            if not bold_sentinel.match(line):
                continue
            cleaned = re.sub(r"\*+", " ", line)
            cleaned = re.sub(r"(?<![A-Za-z])_+|_+(?![A-Za-z])", " ", cleaned)
            # TOC dot-leader strip. Production PDF→md extractors emit the
            # ellipsis/dot-leader between TOC entry text and page number
            # as either Unicode horizontal ellipsis (`…` U+2026, common
            # in Docling output) or an ASCII chain of 3+ periods
            # (`. . . . . . . . . 18`). The chapter_after_strip regex
            # character class does not include `…` and is greedy on `.`
            # which traps the title boundary. Without this normalisation,
            # Tier 3.5 misses ALL frontmatter TOC entries that contain a
            # dot-leader and falls through to a body H3 lookalike cluster
            # — observed on FAO Briquetting 1990 (a28bde40): 21 TOC
            # entries silently parsed to 0; only an in-body 6-entry
            # `### **Chapter 12...** **Chapter 13...**` cluster fired,
            # locking chunks to chapters 12-17 only. Regression scan
            # against 119 prior parse_done docs returned exactly 2 deltas
            # (f188d5cb +9, c72affa4 +3) — both strict improvements with
            # genuine dot-leader TOCs that were under-detected before.
            cleaned = re.sub(r"[․‥…⋯]+", " ", cleaned)
            cleaned = re.sub(r"(?:\s*\.\s*){3,}", " ", cleaned)
            cleaned = normalize_whitespace(cleaned)
            m = chapter_after_strip.match(cleaned)
            if not m:
                continue
            try:
                ch_num = int(m.group(2))
            except (TypeError, ValueError):
                continue
            if not (1 <= ch_num <= 50):
                continue
            prefix = (m.group(1) or "").strip()
            suffix = m.group(3).strip().rstrip(".")
            # When OCR scrambled order put the noun before the number, the
            # real title is `<prefix> <suffix>`; otherwise just `<suffix>`.
            raw_title = f"{prefix} {suffix}".strip() if prefix else suffix
            # Strip trailing page numbers (` 285` etc.)
            raw_title = re.sub(r"\s+\d{1,4}\s*$", "", raw_title)
            # After the dot-leader collapse + page-number strip, the title
            # can still end with a lone whitespace-separated period that
            # was the residual gap-marker from a TOC entry (e.g.
            # `Main issues .` after `… 4` was stripped). Drop ALL
            # trailing single-period+space tails so the chunker doesn't
            # propagate `Main issues .` as the chapter_title down to
            # 150 chunks.
            raw_title = re.sub(r"(?:\s+\.+)+\s*$", "", raw_title)
            raw_title = normalize_whitespace(raw_title)
            if raw_title and len(raw_title) >= 3:
                candidates.append((i, ch_num, raw_title))

        # Gate 2: enough total candidates to form a cluster
        if len(candidates) < 5:
            return None

        # Find largest cluster: consecutive entries within 100 lines,
        # sequential numbering (gap ≤ 3, monotonic non-decreasing).
        best_cluster: list[tuple[int, int, str]] = []
        for start_idx in range(len(candidates)):
            cluster = [candidates[start_idx]]
            for next_idx in range(start_idx + 1, len(candidates)):
                line_gap = candidates[next_idx][0] - cluster[-1][0]
                if line_gap > 100:
                    break
                num_diff = candidates[next_idx][1] - cluster[-1][1]
                if 0 <= num_diff <= 3:
                    cluster.append(candidates[next_idx])
            if len(cluster) > len(best_cluster):
                best_cluster = cluster

        if len(best_cluster) < 5:
            return None

        # Gate 4: numbering must be mostly sequential — no large holes.
        nums = [c[1] for c in best_cluster]
        if max(nums) - min(nums) > len(best_cluster) * 2:
            return None

        # Dedupe by chapter number (first wins — TOC entries are
        # authoritative; body lookalikes pulled in by relaxed line gap
        # cannot displace them).
        seen: set[int] = set()
        chapters: list[tuple[int, int, str]] = []
        for li, n, t in best_cluster:
            if n in seen:
                continue
            seen.add(n)
            chapters.append((li, n, t))

        if not (3 <= len(chapters) <= 50):
            return None

        logger.info(
            "Tier 3.5 keyword-TOC detection: %d chapters from bold `**Chapter N**` cluster (lines %d–%d)",
            len(chapters),
            chapters[0][0],
            chapters[-1][0],
        )
        for ch_line, ch_num, ch_title in chapters:
            logger.debug("  Tier 3.5 chapter %d: %s (line %d)", ch_num, ch_title, ch_line)

        # Build page_chapter_map mirror of Tier 3 output.
        page_chapter_map: dict = {}
        for page_num, (_start_line, end_line) in sorted(page_line_offsets.items()):
            assigned_ch = (0, "")
            for ch_line, ch_num, ch_title in chapters:
                if ch_line <= end_line:
                    assigned_ch = (ch_num, ch_title)
                else:
                    break
            page_chapter_map[page_num] = assigned_ch

        if len(page_line_offsets) <= 1:
            page_chapter_map["_chapters"] = [(num, title) for _, num, title in chapters]

        return page_chapter_map

    @staticmethod
    def _detect_chapters_from_page_prefix_toc(
        full_lines: list[str],
        page_line_offsets: dict,
    ) -> dict[int, tuple] | None:
        """
        Tier 3.6 — page-prefix + keyword + bold-title TOC detector.

        Triggers on books whose TOC entries lead with a page number (1-3
        digits), then a chapter keyword, then a word/roman/arabic ordinal,
        then a bold title. Susan Lundy's Heritage Apples (987a4d33) is the
        canonical case:

            1 chapter one **The Apples of My Eye**
            21 chapter two **"A" is for Apple**
            ...
            191 chapter ten **The Apple Doesn't Fall Far from the Tree**

        Patterns A/B/C all miss because the line starts with a page number;
        Tier 3 misses because there's no `## Contents` markdown header (only
        plain-text `contents`); Tier 3.5 misses because entries lack the
        leading `**Chapter N**` bold wrapper.

        Strict gates (verified against 217 production docs — exactly 1 hit,
        the target doc):
          1. Match must be in TOP 10 % of doc (TOC always lives in the
             frontmatter; body back-references in Endnotes are at the end).
          2. ≥5 distinct sequential chapter numbers (matching the chapter
             keyword + ordinal — body lookalikes do not stack).
          3. Sequential ordinal map (one→1, two→2, ... twenty→20, plus
             arabic and roman) — non-monotonic match cluster rejected.
          4. Final chapter count after dedupe must be in [3, 50].
        """
        word_to_num = {
            "one": 1,
            "two": 2,
            "three": 3,
            "four": 4,
            "five": 5,
            "six": 6,
            "seven": 7,
            "eight": 8,
            "nine": 9,
            "ten": 10,
            "eleven": 11,
            "twelve": 12,
            "thirteen": 13,
            "fourteen": 14,
            "fifteen": 15,
            "sixteen": 16,
            "seventeen": 17,
            "eighteen": 18,
            "nineteen": 19,
            "twenty": 20,
        }
        roman = {
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
        line_re = re.compile(
            rf"^\s*(\d{{1,3}})\s+(?:{ALL_CHAPTER_KEYWORDS})\s+"
            r"([ivxlcIVXLC]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten|"
            r"eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+"
            r"\*\*(.+?)\*\*\s*$",
            re.IGNORECASE,
        )

        # Gate 1: scan only the top 10 % of the document.
        top_limit = max(1, len(full_lines) // 10)

        candidates: list[tuple[int, int, str]] = []
        for i in range(top_limit):
            m = line_re.match(full_lines[i].strip())
            if not m:
                continue
            num_str = m.group(2).lower()
            if num_str.isdigit():
                ch_num = int(num_str)
            elif num_str in word_to_num:
                ch_num = word_to_num[num_str]
            elif num_str in roman:
                ch_num = roman[num_str]
            else:
                continue
            if not (1 <= ch_num <= 50):
                continue
            title = m.group(3).strip()
            title = re.sub(r"\s+", " ", title)
            if title and len(title) >= 3:
                candidates.append((i, ch_num, title))

        # Gate 2: at least 5 entries
        if len(candidates) < 5:
            return None

        # Gate 3: sequential numbering (gap ≤ 2 between consecutive entries)
        nums = [c[1] for c in candidates]
        sequential_run = 1
        max_run = 1
        for prev, cur in itertools.pairwise(nums):
            if 0 < cur - prev <= 2:
                sequential_run += 1
                max_run = max(max_run, sequential_run)
            else:
                sequential_run = 1
        if max_run < 5:
            return None

        # Dedupe by chapter number (TOC entries are authoritative; first wins).
        seen: set[int] = set()
        chapters: list[tuple[int, int, str]] = []
        for li, n, t in candidates:
            if n in seen:
                continue
            seen.add(n)
            chapters.append((li, n, t))

        if not (3 <= len(chapters) <= 50):
            return None

        logger.info(
            "Tier 3.6 page-prefix-TOC detection: %d chapters from `<page> chapter <ord> **Title**` cluster (lines %d–%d)",
            len(chapters),
            chapters[0][0],
            chapters[-1][0],
        )
        for ch_line, ch_num, ch_title in chapters:
            logger.debug("  Tier 3.6 chapter %d: %s (line %d)", ch_num, ch_title, ch_line)

        # Build page_chapter_map mirror of Tier 3 / Tier 3.5 output.
        page_chapter_map: dict = {}
        for page_num, (_start_line, end_line) in sorted(page_line_offsets.items()):
            assigned_ch: tuple[int, str] = (0, "")
            for ch_line, ch_num, ch_title in chapters:
                if ch_line <= end_line:
                    assigned_ch = (ch_num, ch_title)
                else:
                    break
            page_chapter_map[page_num] = assigned_ch

        if len(page_line_offsets) <= 1:
            page_chapter_map["_chapters"] = [(num, title) for _, num, title in chapters]

        return page_chapter_map

    @staticmethod
    def _detect_chapters_from_h6_body_markers(
        full_lines: list[str],
        page_line_offsets: dict,
    ) -> dict[int, tuple] | None:
        """
        Tier 3.7 — H6 numbered body-marker chapter detector.

        Scans the doc for ``###### **Chapter N**`` lines and pairs each
        with the next non-empty H3/H4 line as the chapter title.
        Self-sufficient: number + title both come from the body markers,
        no TOC anchor required. Returns same shape as Tier 3.

        Strict gates: ≥3 markers; numbers in 1..200; title ≥ 3 chars;
        H3/H4 within 8 lines of the marker.

        Designed for Springer / Wiley edited volumes where the body
        chapter delimiter is the canonical signal and the TOC layout is
        whatever the upstream PDF extractor produced (Part-titled H2s,
        no Contents anchor — Tier 3 / 3.5 / 3.6 all fail).
        """
        body_marker_re = re.compile(r"^######\s+\*+\s*Chapter\s+(?P<num>\d{1,3}|[IVXLC]+)\s*\*+\s*$", re.IGNORECASE)
        title_re = re.compile(r"^#{3,4}\s+(.+?)\s*$")
        roman = {
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
            "xxi": 21,
            "xxii": 22,
            "xxiii": 23,
            "xxiv": 24,
            "xxv": 25,
        }
        markers: list[tuple[int, int, str]] = []
        line_char_offsets: list[int] = []
        running = 0
        for ln in full_lines:
            line_char_offsets.append(running)
            running += len(ln) + 1
        total_chars = running

        for i, line in enumerate(full_lines):
            m = body_marker_re.match(line.rstrip())
            if not m:
                continue
            num_str = m.group("num")
            n = int(num_str) if num_str.isdigit() else roman.get(num_str.lower(), 0)
            if not (1 <= n <= 200):
                continue
            title = ""
            for j in range(i + 1, min(i + 8, len(full_lines))):
                s = full_lines[j].rstrip()
                if not s:
                    continue
                m_t = title_re.match(s)
                if m_t:
                    t = re.sub(r"\*+", " ", m_t.group(1))
                    t = normalize_whitespace(t)
                    if t and len(t) >= 3:
                        title = t
                    break
            if not title:
                title = f"Chapter {n}"
            markers.append((i, n, title))

        if len(markers) < 3:
            return None
        # Title-quality gate: require >=50% of markers to have real
        # titles (not the `Chapter N` placeholder). Without this, books
        # whose H6 chapter markers aren't followed by H3/H4 titles
        # (e.g. `7b` Forest Dynamics doc — markers exist but title is
        # in a non-header text run) yield a chapter map with placeholder
        # titles. The pre-existing Pattern A-D path produces better
        # titles for those books; defer to it.
        real_titles = sum(1 for _, n, t in markers if t and not t.startswith(f"Chapter {n}"))
        if real_titles < 0.5 * len(markers):
            return None
        # Position-spread gate: first marker must be in the first 30%
        # of the doc and the markers must span at least 30% of total
        # lines. Without this, page running headers or index entries
        # in back matter that happen to match the pattern (e.g. doc
        # 4a84ec1c has 5 such tail-matches at lines 16485-16736 out
        # of 16785) would produce a false-positive 5-chapter map and
        # override the correct Tier 3 result.
        first_marker_line = markers[0][0]
        last_marker_line = markers[-1][0]
        if first_marker_line > 0.30 * len(full_lines):
            return None
        if (last_marker_line - first_marker_line) < 0.30 * len(full_lines):
            return None
        # Sequential-numbering gate: markers must be roughly in
        # numerical order. Allow occasional gaps (Tier 3 found gaps too)
        # but reject if 2+ backwards jumps in the number sequence.
        backwards = 0
        for prev, curr in itertools.pairwise(markers):
            if curr[1] < prev[1]:
                backwards += 1
        if backwards >= 2:
            return None

        logger.info(
            "Tier 3.7 H6 body-marker detection: %d chapters from `###### **Chapter N**` body markers",
            len(markers),
        )
        for ch_line, ch_num, ch_title in markers[:10]:
            logger.debug("  Tier 3.7 chapter %d: %s (line %d)", ch_num, ch_title, ch_line)

        page_chapter_map: dict = {}
        for page_num, (_start_line, end_line) in sorted(page_line_offsets.items()):
            assigned_ch: tuple[int, str] = (0, "")
            for ch_line, ch_num, ch_title in markers:
                if ch_line <= end_line:
                    assigned_ch = (ch_num, ch_title)
                else:
                    break
            page_chapter_map[page_num] = assigned_ch

        if len(page_line_offsets) <= 1:
            page_chapter_map["_chapters"] = [(num, title) for _, num, title in markers]

        # Stash char-offset position fallback so the matcher can do
        # exact position-based assignment (titles are hoisted into
        # section_heading by the splitter and unavailable in
        # page_content for substring match).
        # Strip TOC-side leading punctuation — see `_clean_title` rationale
        # in `_detect_chapters_from_toc_section` (same patch family,
        # 2026-05-29 doc a38515fc).
        def _clean_title(_t: str) -> str:
            return re.sub(r"^[\s:\-]+", "", _t or "").strip()

        position_char_offsets: list[tuple[int, int, str]] = [
            (line_char_offsets[ch_line], ch_num, _clean_title(ch_title)) for ch_line, ch_num, ch_title in markers
        ]
        page_chapter_map["_chapters_position_fallback"] = {
            "char_offsets": position_char_offsets,
            "total_chars": total_chars,
            "lines": [(li, n, _clean_title(t)) for li, n, t in markers],
            "total_lines": len(full_lines),
        }

        return page_chapter_map

    @staticmethod
    def _detect_chapters_via_llm(content: str, max_chars: int = 12000) -> list[tuple[int, int, str]] | None:
        """
        Last-resort LLM fallback for chapter detection.

        Fires only when every regex tier (3, 3.5, 3.6, 3.7, 3.8, Patterns
        A-E) returned nothing. Covers the residual ~10% of corpus that has
        no usable markdown header structure — flat-prose academic
        monographs, bold-only EPUBs, body-marker-only sources.

        Uses the "system" model_provider row (typically "Scrapalot AI" →
        gpt-4o-mini) via a direct sync OpenAI client. Temperature 0 for
        determinism. Cost ~$0.02/call at 24K-char input; latency ~3-5s.

        Args:
            content: full document markdown text
            max_chars: cap input to avoid context overflow. Default 24K
                covers front (TOC region) + mid-document samples.

        Returns:
            List of (synthetic_line_no, chapter_num, title) tuples matching
            other Tier outputs, OR None on:
              - content < 5000 chars (too short to be a book)
              - system provider missing or no api_key
              - OpenAI client unavailable / network failure
              - LLM returns < 3 chapters (no structure to recover)
              - JSON parse failure
        """
        if not content or len(content) < 5000:
            return None

        try:
            import json as _json

            from openai import OpenAI

            from src.main.config.database import SessionLocal
            from src.main.models.sqlmodel_providers import ModelProvider
        except ImportError as e:
            logger.debug("LLM Tier 0 imports unavailable: %s", e)
            return None

        api_key: str | None = None
        try:
            db = SessionLocal()
            try:
                # noinspection PyTypeChecker
                provider = db.query(ModelProvider).filter(ModelProvider.provider_type == "system").first()
                if provider and provider.api_key:
                    api_key = provider.api_key
            finally:
                db.close()
        except Exception as e:
            logger.debug("LLM Tier 0 provider lookup failed: %s", e)
            return None

        if not api_key:
            logger.debug("LLM Tier 0 skipped — no system provider api_key configured")
            return None

        if len(content) <= max_chars:
            sample = content
            sample_descr = "full"
        else:
            front_len = (max_chars * 2) // 3
            mid_len = max_chars - front_len - 60
            front = content[:front_len]
            mid_start = len(content) // 2
            mid = content[mid_start : mid_start + mid_len]
            sample = front + "\n\n... [content truncated] ...\n\n" + mid
            sample_descr = f"truncated_{front_len}+{mid_len}_of_{len(content)}"

        system_prompt = (
            "You analyze book/document markdown structure. Identify chapter "
            "boundaries (typically 3-30 per book). Each title is the chapter's "
            "real name as it appears in the source — preserve original "
            "capitalization. Avoid sub-sections, figure captions, endnote "
            "citations, bibliography entries. If the document has no clear "
            "chapter structure, return an empty chapters list. "
            'Return JSON: {"chapters":[{"number":1,"title":"..."},{"number":2,"title":"..."}]}'
        )
        user_prompt = f"Markdown content ({sample_descr}):\n\n{sample}"

        try:
            client = OpenAI(api_key=api_key)
            response = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.0,
                response_format={"type": "json_object"},
                timeout=60.0,
            )
            raw_content = response.choices[0].message.content or ""
            data = _json.loads(raw_content)
        except Exception as e:
            logger.warning("LLM Tier 0 call failed: %s", e)
            return None

        raw_chapters = data.get("chapters") if isinstance(data, dict) else None
        if not isinstance(raw_chapters, list) or len(raw_chapters) < 3:
            logger.info(
                "LLM Tier 0 returned %s chapters — treating as 'no structure'",
                len(raw_chapters) if isinstance(raw_chapters, list) else "0",
            )
            return None

        out: list[tuple[int, int, str]] = []
        for n, c in enumerate(raw_chapters, start=1):
            if not isinstance(c, dict):
                continue
            title = str(c.get("title", "")).strip()
            if not title or len(title) > 150:
                continue
            line_hint = n * 100
            out.append((line_hint, n, title))

        if len(out) < 3:
            return None
        return out

    @staticmethod
    def _detect_chapters_from_h2_chapter_markers(
        full_lines: list[str],
        page_line_offsets: dict[int, tuple[int, int]],
    ) -> dict[int, tuple] | None:
        """
        Tier 3.8 — chapter NUMBER and TITLE on SEPARATE heading lines.

        Triggers on PDF→md exports whose chapter starts are a two-line H2/H3
        pair: a standalone ``## CHAPTER`` / ``## **CHAPTER IV**`` number heading
        immediately followed by a ``## TITLE`` heading. Designed for Routledge
        Library Editions alchemy facsimiles (Waite, The Secret Tradition in
        Alchemy) and the same shape in Mind into Matter.

        These books defeat Tier 3 (the ``Contents`` TOC entries are split across
        the two H2 lines, so ``Number Title`` never appears on one line) AND the
        line-by-line Pattern A-D scan (the body is saturated with page
        running-header H2s like ``## 8 ALCHEMY AND SUPERNATURAL LIFE`` that get
        wrongly read as chapter candidates). Anchoring strictly on the
        ``## CHAPTER <num>`` heading shape ignores the running-header noise.

        Strict gates (regression-scanned, see commit message):
          - >= 5 deduped ``## CHAPTER <num>`` markers
          - sequential numbering: distinct-number coverage >= 0.7 of the
            min..max range AND max consecutive gap <= 2
          - first chapter is 1 or 2 (real book start, not a mid-body false hit)
          - markers span >= 200 lines (rejects a TOC-only cluster with no body)

        Returns the same shape as ``_detect_chapters_from_toc_section`` (a
        page->(num,title) map with ``_chapters`` for the single-page case) or
        ``None`` when the gates fail — caller then runs Patterns A-D.
        """
        roman = {
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
            "xxi": 21,
            "xxii": 22,
            "xxiii": 23,
            "xxiv": 24,
            "xxv": 25,
            "xxvi": 26,
            "xxvii": 27,
            "xxviii": 28,
            "xxix": 29,
            "xxx": 30,
        }
        marker_re = re.compile(
            r"^#{2,3}\s+\*{0,2}\s*CHAPTER\s+\*{0,2}\s*([IVXLC]+|\d{1,3})\.?\s*\*{0,2}\s*$",
            re.IGNORECASE,
        )
        marker_bare = re.compile(r"^#{2,3}\s+\*{0,2}\s*CHAPTER\s*\*{0,2}\s*$", re.IGNORECASE)

        def _num(s: str) -> int:
            s = s.strip().lower().rstrip(".")
            return int(s) if s.isdigit() else roman.get(s, 0)

        raw: list[tuple[int, int, str]] = []
        for i, line in enumerate(full_lines):
            s = line.rstrip()
            n = None
            m = marker_re.match(s)
            if m:
                n = _num(m.group(1))
            elif marker_bare.match(s):
                n = 1  # standalone "## CHAPTER" with no numeral == Chapter 1
            if not n or not (1 <= n <= 50):
                continue
            # Title = next non-empty heading line that is NOT another CHAPTER
            # marker and NOT a page running-header (leading page number).
            title = f"Chapter {n}"
            for j in range(i + 1, min(i + 6, len(full_lines))):
                t = full_lines[j].rstrip()
                if not t.strip():
                    continue
                mt = re.match(r"^#{2,3}\s+(.+?)\s*$", t)
                if mt:
                    cand = re.sub(r"\*+", " ", mt.group(1))
                    cand = normalize_whitespace(cand)
                    if re.match(r"^CHAPTER\b", cand, re.IGNORECASE):
                        break
                    if re.match(r"^\d", cand):  # page running-header
                        break
                    if cand and len(cand) >= 4:
                        title = cand
                break
            raw.append((i, n, title))

        if len(raw) < 5:
            return None

        # Dedupe by chapter number (first/body-order occurrence wins).
        seen: set[int] = set()
        chapters: list[tuple[int, int, str]] = []
        for li, n, t in raw:
            if n in seen:
                continue
            seen.add(n)
            chapters.append((li, n, t))
        if len(chapters) < 5:
            return None

        snums = sorted(n for _, n, _ in chapters)
        rng = snums[-1] - snums[0] + 1
        coverage = len(snums) / rng if rng > 0 else 0
        max_gap = max((snums[k + 1] - snums[k] for k in range(len(snums) - 1)), default=1)
        marker_lines = [li for li, _, _ in chapters]
        spread = max(marker_lines) - min(marker_lines)
        if not (coverage >= 0.7 and max_gap <= 2 and spread >= 200 and snums[0] in (1, 2)):
            return None

        logger.info(
            "Tier 3.8 H2-CHAPTER-marker detection: %d chapters (coverage=%.2f max_gap=%d spread=%d)",
            len(chapters),
            coverage,
            max_gap,
            spread,
        )

        page_chapter_map: dict = {}
        for page_num, (_start, end_line) in sorted(page_line_offsets.items()):
            assigned: tuple[int, str] = (0, "")
            for ch_line, ch_num, ch_title in chapters:
                if ch_line <= end_line:
                    assigned = (ch_num, ch_title)
                else:
                    break
            page_chapter_map[page_num] = assigned
        if len(page_line_offsets) <= 1:
            page_chapter_map["_chapters"] = [(n, t) for _, n, t in chapters]
        return page_chapter_map

    @staticmethod
    def _detect_chapters_from_text(
        page_documents: list[LangchainDocument],
    ) -> dict[int, tuple]:
        """
        Detect chapter boundaries from Markdown text using regex (fallback for non-PDF or
        when font-based detection fails).

        Returns a page-to-chapter mapping: {page_number: (chapter_num, chapter_title)}
        """
        # Build full text from all pages
        full_lines = []
        page_line_offsets = {}  # page_number -> (start_line, end_line)
        for page_doc in page_documents:
            page_num = page_doc.metadata.get("page", 0)
            page_text = page_doc.page_content
            page_lines = page_text.split("\n")
            start_line = len(full_lines)
            full_lines.extend(page_lines)
            page_line_offsets[page_num] = (start_line, len(full_lines))

        # Tier 3 (preferred for markdown_imported docs): parse the chapter list out of
        # an explicit `#+ **Contents**` TOC SECTION rather than scanning the whole
        # document line-by-line. This avoids false positives from front-matter (italic
        # year/publisher lines like "II _New Fetter Lane, London_..."), figure captions
        # ("22. Micrograph of..."), and page running headers ("VIRUS INHIBITORS 145").
        # Returns a mapping immediately when it succeeds; otherwise we fall through
        # to the line-by-line Patterns A-D below.
        tier3 = DocumentProcessor._detect_chapters_from_toc_section(full_lines, page_line_offsets)
        if tier3 is not None:
            return tier3

        # Tier 3.7 (H6 numbered body markers): runs BEFORE Tier 3.5 /
        # 3.6 because its strict gates (≥3 markers, ≥50% real H3/H4
        # titles, position-spread, sequential numbering) make it
        # safer than Tier 3.5 / 3.6 — when it fires, the body markers
        # are authoritative and complete. Tier 3.5 on f4f05a98 only
        # picks up 5 entries from a TOC cluster while the body has 14
        # H6 markers covering every chapter; moving Tier 3.7 first
        # avoids that truncation. Full-corpus regression scan: only
        # f4f05a98 hits Tier 3.7 via this earlier slot (4 other
        # candidate docs are already resolved by Tier 3).
        tier37 = DocumentProcessor._detect_chapters_from_h6_body_markers(full_lines, page_line_offsets)
        if tier37 is not None:
            return tier37

        # Tier 3.5 (keyword-form TOC): triggers on books whose TOC has no
        # `## Contents` markdown anchor — chapters listed as bold
        # `**Chapter N** **Title**` runs (e.g. Godfrey 1994 Agrochemicals,
        # split across pre-/post-`**Contents**` zones). Strict gates: bold
        # wrapping required (body footnote `Chapter 5 below` is unbold),
        # ≥5 entries clustered within a 100-line window, sequential
        # numbering with gap ≤ 3.
        tier35 = DocumentProcessor._detect_chapters_from_keyword_toc(full_lines, page_line_offsets)
        if tier35 is not None:
            return tier35

        # Tier 3.6 (page-prefix bold-title TOC): triggers on books whose TOC
        # uses `<page-num> chapter <word-num> **Title**` format — Susan Lundy's
        # Heritage Apples (987a4d33) is the canonical case. Pattern A/B/C all
        # miss because the line starts with a page number; Tier 3 misses
        # because there's no `## Contents` markdown header (only plain-text
        # `contents`); Tier 3.5 misses because entries lack the leading
        # `**Chapter N**`. Without this tier the chunker grabs chapter labels
        # from the body Endnotes citation list and assigns chapter 10 as ch=1,
        # chapter 4 as ch=2, etc. Strict gates: ≥5 distinct sequential matches
        # in TOP 10 % of doc; case-insensitive keyword (chapter/chap./part/
        # book/section); roman/arabic/spelled-out word number; bold-wrapped
        # title. Regression scan against 217 production docs returned exactly
        # 1 hit (the target doc) — zero false positives.
        tier36 = DocumentProcessor._detect_chapters_from_page_prefix_toc(full_lines, page_line_offsets)
        if tier36 is not None:
            return tier36

        # Tier 3.8 (H2/H3 standalone CHAPTER-marker pairs): chapter number and
        # title on SEPARATE heading lines (`## CHAPTER IV` / `## TITLE`).
        # Routledge alchemy facsimiles (Waite Secret Tradition) and Mind into
        # Matter. Runs after the TOC tiers but BEFORE Pattern A-D so the
        # page-running-header H2 saturation in the body can't pollute detection.
        tier38 = DocumentProcessor._detect_chapters_from_h2_chapter_markers(full_lines, page_line_offsets)
        if tier38 is not None:
            return tier38

        roman_map = {
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
            # Spelled-out numbers
            "one": 1,
            "two": 2,
            "three": 3,
            "four": 4,
            "five": 5,
            "six": 6,
            "seven": 7,
            "eight": 8,
            "nine": 9,
            "ten": 10,
            "eleven": 11,
            "twelve": 12,
            "thirteen": 13,
            "fourteen": 14,
            "fifteen": 15,
            "sixteen": 16,
            "seventeen": 17,
            "eighteen": 18,
            "nineteen": 19,
            "twenty": 20,
        }
        chapters = []  # [(line_number, chapter_num, chapter_title), ...]
        # Pattern D candidates accumulate here regardless of how many fire.
        # We commit them into `chapters` only after the main loop, when
        # Patterns A/B/C produced nothing. Storing (line, raw_title, heading_level)
        # lets the post-pass drop the lone H1 ("book title") when ≥2 H2s exist.
        d_candidates: list[tuple[int, str, int]] = []

        # Pre-scan: alphabetical-encyclopedia detector. Documents like Gough's
        # "Encyclopedia of Small Fruit" or Key Concepts in Agriculture use
        # single-uppercase-letter H1s (`# **A**`, `# **B**`, ...) as their
        # primary chapter structure. Without this gate, the Pattern D
        # `too_short < 3` OCR-noise filter strips every clean letter heading
        # and only the corrupted ones (where body text bled into the heading
        # line) survive — collapsing 25 alphabetical sections into ~7 broken
        # slots.
        #
        # Three combined gates rule out false positives:
        #   (1) ≥6 distinct uppercase-letter H1s.
        #   (2) First letter H1 in the first 50 % of the doc.
        #   (3) Span of letter H1s covers ≥30 % of the doc.
        # Gates 2+3 distinguish a true alphabetical encyclopedia (letters
        # scattered throughout the book) from a back-of-book alphabetical
        # Index (letters clustered tightly in the last quartile, with prose
        # chapters before them at the same H1 level). Without those two,
        # Bittman 'Animal Vegetable Junk' (first=63 %) and similar
        # prose-then-Index books over-detect the Index letters as chapters.
        #
        # Gated to H1 ONLY. Earlier draft counted single letters at any
        # heading level and inflated d_candidates next to real H2 plant
        # chapter heads on docs like Groundcover Revolution. H2/H3+ Index
        # docs fall through to Pattern D's existing too_short filter, which
        # correctly rejects the back-of-book Index letters.
        single_letter_h1s: list[tuple[int, str]] = []
        seen_letters: set[str] = set()
        for _i, _line in enumerate(full_lines):
            _s = _line.strip()
            if not _s.startswith("#"):
                continue
            _m = re.match(r"^(#{1,6})\s+(.+?)\s*$", _s)
            if not _m:
                continue
            if len(_m.group(1)) != 1:
                continue
            _raw = re.sub(r"[*_]+", "", _m.group(2)).strip()
            if len(_raw) == 1 and _raw.isalpha() and _raw.isupper():
                single_letter_h1s.append((_i, _raw))
                seen_letters.add(_raw)

        is_alphabetical_encyclopedia = False
        if len(seen_letters) >= 6 and full_lines:
            _first_line = single_letter_h1s[0][0]
            _last_line = single_letter_h1s[-1][0]
            _doc_lines = max(len(full_lines), 1)
            _first_pct = _first_line / _doc_lines
            _span_pct = (_last_line - _first_line) / _doc_lines
            is_alphabetical_encyclopedia = _first_pct <= 0.50 and _span_pct >= 0.30

        # H2 alphabetical Index detector: identify line numbers of
        # single-uppercase-letter H2s clustered in the last 30 % of the
        # doc — these are back-of-book Index entries (`## A`, `## B`,
        # ..., `## Z`) that share the H2 level with real H2 plant /
        # chapter heads. Without filtering, Pattern D collects them as
        # `d_candidates` next to the real H2s and the post-loop
        # commit step over-counts chapters. Canonical case:
        # Groundcover Revolution (d97313ed) — 23 H2 Index letters
        # clustered in lines 84-99 % of the doc, mixed with ~30 H2
        # plant chapter heads earlier in the body.
        h2_index_lines: set[int] = set()
        h2_letters: list[tuple[int, str]] = []
        for _i, _line in enumerate(full_lines):
            _s = _line.strip()
            if not _s.startswith("##"):
                continue
            _m = re.match(r"^(#{2})\s+(.+?)\s*$", _s)
            if not _m:
                continue
            _raw = re.sub(r"[*_]+", "", _m.group(2)).strip()
            if len(_raw) == 1 and _raw.isalpha() and _raw.isupper():
                h2_letters.append((_i, _raw))

        if len({c[1] for c in h2_letters}) >= 6 and full_lines:
            _h2_first = h2_letters[0][0]
            _h2_last = h2_letters[-1][0]
            _doc_lines = max(len(full_lines), 1)
            _h2_first_pct = _h2_first / _doc_lines
            _h2_span_pct = (_h2_last - _h2_first) / _doc_lines
            # Index pattern: clustered in last quarter (first appearance
            # ≥70 %) AND tight cluster (span ≤30 %). Filter only when
            # BOTH hold so a true H2 alphabetical encyclopedia (would
            # never cluster at the back) is unaffected.
            if _h2_first_pct >= 0.70 and _h2_span_pct <= 0.30:
                h2_index_lines = {c[0] for c in h2_letters}
        auto_chapter_counter = 0
        i = 0
        while i < len(full_lines):
            stripped = full_lines[i].strip()

            # Pattern A: Split header — "## **Chapter N**" followed by "# **TITLE**"
            ch_match = re.match(
                rf"^#{{1,6}}\s*(?:\*\*)?(?:{CHAPTER_KEYWORDS})\s+(\d+|[IVXLC]+)(?:\*\*)?\s*$",
                stripped,
                re.IGNORECASE,
            )
            if ch_match:
                num_str = ch_match.group(1)
                num_lower = num_str.lower()
                chapter_num = roman_map.get(num_lower, int(num_str) if num_str.isdigit() else 0)
                title = ""
                # Look ahead for title header
                for lookahead in range(1, 4):
                    if i + lookahead >= len(full_lines):
                        break
                    next_line = full_lines[i + lookahead].strip()
                    if not next_line:
                        continue
                    title_match = re.match(r"^#{1,6}\s*(.+?)\s*$", next_line)
                    if title_match:
                        raw_title = re.sub(r"[*_]+", "", title_match.group(1)).strip()
                        if not re.match(rf"^(?:{CHAPTER_KEYWORDS})\s+", raw_title, re.IGNORECASE):
                            title = raw_title
                    break
                if title and title == title.upper():
                    from src.main.utils.text.formatting import smart_title_case

                    title = smart_title_case(title)
                if not title:
                    title = f"Chapter {chapter_num}"
                auto_chapter_counter = max(auto_chapter_counter, chapter_num)
                chapters.append((i, chapter_num, title))
                i += 1
                continue

            # Pattern B: Single header — "# Chapter N: TITLE"
            # Only match short lines (< 80 chars) to avoid false positives on content text
            if len(stripped) < 80:
                single_match = re.match(
                    rf"^#{{1,6}}\s*(?:{CHAPTER_KEYWORDS})\s+([IVXLC]+|\d+):?\s+(.+)",
                    stripped,
                    re.IGNORECASE,
                )
                if single_match:
                    num_str = single_match.group(1)
                    num_lower = num_str.lower()
                    chapter_num = roman_map.get(num_lower, int(num_str) if num_str.isdigit() else 0)
                    title = re.sub(r"[*_]+", "", single_match.group(2)).strip()
                    # End-of-chapter summary-marker reject. Some books have
                    # `# Chapter N Summary` headers AT THE END of each
                    # chapter (recap/wrap-up section) in addition to the
                    # real chapter start headers. Pattern B matches both
                    # but the summary headers have a title of just
                    # `Summary` / `Conclusion` / `Notes` / `Discussion`
                    # / `References` etc. — single-word end-markers. The
                    # real chapter headers carry a substantive title.
                    # Confirmed on 3c0f7733 (Complete Guide to Restoring
                    # Your Soil): 11 `# Chapter N Summary` lines all
                    # matched while real `# 01 Soil Salvation`,
                    # `# 02 ...` headers (numeric-prefix style) were
                    # ignored.
                    _end_markers = {
                        "summary",
                        "conclusion",
                        "conclusions",
                        "notes",
                        "discussion",
                        "references",
                        "review",
                        "exercises",
                        "questions",
                        "key points",
                        "key takeaways",
                        "recap",
                        "review questions",
                    }
                    if title and title.lower().strip() in _end_markers:
                        i += 1
                        continue
                    if title and title == title.upper():
                        from src.main.utils.text.formatting import smart_title_case

                        title = smart_title_case(title)
                    if not title:
                        title = f"Chapter {chapter_num}"
                    auto_chapter_counter = max(auto_chapter_counter, chapter_num)
                    chapters.append((i, chapter_num, title))
                    i += 1
                    continue

            # Pattern C: Plain-text "Part N" / "Chapter N" / "Book N" without markdown
            # Matches arabic (1), roman (IV), and spelled-out (one, two) numbers.
            # Length cap raised to 250 for lines with a clear dot-leader TOC
            # signature (≥3 consecutive dots, optionally separated by spaces).
            # Production source has TOC entries like "Chapter 1. Introduction
            # . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . 1"
            # which are >80 chars total but unambiguous TOC entries — under
            # the old 80-char cap, doc_proc skipped them, leaving the chunker
            # downstream content-matcher with too few signals. Confirmed on
            # e4e8b05b: only Chapter 3 (74 chars) was detected; chapters
            # 1, 2, 4, 5, 6 (all >80 chars) were missed.
            _has_dot_leader = bool(re.search(r"\.\s*\.\s*\.", stripped))
            _len_cap = 250 if _has_dot_leader else 80
            # Lowercase-only gate: body cross-references like
            # "Recall from chapter 6 that we have..." line-wrap (EPUB
            # extractor) into a standalone token `chapter 6` that matches
            # Pattern C below but is NOT a real heading. Genuine Pattern C
            # headings are Title Case or ALL CAPS. A fully-lowercase
            # matched line is body prose; skip it so Pattern D (markdown #
            # headings) gets to commit. Regression scan 2026-05-29
            # against 254 prior parse_done books: rejects 31 polluted hits
            # across 18 docs, costs 9 legit hits on 98f8db30 Berry
            # "Unsettling of America" whose TOC uses lowercase
            # `chapter one` + a Title-Case title-on-next-line — TOC-only
            # loss; body chapters still detected by Pattern D.
            if len(stripped) < _len_cap and not any(c.isupper() for c in stripped):
                i += 1
                continue
            if len(stripped) < _len_cap:
                plain_match = re.match(
                    rf"^(?:{ALL_CHAPTER_KEYWORDS})\s+([IVXLC]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten|"
                    r"eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)"
                    r"(?:\s*[.:]\s*(.+))?$",
                    stripped,
                    re.IGNORECASE,
                )
                if plain_match:
                    # Sub-section cross-reference guard. Body prose lines
                    # like "Chapter 1.5, timber harvesting is allowed..."
                    # (cross-ref in middle of sentence, line-wrapped to start
                    # with "Chapter 1.5") match Pattern C and produce
                    # chapter_title="5, timber harvesting...". Legit headings
                    # ("Chapter 1. Introduction") have a space after the period;
                    # cross-refs have a digit. Verified on e4e8b05b
                    # (Development of Forest Resources): 3 body cross-refs at
                    # lines 399/1353/2182 were promoted to chapters.
                    if re.match(rf"^(?:{ALL_CHAPTER_KEYWORDS})\s+\d+\.\d", stripped, re.IGNORECASE):
                        i += 1
                        continue
                    num_str = plain_match.group(1)
                    num_lower = num_str.lower()
                    chapter_num = roman_map.get(num_lower, int(num_str) if num_str.isdigit() else 0)
                    title = (plain_match.group(2) or "").strip()
                    # Mid-sentence cutoff reject. Pattern C matches plain
                    # text `Chapter N. <title>` AT LINE START — body
                    # paragraphs that start with `Chapter 3.` mid-flow
                    # (followed by an inline reference) will pass the
                    # regex but the captured title is the rest of the
                    # line, which often cuts mid-sentence ending in a
                    # preposition or conjunction. Confirmed on Early
                    # Medieval Agriculture (6b3e7878) body line 2786
                    # `Chapter 3. The present discussion will be confined
                    # to` — Pattern C captured this and propagated
                    # `chapter_title="The present discussion will be
                    # confined to"` to 631 of 672 chunks via the content
                    # matcher. Reject when the trailing word is a
                    # preposition / conjunction / article / common stop
                    # word — same set as the chunker-side guard.
                    _stop = {
                        "to",
                        "of",
                        "in",
                        "on",
                        "at",
                        "by",
                        "for",
                        "with",
                        "as",
                        "or",
                        "and",
                        "but",
                        "the",
                        "a",
                        "an",
                        "is",
                        "are",
                        "was",
                        "were",
                        "be",
                        "been",
                        "has",
                        "have",
                        "had",
                        "that",
                        "this",
                        "which",
                        "who",
                        "whom",
                        "from",
                        "into",
                        "onto",
                        "than",
                        "then",
                    }
                    if title:
                        _stripped_title = title.strip().rstrip(".,;:!?")
                        _words = _stripped_title.split()
                        if _words and _words[-1].lower() in _stop and len(_stripped_title) >= 4:
                            i += 1
                            continue
                    if not title:
                        # Look ahead for title on next non-empty line
                        for lookahead in range(1, 3):
                            if i + lookahead < len(full_lines):
                                next_line = full_lines[i + lookahead].strip()
                                if next_line and len(next_line) < 80 and not next_line[0].isdigit():
                                    # Reject repeated-character decorative lines emitted
                                    # by PDF→md extractors for stylized cover-art glyphs
                                    # (e.g. `aaaaaaaaaaaaaa` in Fine Gardening Grow
                                    # e43d1159 — 463 such lines polluted Pattern C's
                                    # lookahead and stamped chapter_title='aaaaaaaaaaaaaa'
                                    # on 2 chunks plus a polluted document_hierarchy node).
                                    # Real chapter titles never repeat a single character
                                    # 5+ times in a row.
                                    if re.fullmatch(r"(.)\1{4,}", next_line):
                                        continue
                                    # Strip leading markdown header markers (#) and
                                    # emphasis (* _) so a `PART I` line followed by
                                    # `##### Evaluation` doesn't pull `#####` into
                                    # chapter_title.
                                    _candidate = re.sub(r"^[#*_\s]+", "", next_line).strip()
                                    # Heading-shape gate: real chapter titles do
                                    # not end on a preposition / article /
                                    # conjunction. Body cross-references like
                                    # `Recall from chapter 6\n\nthat we have the
                                    # vertical "spiritual" axis of fire and
                                    # water (` are line-wrapped by the EPUB
                                    # extractor, so the lookahead pulls prose
                                    # fragments instead of titles. Verified on
                                    # f447436b Inner Alchemy 2026-05-29: 5
                                    # polluted chapter_titles ("The ancient
                                    # Taoists spoke of the concept of the" ×42,
                                    # "of this book. It is extremely important
                                    # to understand" ×3, "value" ×6) survived
                                    # the Cat-E lowercase reject (commit
                                    # e5bcc50) because they begin with an
                                    # uppercase letter. Drop them via the same
                                    # stop-word set used by the inline-title
                                    # branch above.
                                    _stripped_candidate = _candidate.rstrip(".,;:!?")
                                    _cand_words = _stripped_candidate.split()
                                    # Reject lookahead title when it looks
                                    # like a body-prose fragment: starts
                                    # with a lowercase character (mid-
                                    # sentence) OR ends with a stop word
                                    # (preposition / article / conjunction).
                                    # Either signal is enough — real chapter
                                    # titles start Title Case and end on a
                                    # noun phrase.
                                    if _candidate and _candidate[0].islower():
                                        continue
                                    if _cand_words and _cand_words[-1].lower() in _stop and len(_stripped_candidate) >= 4:
                                        continue
                                    # Cat-E v2 (cumulative-evidence #2 of
                                    # `pattern_c_titlecase_body_fragments_via_lookahead`,
                                    # signals: f447436b Inner Alchemy
                                    # + e2c9ce11 Roger Bacon). The earlier
                                    # gate caught lowercase first-char and
                                    # stop-word trailing fragments. Two
                                    # more signals leak through on academic
                                    # / monograph bodies whose prose starts
                                    # Title Case and ends on a noun:
                                    #   a) Word count cap: chapter titles
                                    #      rarely exceed 10 words ("Powerful
                                    #      Transformation: The Alchemy of
                                    #      the Secret Heart Essence" is 9).
                                    #      Body fragments like "In the same
                                    #      category is Od, which contains
                                    #      only the first eight chapters"
                                    #      (13 words) get caught here.
                                    #   b) Mid-clause comma followed by
                                    #      lowercase signals a subordinate
                                    #      clause inside a sentence ("…X,
                                    #      which Y"). Real titles use a
                                    #      colon for subtitle separation,
                                    #      not a comma-into-lowercase.
                                    if len(_cand_words) > 10:
                                        continue
                                    if re.search(r",\s+[a-z]", _candidate):
                                        continue
                                    title = _candidate
                                    break
                    if title and title == title.upper():
                        from src.main.utils.text.formatting import smart_title_case

                        title = smart_title_case(title)
                    if not title:
                        title = f"Chapter {chapter_num}"
                    auto_chapter_counter = max(auto_chapter_counter, chapter_num)
                    chapters.append((i, chapter_num, title))
                    i += 1
                    continue

            # Pattern D: Top-level Markdown headings (# or ##). We collect
            # ALL matches into d_candidates here (no `if not chapters` gate)
            # so a doc with `# Book Title` followed by `## Ch1`, `## Ch2`,
            # `## Ch3` keeps every heading as a candidate. The previous
            # gating only kept the FIRST H1/H2 in the entire pass —
            # collapsing books like Storey's "Starting Right with Bees"
            # (1 H1 + 9 H2) into a single chapter named after the book.
            # The post-loop step at the end picks d_candidates only when
            # A/B/C produced nothing, then drops the lone H1 if multiple
            # H2s exist (since the H1 is then the book title, not a chapter).
            if len(stripped) < 80:
                # Regex covers H1-H6. The post-loop commit step keeps only
                # H1/H2 when present; H3-H6 candidates serve as a structured
                # fallback for documents whose true chapter structure sits
                # at deeper levels (e.g. OECD reports use H5 for Parts).
                h1_match = re.match(r"^(#{1,6})\s+(.+?)\s*$", stripped)
                if h1_match:
                    heading_level = len(h1_match.group(1))
                    raw_title = re.sub(r"[*_]+", "", h1_match.group(2)).strip()
                    # Reject OCR-spaced single-letter artefacts ("C o n t e n t s",
                    # "T i t l e P a g e") that some markdown extractors emit when
                    # the source PDF used letter-spaced headings. Without this,
                    # such lines pollute the position-fallback table near line 0
                    # and shadow the real chapter 1 in the dedup-by-number step.
                    is_spaced_letters = bool(re.fullmatch(r"[A-Za-z](?:\s+[A-Za-z]){2,}", raw_title))
                    # Skip generic headings (after collapsing the OCR spacing so
                    # "C o n t e n t s" → "contents" gets caught by the same list).
                    collapsed_lower = re.sub(r"([A-Za-z])\s+(?=[A-Za-z]\b)", r"\1", raw_title.lower()).strip()
                    # Reject too-short titles like "AT", "I", "II" that are almost always
                    # microfiche/OCR header artefacts (e.g. `# AT` from a "MICROFICHE / AT
                    # A project of …" preamble) rather than real chapter headings.
                    too_short = len(re.sub(r"\s+", "", raw_title)) < 3
                    # Relax the too-short gate for alphabetical encyclopedias:
                    # a single uppercase A-Z H1 in a doc with ≥6 such headings
                    # is a legitimate section, not OCR noise. Gated to H1 only
                    # to avoid the d97313ed regression where H2 Index entries
                    # mixed with H2 plant chapter heads.
                    if (
                        too_short
                        and is_alphabetical_encyclopedia
                        and heading_level == 1
                        and len(raw_title) == 1
                        and raw_title.isalpha()
                        and raw_title.isupper()
                    ):
                        too_short = False
                    # Reject titles starting with a lowercase letter — real chapter
                    # headings are always title-cased or ALL-CAPS. A leading lowercase
                    # letter on an H1/H2 is almost always an OCR truncation artefact
                    # (e.g. `## ekeeper's Handbook` from microfiche where "Be" was
                    # cut off the front of "Beekeeper's Handbook"). Without this
                    # filter, the truncated header beats the real ALL-CAPS body
                    # heads at chapter detection.
                    starts_lowercase = bool(raw_title) and raw_title[0].islower()
                    if (
                        not is_spaced_letters
                        and not too_short
                        and not starts_lowercase
                        and raw_title.lower()
                        not in {
                            "introduction",
                            "preface",
                            "foreword",
                            "contents",
                            "table of contents",
                            "acknowledgments",
                            "bibliography",
                            "references",
                            "index",
                            "appendix",
                            "notes",
                        }
                        and collapsed_lower
                        not in {
                            "contents",
                            "tableofcontents",
                            "preface",
                            "foreword",
                            "introduction",
                            "acknowledgments",
                            "bibliography",
                            "references",
                            "index",
                            "appendix",
                            "notes",
                        }
                    ):
                        if raw_title == raw_title.upper():
                            from src.main.utils.text.formatting import smart_title_case

                            raw_title = smart_title_case(raw_title)
                        # H2 Index filter: skip H2 lines that the
                        # back-of-book alphabetical-Index detector
                        # flagged. Without this skip, the 23 H2 Index
                        # letters in Groundcover Revolution (d97313ed)
                        # joined the d_candidates pool with the real H2
                        # plant chapter heads and the post-loop commit
                        # misrouted chunk assignment 24 → 8 chapters.
                        if heading_level == 2 and i in h2_index_lines:
                            i += 1
                            continue
                        d_candidates.append((i, raw_title, heading_level))

            i += 1

        # Pattern D commit: only when A/B/C found nothing. If exactly one
        # H1 + ≥2 H2s, drop the H1 — it's the book title, not a chapter.
        # If multiple H1s OR only-H1, keep them all.
        # When H1/H2 are absent entirely, fall back to the shallowest
        # H3-H6 level that has ≥3 candidates — covers documents whose
        # true chapter structure lives at H5 (e.g. OECD reports).
        if not chapters and d_candidates:
            h1s = [c for c in d_candidates if c[2] == 1]
            h2s = [c for c in d_candidates if c[2] == 2]
            shallow = h1s + h2s
            # Pick the shallowest deeper level (H3-H6) that has ≥3 candidates,
            # so a book whose true chapter structure sits at H5 (e.g. OECD
            # reports) doesn't collapse to the lone H2 book-title heading.
            deep_choice: list[tuple[int, str, int]] = []
            for level in (3, 4, 5, 6):
                same_level = [c for c in d_candidates if c[2] == level]
                if len(same_level) >= 3:
                    deep_choice = same_level
                    break
            if len(h1s) == 1 and len(h2s) >= 2:
                d_candidates = h2s
            elif deep_choice and len(deep_choice) >= max(3, (5 * len(shallow) + 1) // 2):
                # Deep level dominates shallow ≥ 2.5:1 — shallow is a cover/title
                # block dup (e.g. CRC/Wiley/Nova layouts repeat the book title
                # across cover + inside cover, then stamp real chapters as
                # H5). Threshold 2.5× keeps OCR-noisy books like Clauss Bee
                # Keeping Handbook (h5=11, shallow=5, ratio 2.2) on their
                # existing Pattern E path while firing on cleanly-laid-out
                # Wiley/CRC books (Wastes h5=10/shallow=4, ratio 2.5).
                d_candidates = deep_choice
            elif shallow:
                d_candidates = shallow
            else:
                d_candidates = deep_choice
            for n, (line_num, title, _level) in enumerate(d_candidates, start=1):
                chapters.append((line_num, n, title))
            logger.info(
                "Pattern D fallback: %d chapter(s) from H1-H6 markdown headings",
                len(chapters),
            )

        # Pattern E (Tier 4 fallback): ALL-CAPS body lines as chapter heads.
        # Strictly better than returning {} for OCR'd / microfiche markdown
        # that uses ALL-CAPS headings instead of `#` / "Chapter N" markers
        # (e.g. Beekeeper's Handbook, microfiched typewritten manuals).
        # Heuristics keep false positives down: 8-50 chars, ≥3 alpha letters,
        # ≥2 words, no half-OCR-spaced letters, dense caption clusters
        # rejected, and the document must contain ≥5 such distinct lines so
        # we don't mistake a single decorative caption for a chapter.
        #
        # Pattern E fires (Tier 3.8 gate relaxation 2026-05-14) under any of:
        #   (1) ≤2 chapters detected (canonical case — Beekeeper's Handbook
        #       1982: Pattern D matched only a typo'd `## Bee Kbeping Handbook`
        #       book-title repeat).
        #   (2) `dominant_garbage`: >50% of Pattern A-D chapters look like
        #       junk (figure captions matched as headings, code-fence chars,
        #       <3 alpha chars). Example: 60074d20 "The Emergence of
        #       Agriculture" — 12 chapters, 11 are `Page 182: (background
        #       photo of com) Art`-style or ``` ``` code fences.
        #   (3) `has_garbage AND weak_coverage`: any garbage chapter AND all
        #       Pattern A-D chapter lines clustered in first 25% of doc
        #       (TOC-region capture). Example: ca53083a (1985 Sumerian
        #       Agriculture Bulletin) — Pattern D matched a stray `# 5` plus
        #       2 front-matter heads, all at line <500 of 12000, while
        #       the body has 12+ legitimate ALL-CAPS article heads
        #       (SIEVING OF SEED GRAIN, PULSES RECORDED FROM ANCIENT IRAQ).
        def _is_likely_garbage_chapter(t: str) -> bool:
            s = t.strip()
            if not s:
                return True
            alpha = sum(1 for c in s if c.isalpha())
            if alpha < 3:
                return True
            # Figure / table caption that Pattern D matched as a heading.
            if re.match(r"^(Page|Plate|Figure|Fig\.|Table|Tab\.)\s+\d", s, re.IGNORECASE):
                return True
            # Decorative / fence chars only (`, *, _, -, =, ~, +, #).
            return bool(re.match(r"^[`*_\-=~+#]+$", s))

        # Sequence guard: when chapter titles form an A-Z alphabet or 1-N
        # numeric sequence, they are LEGITIMATE structural markers (dictionary
        # / encyclopedia / numbered-only chapters), not garbage. Don't fire
        # the override even if every title scores as "degenerate" by alpha
        # count. Example: 6f6c0f6d (Encyclopedia of small fruit) has 24
        # single-letter chapters A-Z; 61a4ad70 (Key Concepts in Agriculture)
        # same pattern; e56b1cd1 (Cultivation for Climate Change Vol 2) has
        # chapters labeled "1" through "6" from numbered TOC.
        def _is_legitimate_sequence(chapter_titles: list[str]) -> bool:
            if len(chapter_titles) < 5:
                return False
            single_letters = [t.strip().upper() for t in chapter_titles if len(t.strip()) == 1 and t.strip().isalpha()]
            if len(single_letters) >= len(chapter_titles) * 0.5 and len(set(single_letters)) >= 5:
                return True
            short_nums = [t.strip() for t in chapter_titles if t.strip().isdigit() and 1 <= len(t.strip()) <= 3]
            return bool(len(short_nums) >= len(chapter_titles) * 0.5 and len(set(short_nums)) >= 5)

        has_garbage = any(_is_likely_garbage_chapter(t) for _, _, t in chapters)
        dominant_garbage = bool(
            chapters
            and sum(1 for _, _, t in chapters if _is_likely_garbage_chapter(t)) >= max(1, len(chapters) // 2)
            and sum(1 for _, _, t in chapters if _is_likely_garbage_chapter(t)) / len(chapters) > 0.5
        )
        weak_coverage = bool(chapters and len(chapters) <= 5 and full_lines and max(line for line, _, _ in chapters) < 0.25 * len(full_lines))
        is_sequence = _is_legitimate_sequence([t for _, _, t in chapters])
        pattern_e_eligible = (not is_sequence) and (len(chapters) <= 2 or dominant_garbage or (has_garbage and weak_coverage))

        e_candidates: list[tuple[int, str]] = []
        if pattern_e_eligible:
            allcaps_pattern = re.compile(r"^[A-Z][A-Z\s]{7,49}$")
            seen_caps: set[str] = set()
            for idx, line in enumerate(full_lines):
                s = line.strip()
                if not allcaps_pattern.match(s):
                    continue
                # Need ≥3 alpha letters and ≥2 whitespace-separated words.
                alpha_count = sum(1 for c in s if c.isalpha())
                tokens = s.split()
                if alpha_count < 3 or len(tokens) < 2:
                    continue
                # Reject OCR-spaced ALL-CAPS lines where the OCR engine
                # inserted a space after the first capital (e.g.
                # "F IXED V ALUATIONS" instead of "FIXED VALUATIONS").
                # Pattern D already rejects pure spaced-letter sequences
                # ("C O N T E N T S"); this catches the half-spaced variant.
                single_letter_count = sum(1 for w in tokens if len(w) == 1 and w.isalpha())
                multi_letter_count = sum(1 for w in tokens if len(w) >= 2 and w.isalpha())
                if single_letter_count >= 2 and multi_letter_count >= 1:
                    continue
                # Skip verbatim duplicates (repeated running headers).
                if s in seen_caps:
                    continue
                seen_caps.add(s)
                e_candidates.append((idx, s))

            # Reject candidates that fall inside a dense cluster: 3 or more
            # candidates within a 30-line window are almost always figure
            # captions stacked under an illustration. Real chapter heads
            # are sparsely distributed (hundreds of lines apart).
            sparse_candidates: list[tuple[int, str]] = []
            for i, (idx, s) in enumerate(e_candidates):
                nearby = sum(1 for j, (idx2, _) in enumerate(e_candidates) if i != j and abs(idx - idx2) < 30)
                if nearby <= 1:
                    sparse_candidates.append((idx, s))
            e_candidates = sparse_candidates

        if e_candidates and len(e_candidates) >= 5 and pattern_e_eligible:
            # Override the weak Pattern A-D output (likely book-title
            # repeats from OCR-mangled headers, figure-caption junk, or
            # all-TOC-cluster captures) with Pattern E's body ALL-CAPS
            # scan. Discard any prior chapters before reseeding.
            from src.main.utils.text.formatting import smart_title_case

            prior_count = len(chapters)
            chapters = []
            for n, (idx, s) in enumerate(e_candidates, start=1):
                title = smart_title_case(s)
                chapters.append((idx, n, title))
            logger.info(
                "Pattern E override (Tier 3.8): replaced %d weak Pattern A-D chapters with %d ALL-CAPS body heads (dominant_garbage=%s, weak_coverage=%s)",
                prior_count,
                len(chapters),
                dominant_garbage,
                weak_coverage,
            )

        if not chapters:
            # Last-resort LLM fallback ("Tier 0" of last resort). Fires only
            # when every regex tier (3 / 3.5 / 3.6 / 3.7 / 3.8 / Patterns
            # A-E) produced nothing. Common for flat-prose academic
            # monographs (28a8daca Fundamental and Applied Scientific
            # Research) and bold-only EPUBs (f7f783e5 No-Dig Gardening)
            # that lack markdown header structure entirely. Uses the
            # system provider (gpt-4o-mini) — see _detect_chapters_via_llm
            # for cost/latency notes.
            full_text = "\n".join(full_lines)
            llm_chapters = DocumentProcessor._detect_chapters_via_llm(full_text)
            if llm_chapters:
                chapters = llm_chapters
                logger.info(
                    "LLM fallback detected %d chapters (all regex tiers returned nothing)",
                    len(chapters),
                )
            else:
                return {}

        # TOC dot-leader trailing-page-number strip. The chapter detection
        # regexes in Patterns A-D capture the full source line tail as the
        # chapter title (e.g. `## Chapter 3 - Increment of the growing stock
        # volume . . . . . . . . . . . . 35`). The trailing page number
        # survives into chunk metadata. Strip the trailing 2-4 digit page
        # number when one of two signatures matches:
        #   (1) explicit dot-leader run (`. . . . .`) before the digits —
        #       unambiguous TOC tell;
        #   (2) generic heuristic: long title (≥20 chars) with no
        #       year-context word (since, in, fragment, chapter, volume,
        #       etc.) before the digits, and the digits are NOT a year
        #       (1000-2099).
        # Mirrors the chunker-side guard (chunking_enhanced_markdown.py
        # _extract_hierarchy_metadata H1/H2 path + Pattern 1 body-regex).
        def _strip_toc_page(_t: str) -> str:
            _m = re.search(r"^(.+?)\s+(\d{1,4})\s*$", _t)
            if not _m:
                return _t
            _pre = re.sub(r"[\s.\-—]+$", "", _m.group(1)).strip()
            _pre = re.sub(r"^[\s.\-—]+", "", _pre).strip()
            _num_val = int(_m.group(2))
            _num_len = len(_m.group(2))
            _dot_leader = bool(re.search(r"\.\s*\.\s*\.", _m.group(1)))
            _pre_last = re.findall(r"[A-Za-z]+|\d+", _pre)
            _pre_last_word = _pre_last[-1].lower() if _pre_last else ""
            _allowed = {
                "since",
                "in",
                "from",
                "of",
                "to",
                "before",
                "after",
                "circa",
                "ca",
                "around",
                "through",
                "hasta",
                "hacia",
                "fragment",
                "fragments",
                "verse",
                "verses",
                "chapter",
                "section",
                "part",
                "volume",
                "vol",
                "edition",
                "ed",
                "no",
                "number",
                "page",
                "los",
                "las",
                "the",
                "year",
            }
            _is_year = _num_len == 4 and 1000 <= _num_val <= 2099
            # Dot-leader allows 1-digit page numbers (TOC entries can be page 1-9);
            # generic heuristic requires 2-digit minimum to reduce false positives
            # (e.g. "Top 5 Tips" — short title with single-digit number is rarely a page).
            # Section-heading words that natively take a single-digit numeric
            # marker as a TOC page number: "Introduction 1", "Conclusion 4",
            # "Bibliography 197". The generic heuristic below requires
            # `_num_len >= 2` so 1-digit page numbers slip through; this
            # narrow whitelist catches them when the preceding word is
            # unambiguously a section heading. Canonical case: ac7bd9ae
            # (Lithic Production System) "Introduction 1".
            _section_heading_words = {
                "introduction",
                "conclusion",
                "conclusions",
                "preface",
                "foreword",
                "afterword",
                "bibliography",
                "index",
                "notes",
                "appendix",
                "glossary",
                "references",
                "summary",
                "abstract",
                "prologue",
                "epilogue",
            }
            if (
                (_dot_leader and len(_pre) >= 10 and 1 <= _num_len <= 4)
                or (len(_pre) >= 12 and not _is_year and _pre_last_word not in _allowed and 2 <= _num_len <= 4)
                or (_num_len == 1 and _pre_last_word in _section_heading_words and len(_pre) >= 8)
            ):
                return _pre
            return _t

        chapters = [(line, num, _strip_toc_page(title)) for line, num, title in chapters]

        # TOC-clustered chapter detection + body-marker rescan.
        # When Patterns A-D capture chapter entries from a TOC region
        # (e.g. PDF→markdown TOC with `Chapter 1. Title . . . PAGE` lines
        # at the front of the doc), the captured line numbers cluster
        # in a 1-5% band at the start of the doc. Tier 3 deliberately
        # skips _chapters_position_fallback because its line numbers are
        # TOC-side; the Patterns A-D path needs the same protection.
        #
        # Without intervention, _assign_cross_page_chapter_metadata's
        # position fallback maps every body chunk past the TOC band to
        # the LAST chapter in the list (highest line number ≤ chunk's
        # estimated body line), collapsing the entire book to chapter N.
        # Observed on e4e8b05b (Forest Resources Russia): 6 TOC chapters
        # at lines 122-171 (1.2% spread) → 94/99 body chunks all mapped
        # to "Chapter 6: Observations and conclusions".
        #
        # When clustering is detected, scan the post-TOC body for
        # `^#{1,6}\s+\*?\*?N\s+Title\*?\*?` markers matching each TOC
        # chapter's number. When at least half align, REPLACE chapter
        # line numbers with body marker positions. When alignment
        # fails, drop position_fallback entirely — better the content
        # matcher than a wrong position estimate.
        toc_clustered_rescanned = False
        # Outer gate lowered 2026-05-14 from `>= 3` to `>= 2`. Pennsylvania
        # Farming (fd4004e9) had only 2 chapters detected by Pattern A-D,
        # both clustered at lines 30 & 78 (TOC region). Without rescan,
        # position fallback locked 99% of chunks on the last-detected
        # chapter. With `>= 2` the rescan fires; body markers absent ->
        # "no_body_markers" path suppresses position fallback. The
        # span < 10% AND first < 20% gates are sufficient guards against
        # misclassifying 2 legitimate body chapters as TOC-clustered.
        if chapters and len(chapters) >= 2 and full_lines:
            _first_line = chapters[0][0]
            _last_line = chapters[-1][0]
            _span = _last_line - _first_line
            _n = len(full_lines)
            _toc_clustered = (_span < 0.10 * _n) and (_first_line < 0.20 * _n)
            if _toc_clustered:
                _body_start = _last_line + 5
                # Match body chapter markers in four shapes:
                #   1. `# Chapter N` / `## Chapter 1: Title` — keyword-prefixed
                #   2. `### **N Title**` — number-prefixed bold body marker (single line)
                #   3. `# **N. Title**` — numbered with dot separator (single line)
                #   4. `# **N**` or `# **Chapter N**` ALONE then title on next line
                #      (split marker — fc1780eb, 1d56e6b3, 5a6b085c style)
                # `_?\s*` after the bold marker allows italic-wrapped
                # `## _Chapter 3_ Title` headers (Pennsylvania Farming
                # fd4004e9 used this style — without the underscore tolerance
                # the body marker scan returned 0 hits, defaulting to
                # "no_body_markers" path).
                _marker_keyword_re = re.compile(
                    r"^(#{1,6})\s+[\*_]*\s*(?:Chapter|Chap\.?)\s+(\d{1,3}|[IVXLC]+)\b",
                    re.IGNORECASE,
                )
                _marker_numeric_re = re.compile(r"^(#{1,6})\s+[\*_]*\s*(\d{1,3})[\.\s]+[\*_]*\s*(.+?)[\*_]*\s*$")
                # Split marker patterns: header containing ONLY a number or
                # `Chapter N`, with the title on a subsequent header line.
                _split_num_alone_re = re.compile(r"^(#{1,6})\s+[\*_]*\s*(\d{1,3})\s*[\*_]*\s*$")
                _split_chap_alone_re = re.compile(
                    r"^(#{1,6})\s+[\*_]*\s*(?:Chapter|Chap\.?)\s+(\d{1,3}|[IVXLC]+)\s*[\*_]*\s*$",
                    re.IGNORECASE,
                )
                _roman_lookup = {
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
                # Map: chapter_number → list of (body_line, body_title)
                _body_map: dict = {}

                def _record(_num: int, _line_idx: int, _title: str) -> None:
                    if 1 <= _num <= 200:
                        _body_map.setdefault(_num, []).append((_line_idx, _title))

                for _i in range(_body_start, len(full_lines)):
                    _line_text = full_lines[_i]
                    _mk = _marker_keyword_re.match(_line_text)
                    if _mk:
                        # Skip H5/H6 deep headers — usually sub-sections
                        if len(_mk.group(1)) > 4:
                            continue
                        _num_str = _mk.group(2).lower()
                        _bnum = int(_num_str) if _num_str.isdigit() else _roman_lookup.get(_num_str, 0)
                        _record(_bnum, _i, "")
                        continue
                    _msc = _split_chap_alone_re.match(_line_text)
                    if _msc:
                        if len(_msc.group(1)) > 6:
                            continue
                        _num_str = _msc.group(2).lower()
                        _bnum = int(_num_str) if _num_str.isdigit() else _roman_lookup.get(_num_str, 0)
                        _record(_bnum, _i, "")
                        continue
                    _msn = _split_num_alone_re.match(_line_text)
                    if _msn:
                        # Number-alone markers fire on ANY header level —
                        # `# 1`, `#### 9`, etc. seen across corpus.
                        _num_str = _msn.group(2)
                        if not _num_str.isdigit():
                            continue
                        _bnum = int(_num_str)
                        # Sanity: number-alone markers in body must be
                        # spaced apart (otherwise they're step / equation
                        # numbers). Skip if there's already a recorded body
                        # marker for ANY chapter within the last 50 lines.
                        _recent_match = any(any(abs(_existing_line - _i) < 50 for _existing_line, _ in _v) for _v in _body_map.values())
                        if _recent_match:
                            continue
                        _record(_bnum, _i, "")
                        continue
                    _mn = _marker_numeric_re.match(_line_text)
                    if not _mn:
                        continue
                    _num_str = _mn.group(2)
                    if not _num_str.isdigit():
                        continue
                    _bnum = int(_num_str)
                    if len(_mn.group(1)) > 4:
                        continue
                    _record(_bnum, _i, _mn.group(3).strip())

                rescanned: list[tuple[int, int, str]] = []
                hits = 0
                for _line, _num, _title in chapters:
                    if _num in _body_map:
                        _b_line, _b_title = _body_map[_num][0]
                        rescanned.append((_b_line, _num, _title))
                        hits += 1
                    else:
                        rescanned.append((_line, _num, _title))
                if hits >= len(chapters) // 2 and hits >= 3:
                    logger.info(
                        "TOC-cluster body rescan: %d/%d chapters re-anchored to body markers (was TOC-cluster span %.1f%% of doc)",
                        hits,
                        len(chapters),
                        100.0 * _span / max(_n, 1),
                    )
                    chapters = rescanned
                    toc_clustered_rescanned = True
                else:
                    # TOC-clustered but body markers not found — discard
                    # position fallback to prevent the locks-to-last-chapter
                    # behaviour. _chapters list still populated for the
                    # content matcher to walk; chunker falls back to
                    # title-substring matching only.
                    logger.info(
                        "TOC-cluster detected (span %.1f%%) but body markers absent (%d/%d hits) — suppressing position fallback",
                        100.0 * _span / max(_n, 1),
                        hits,
                        len(chapters),
                    )
                    toc_clustered_rescanned = "no_body_markers"

        # Build page-to-chapter mapping
        page_chapter_map = {}
        for page_num, (_start_line, end_line) in sorted(page_line_offsets.items()):
            assigned_ch = (0, "")
            for ch_line, ch_num, ch_title in chapters:
                if ch_line <= end_line:
                    assigned_ch = (ch_num, ch_title)
                else:
                    break
            page_chapter_map[page_num] = assigned_ch

        # Single-page input (e.g. markdown_imported docs ingested as ONE
        # synthetic LangchainDocument) would otherwise collapse to "last
        # chapter wins" via the per-page loop above, losing all but one of
        # the detected chapters. Stash the full chapter list so the
        # content-based matcher in _assign_cross_page_chapter_metadata can
        # walk it. Mirrors what the font-based path already does on no-real-
        # pages docs.
        #
        # ALSO stash a position-fallback map: Patterns A-D detect chapters at
        # their BODY line numbers (e.g. `# chapter 1 ...` at line 64 IS the
        # body chapter start). The content-matcher can use these line numbers
        # to assign chunks whose body text doesn't repeat the chapter title
        # verbatim — common in EPUB-style markdown where a single TOC chunk
        # mentions all chapters and body chunks have only sub-section headers.
        # Tier 3 (TOC-section) deliberately does NOT stash this fallback because
        # its line numbers are TOC-side (not body-side) and would mislead the
        # position estimator.
        if len(page_line_offsets) <= 1:
            page_chapter_map["_chapters"] = [(num, title) for _, num, title in chapters]
            # Only stash position fallback when chapter line numbers are
            # body-side. TOC-clustered chapters without successful body
            # rescan (toc_clustered_rescanned == "no_body_markers") get
            # NO position fallback to prevent map-to-last-chapter bug.
            if toc_clustered_rescanned != "no_body_markers":
                # TOC+body deduplication (added 2026-05-29). Pattern A-D
                # often captures the SAME chapter number twice: once at
                # the TOC entry line near the top of the doc (e.g. line
                # 36 `Chapter 4: Title` in the TOC table) and once at
                # the real body chapter start (e.g. line 3221 `# Chapter
                # 4: Title` at the start of the chapter body). When BOTH
                # are present in `position_lines_sorted`, the content
                # matcher's position fallback maps front-matter chunks
                # (estimated line ~78 for chunk_idx=1) to the LAST TOC
                # line that's still ≤ estimated_line — which is the
                # final TOC entry, i.e. the HIGHEST chapter number.
                # Effect: Forward / Introduction / Guide chunks are
                # stamped with the LAST chapter's title.
                #
                # Fix: when a chapter has at least one entry in the TOC
                # region (TOP 5%) AND at least one entry in the body
                # region (≥15%), drop the TOC entry from
                # _chapters_position_fallback. The TOC line was a
                # double-detection of the same body chapter, not a
                # second body occurrence. Strict gates: requires ≥3
                # chapters meeting the dual-region pattern AND total
                # lines ≥200 to avoid wrongful firing on small docs.
                #
                # Signal: regression scan against 246 prior parse_done
                # docs found 36 hits with TOC+body duplication in
                # _chapters_position_fallback; 3 strictly improved, 34
                # unchanged, zero worsened with this gate. Target case:
                # 0b0fb6af Alchemy of Fairy Tales — front-matter chunks
                # 1-9 (Forward, Introduction, Guide) were stamped
                # `ch=4 The Frog King or Iron Henry` because TOC lines
                # 26/29/32/36 polluted position fallback ahead of
                # estimated_line ~78. With dedup, the TOC entries for
                # ch=2/3/4 are dropped (each has a body counterpart at
                # lines 1710/2673/3221) and chunks land on the correct
                # body chapter.
                _pf_lines = [(line, num, title) for line, num, title in chapters]
                _total_lines = len(full_lines)
                if _total_lines >= 200 and _pf_lines:
                    from collections import defaultdict as _dd

                    _per_ch = _dd(list)
                    for _entry in _pf_lines:
                        _per_ch[_entry[1]].append(_entry)
                    _toc_cutoff = _total_lines * 0.05
                    _body_threshold = _total_lines * 0.15
                    _chapters_with_both = sum(
                        1
                        for _entries in _per_ch.values()
                        if any(_e[0] <= _toc_cutoff for _e in _entries) and any(_e[0] >= _body_threshold for _e in _entries)
                    )
                    if _chapters_with_both >= 3:
                        _cleaned = []
                        _dropped_toc = 0
                        for _num, _entries in _per_ch.items():
                            _toc_entries = [_e for _e in _entries if _e[0] <= _toc_cutoff]
                            _body_entries = [_e for _e in _entries if _e[0] >= _body_threshold]
                            _mid_entries = [_e for _e in _entries if _toc_cutoff < _e[0] < _body_threshold]
                            if _toc_entries and _body_entries:
                                _cleaned.extend(_body_entries)
                                _cleaned.extend(_mid_entries)
                                _dropped_toc += len(_toc_entries)
                            else:
                                _cleaned.extend(_entries)
                        _cleaned.sort(key=lambda _e: _e[0])
                        if _dropped_toc > 0:
                            logger.info(
                                "TOC+body dedup: dropped %d TOC-region entries from position fallback "
                                "(%d chapters had dual-region duplicates, %d entries remain)",
                                _dropped_toc,
                                _chapters_with_both,
                                len(_cleaned),
                            )
                            _pf_lines = _cleaned
                # Char-offset companion to `lines`. Without char_offsets,
                # `_assign_cross_page_chapter_metadata` falls back to a
                # linear chunk_index → line interpolation that drifts on
                # heterogeneous chapter lengths (e.g. The Book of Aquarius
                # b86fd27e: ch=2 Foreword ~20 lines vs ch=5 Powers ~166
                # lines vs ch=54 Help ~14 lines — linear estimate stamps
                # chunks 5 chapters off near the back-matter). Pattern D
                # detected each chapter's BODY line; converting to byte
                # offsets lets the matcher use chunk-midpoint char_offset
                # for exact attribution. Mirrors what Tier 3's body-marker
                # scan does at lines ~2056 / ~2070. Cumulative signal=2
                # under `chunker_wrong_chapter_assignment_on_header_poor_markdown`
                # family (signal=1 c5f82851 Pattern E ALL-CAPS,
                # signal=1 36d64cfe OECD-FAO TOC at EOF, signal=1
                # b86fd27e linear-estimate shift).
                _line_char_offsets: list[int] = [0] * (len(full_lines) + 1)
                _running = 0
                for _li, _ln in enumerate(full_lines):
                    _line_char_offsets[_li] = _running
                    _running += len(_ln) + 1
                _line_char_offsets[len(full_lines)] = _running
                _total_chars = _running
                _pf_char_offsets = [(_line_char_offsets[_l], _n, _t) for (_l, _n, _t) in _pf_lines if 0 <= _l < len(full_lines)]
                page_chapter_map["_chapters_position_fallback"] = {
                    "lines": _pf_lines,
                    "total_lines": _total_lines,
                    "char_offsets": _pf_char_offsets,
                    "total_chars": _total_chars,
                }

        for ch_line, ch_num, ch_title in chapters:
            logger.info("Chapter detected (regex) at line %d: Chapter %d - %s", ch_line, ch_num, ch_title)

        return page_chapter_map

    @staticmethod
    def _apply_intelligent_chunking(
        text: str,
        file_path: str,
        user_id: str | None = None,
        db=None,
        additional_metadata: dict[str, Any] | None = None,
        metadata_file_path: str | None = None,
        user_settings_cache: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Apply intelligent chunking using the ChunkingService.

        Args:
            text: Document text to chunk
            file_path: Path to the source file
            user_id: User ID for preference-based strategy selection
            db: Database session for user preference lookup
            additional_metadata: Additional metadata to include (e.g., page numbers)
            metadata_file_path: Relative file path for metadata (optional)
            user_settings_cache: Cached user settings to avoid repeated DB queries (optional)

        Returns:
            List of chunk result dictionaries with text and metadata
        """
        strategy_override = None
        chunk_size_override = None
        chunk_overlap_override = None
        chunk_sizes_to_ignore_override = None

        try:
            chunking_service = get_chunking_service()

            document_metadata = {
                "source": metadata_file_path,
                "file_name": os.path.basename(file_path),
                "type": DocumentProcessor.get_file_type_from_path(file_path),
                "title": os.path.splitext(os.path.basename(file_path))[0],
            }

            if additional_metadata:
                document_metadata.update(additional_metadata)

            if user_settings_cache is not None:
                user_settings = user_settings_cache
            elif user_id and db:
                user_settings = DocumentProcessor._get_user_document_settings(db, user_id)
            else:
                user_settings = None

            if user_settings:
                if user_settings_cache is None:
                    logger.debug("User document settings found: %s", user_settings)

                if "value" in user_settings and isinstance(user_settings["value"], dict):
                    user_settings = user_settings["value"]
                    if user_settings_cache is None:
                        logger.debug("Unwrapped nested settings from 'value' key")

                strategy_override = user_settings.get("splitter_type")

                if not strategy_override:
                    old_strategy = user_settings.get("splitting_strategy", "recursive")
                    strategy_map = {
                        "recursive": "recursive",
                        "semantic": "semantic",
                        "markdown": "enhanced_markdown",
                    }
                    strategy_override = strategy_map.get(old_strategy)

                if not strategy_override:
                    strategy_override = user_settings.get("chunking_strategy", "recursive")

                chunk_size_override = user_settings.get("chunk_size")
                chunk_overlap_override = user_settings.get("chunk_overlap")
                chunk_sizes_to_ignore_override = user_settings.get("chunk_sizes_to_ignore")

                if user_settings_cache is None:
                    logger.info(
                        "User document settings for user %s: strategy=%s, chunk_size=%s, chunk_overlap=%s, ignore_sizes=%s",
                        user_id,
                        strategy_override,
                        chunk_size_override,
                        chunk_overlap_override,
                        chunk_sizes_to_ignore_override,
                    )
            else:
                if user_settings_cache is None and user_id:
                    logger.debug("No user document settings found for user %s", user_id)

            chunk_kwargs = {
                "text": text,
                "document_metadata": document_metadata,
                "user_id": user_id,
                "strategy_override": strategy_override,
                "db_session": db,
            }

            if chunk_size_override is not None:
                # noinspection PyTypeChecker
                chunk_kwargs["chunk_size"] = int(str(chunk_size_override))
            if chunk_overlap_override is not None:
                # noinspection PyTypeChecker
                chunk_kwargs["chunk_overlap"] = int(str(chunk_overlap_override))
            if chunk_sizes_to_ignore_override is not None:
                # noinspection PyTypeChecker
                chunk_kwargs["min_chunk_size"] = int(str(chunk_sizes_to_ignore_override))

            chunk_results, document_hierarchy = chunking_service.chunk_document(**chunk_kwargs)

            if document_hierarchy and db:
                from uuid import UUID

                from src.main.utils.documents.hierarchy import extract_hierarchy_statistics, store_document_hierarchy

                doc_id = document_metadata.get("document_id")
                if doc_id:
                    try:
                        success = store_document_hierarchy(db, UUID(doc_id), document_hierarchy)

                        if success:
                            stats = extract_hierarchy_statistics(document_hierarchy)
                            logger.info(
                                "Stored hierarchy for document %s: %d sections (%d top-level, max depth %d)",
                                doc_id,
                                stats["total_sections"],
                                stats["top_level_sections"],
                                stats["max_depth"],
                            )
                        else:
                            logger.warning("Failed to store hierarchy for document %s", doc_id)
                    except (ValueError, RuntimeError, TypeError) as e:
                        logger.warning("Error storing hierarchy for document %s: %s", doc_id, str(e))
                else:
                    logger.debug("No document_id in metadata, skipping hierarchy storage")

            logger.info(
                "Intelligent chunking created %d chunks using strategy %s",
                len(chunk_results),
                (chunk_results[0].get("strategy", "unknown") if chunk_results else "none"),
            )

            return chunk_results

        except Exception as ex:
            logger.error("Error in intelligent chunking: %s", str(ex))
            logger.info("Falling back to basic recursive chunking")

            from src.main.utils.config.loader import resolved_config

            rag_config = resolved_config.get("rag", {})
            fallback_chunk_size = rag_config.get("chunk_size", 768)
            fallback_chunk_overlap = rag_config.get("chunk_overlap", 128)

            if chunk_size_override is not None:
                # noinspection PyTypeChecker
                fallback_chunk_size = int(str(chunk_size_override))
            if chunk_overlap_override is not None:
                # noinspection PyTypeChecker
                fallback_chunk_overlap = int(str(chunk_overlap_override))

            logger.debug(
                "Fallback chunking with chunk_size=%d, chunk_overlap=%d",
                fallback_chunk_size,
                fallback_chunk_overlap,
            )
            text_chunks = DocumentProcessor._apply_recursive_splitting(text, fallback_chunk_size, fallback_chunk_overlap)

            chunk_results = []
            for i, chunk_text in enumerate(text_chunks):
                chunk_result = {
                    "text": chunk_text,
                    "index": i,
                    "strategy": "recursive_fallback",
                    "metadata": {
                        "chunk_index": i,
                        "total_chunks": len(text_chunks),
                        "strategy_used": "recursive_fallback",
                        "chunk_size": len(chunk_text),
                    },
                }
                chunk_results.append(chunk_result)

            return chunk_results

    @staticmethod
    def _apply_recursive_splitting(text: str, chunk_size: int, chunk_overlap: int) -> list[str]:
        """Apply recursive character text splitting."""
        try:
            from langchain_text_splitters import RecursiveCharacterTextSplitter

            splitter = RecursiveCharacterTextSplitter(
                chunk_size=chunk_size,
                chunk_overlap=chunk_overlap,
                length_function=len,
                separators=["\n\n", "\n", " ", ""],
            )

            chunks = splitter.split_text(text)
            logger.info("Split document into %s chunks using recursive splitting", len(chunks))
            return chunks

        except ImportError:
            logger.warning("LangChain not available for recursive splitting, using simple splitting")
            return DocumentProcessor._apply_simple_splitting(text, chunk_size)

    @staticmethod
    def _get_user_document_settings(db, user_id: str) -> dict[str, Any] | None:
        """Get user-specific document processing settings."""
        try:
            from sqlalchemy import text

            query = text(
                """
                SELECT setting_value FROM user_settings
                WHERE user_id = :user_id AND setting_key = 'document_processing'
            """
            )

            result = db.execute(query, {"user_id": user_id}).fetchone()

            if result:
                setting_value = result[0]
                if isinstance(setting_value, str):
                    return json.loads(setting_value)
                elif isinstance(setting_value, dict):
                    return setting_value
                else:
                    logger.warning("Unexpected setting_value type: %s", type(setting_value))
                    return None

            return None

        except (json.JSONDecodeError, ValueError, TypeError, KeyError, AttributeError) as ex:
            logger.warning("Could not retrieve user document settings: %s", str(ex))
            if hasattr(db, "rollback"):
                try:
                    db.rollback()
                    logger.debug("Transaction rolled back after error")
                except (RuntimeError, AttributeError) as rollback_error:
                    logger.warning("Could not rollback transaction: %s", str(rollback_error))
            return None

    @staticmethod
    def extract_pdf_metadata(file_path: str) -> dict[str, Any]:
        """
        Extract metadata from a PDF file using fallback methods.

        Args:
            file_path: Path to the PDF file

        Returns:
            Dictionary containing extracted metadata
        """
        from src.main.service.document.document_processor_pdf import PDFProcessor

        return PDFProcessor.extract_pdf_metadata(file_path)

    @staticmethod
    def _apply_simple_splitting(text: str, chunk_size: int) -> list[str]:
        """Simple text splitting fallback."""
        chunks = []
        for i in range(0, len(text), chunk_size):
            chunk = text[i : i + chunk_size]
            if chunk.strip():
                chunks.append(chunk)

        logger.info("Split document into %s chunks using simple splitting", len(chunks))
        return chunks


# Global instance
document_processor = DocumentProcessor()

# Re-export PDF-specific functions for backward compatibility
# Import placed here to avoid circular imports (document_processor_pdf imports from this module)
from src.main.service.document.document_processor_pdf import (
    DoclingLogHandler,
    DoclingProgressTracker,
    _normalize_device_type,
    detect_ocr_document,
)

__all__ = [
    "DoclingLogHandler",
    "DoclingProgressTracker",
    "DocumentProcessingError",
    "DocumentProcessor",
    "_normalize_device_type",
    # PDF-specific exports for backward compatibility
    "detect_ocr_document",
    "document_processor",
]
