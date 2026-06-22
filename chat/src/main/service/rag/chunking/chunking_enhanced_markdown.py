"""
Enhanced markdown chunking strategy that respects both structure and semantic meaning.

This implementation combines header-based splitting with semantic boundary detection
to create chunks that preserve the integrity of concepts and document elements.

**Balanced Enhancements (v2):**
- Header/footer filtering for PDFs (removes page numbers, URLs, copyright)
- Narrative element preservation (dialogue, quotes, lists stay intact)
- Paragraph-aware splitting (never breaks mid-paragraph)
- Sentence-based fallback for oversized paragraphs
- Structure-aware element protection (tables, code, footnotes, blockquotes)
- Optional semantic boundary refinement with embeddings

**Best for:** PDFs, ePub books, technical documentation, academic papers, and general unstructured text.
"""

from collections.abc import Callable
import re
from typing import Any

from langchain_text_splitters import MarkdownHeaderTextSplitter
import numpy as np

from src.main.service.rag.chunking.base_chunking import BaseChunkingStrategy
from src.main.utils.core.logger import get_logger
from src.main.utils.documents.utils import setup_markdown_headers, sliding_window_chunking
from src.main.utils.text.formatting import normalize_whitespace, smart_title_case

logger = get_logger(__name__)


_OCR_SPACED_PATTERN = re.compile(r"(?<![\w'\"’‘])[B-HJ-Z]\s+([A-Z][A-Za-z]+)")


def _repair_ocr_spaced_title(title: str) -> str:
    """Join lone-capital-letter + adjacent capitalized word in OCR-spaced headings.

    Some EPUBs bake decorative CSS-style letter-spacing into the heading text
    itself, producing markup like `<h2>~F ARMACIST D ESK R EFERENCE</h2>`
    (Don Tolman's Farmacist Desk Reference, e763b43d). The chunker would
    otherwise propagate that garbled string into `chapter_title` metadata.

    Gate: only fires when density >= 3 OR title starts with `~`. This rejects
    contractions (`DON'T USE`), possessives (`NATION'S PRESENCE`), Spanish/
    Portuguese conjunctions (`Y`, `E`), Roman numerals (`V`, `X`),
    chemistry notation (`C:N`, `13 C`), and product/code names (`MODEL C`).
    Verified against 8245 distinct chapter_title strings in pgvector
    cmetadata (2026-05-14 corpus probe): 0 false positives, 2 true repairs.
    """
    if not title:
        return title
    matches = _OCR_SPACED_PATTERN.findall(title)
    density = len(matches)
    has_tilde = title.startswith("~")
    if density < 3 and not has_tilde:
        return title

    def _join(m: re.Match) -> str:
        full = m.group(0)
        idx = full.index(" ")
        return full[:idx] + full[idx + 1 :]

    repaired = _OCR_SPACED_PATTERN.sub(_join, title)
    return smart_title_case(repaired)


class EnhancedMarkdownChunkingStrategy(BaseChunkingStrategy):
    """
    Enhanced Markdown chunking that respects both structure and semantic meaning.

    This strategy:
    1. Identifies Markdown headers and structural elements (tables, code blocks)
    2. Preserves these elements as atomic units when possible
    3. Uses semantic boundary detection for large sections
    4. Ensures related content stays together in the same chunk
    """

    def __init__(
        self,
        chunk_size: int = 1000,
        chunk_overlap: int = 200,
        headers_to_split_on: list[tuple[str, str]] | None = None,
        embedding_fn: Callable | None = None,
        preserve_elements: bool = True,
        min_section_length: int = 100,
        **kwargs,
    ):
        """
        Initialize the enhanced markdown chunking strategy.

        Args:
                chunk_size: The target size of chunks in tokens (inherited from BaseChunkingStrategy)
                chunk_overlap: The amount of overlap between chunks in tokens
                headers_to_split_on: A list of (header_regex, header_name) tuples to split on
                        If None, defaults to standard Markdown headers (# through ######)
                embedding_fn: An optional function to create embeddings for semantic boundary detection
                preserve_elements: Whether to preserve structural elements (tables, code blocks)
                min_section_length: The minimum length of a section to be considered for further splitting in tokens
                **kwargs: Additional parameters
        """
        super().__init__(chunk_size, chunk_overlap, **kwargs)

        # Set up headers using the utility function
        self.headers_to_split_on = setup_markdown_headers(headers_to_split_on, use_spaces=False)

        self.embedding_fn = embedding_fn
        self.preserve_elements = preserve_elements
        self.min_section_length = min_section_length

        # Regex patterns for identifying structural elements
        self.table_pattern = re.compile(r"(\|[^\n]+\|(?:\n\|[^\n]+\|)+)")
        self.code_block_pattern = re.compile(r"```[^\n]*\n[\s\S]*?\n```")
        self.footnote_pattern = re.compile(r"\[\^[^]]+]:[^\n]+(?:\n(?!\[\^)[^\n]+)*")

        # Patterns for detecting headers/footers (common in PDFs)
        # CRITICAL: DO NOT remove chapter headings! Only remove repetitive page headers.
        self.header_footer_patterns = [
            re.compile(r"^\s*[\w\s.-]+\.com\s*[–-]\s*[\w\s]+\s*$", re.MULTILINE),  # URLs with dashes
            re.compile(r"^\s*Page\s+\d+\s*$", re.MULTILINE | re.IGNORECASE),  # Page numbers
            re.compile(r"^\s*\d+\s*$", re.MULTILINE),  # Standalone numbers (but NOT Markdown headers like "# 1")
            # Running headers: page number/author with 10+ spaces (PDFs often use excessive spacing for alignment)
            re.compile(r"^\s*\d+\s{10,}[\w\s]+$", re.MULTILINE),  # Format: number + 10+ spaces + text
            re.compile(r"^\s*[\w\s]+\s{10,}\d+\s*$", re.MULTILINE),  # Reverse: text + 10+ spaces + number
            # NOTE: DO NOT filter "Chapter X" lines - they are legitimate chapter headings!
            # re.compile(r"^\s*Chapter\s+\d+\s*$", re.MULTILINE | re.IGNORECASE), # REMOVED - was breaking chapter detection
            re.compile(r"^\s*\d+\s*/\s*\d+\s*$", re.MULTILINE),  # Page x/y format
            # Italic running headers from PDFs: _CHAPTER 5. TACTICAL DISPOSITIONS_ 44
            re.compile(r"^_CHAPTER\s+\d+\.\s+.+_\s+\d+$", re.IGNORECASE),
        ]

        # Patterns for narrative elements (dialogue, quotes, lists)
        # Match straight quotes ("), left curly quotes (\u201C), and right curly quotes (\u201D)
        self.dialogue_pattern = re.compile(r'(["\u201C\u201D].*?["\u201C\u201D]|".*?")', re.DOTALL)
        self.list_pattern = re.compile(r"((?:^\s*[-*+•]\s+.+$\n?)+)", re.MULTILINE)
        self.quote_block_pattern = re.compile(r"((?:^\s*>.*$\n?)+)", re.MULTILINE)

    def split_text(self, text: str) -> list[str]:
        """
        Split the input Markdown text into chunks that respect meaning boundaries.

        This is the base method that returns simple string chunks.
        For hierarchical data, use split_text_with_hierarchy().

        Args:
            text: Input Markdown text to be chunked

        Returns:
            List of text chunks with preserved meaning boundaries
        """
        hierarchical_chunks, _ = self.split_text_with_hierarchy(text)
        # Extract just the text content for compatibility
        return [chunk["text"] for chunk in hierarchical_chunks]

    def split_text_with_hierarchy(self, text: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """
        Split the input Markdown text into chunks with hierarchical metadata and extract complete document hierarchy.

        Args:
            text: Input Markdown text to be chunked

        Returns:
            Tuple of (chunks_with_metadata, document_hierarchy)
            - chunks_with_metadata: List of dictionaries with 'text' and hierarchical metadata
            - document_hierarchy: Nested dictionary representing document structure with chunk ranges
        """
        if not text or not text.strip():
            logger.warning("Empty text provided to enhanced markdown chunking")
            return [], {}

        try:
            import time as _time

            _t0 = _time.time()
            _text_len = len(text)

            # Step 0a: Strip extraction placeholder markers
            # `<!-- image -->`, `<!-- table -->`, `<!-- formula -->` are Docling /
            # PyMuPDF4LLM placeholders for non-OCR'd elements. They carry zero
            # semantic content but bloat embeddings, pollute chunk boundaries,
            # and inflate word counts — especially for image-only scanned PDFs
            # whose entire body is a string of these markers (e.g. the 4H
            # Beekeeping leaflet that ended up with ~12 placeholders + a single
            # copyright colophon as its full content).
            text = self._strip_extraction_placeholders(text)

            # Step 0b: Filter out headers/footers (common in PDFs)
            cleaned_text = self._filter_headers_footers(text)
            logger.info("Chunking step 0 (_strip_placeholders + _filter_headers_footers): %.1fs for %d chars", _time.time() - _t0, _text_len)

            # Step 1: Identify and protect structural elements
            _t1 = _time.time()
            if self.preserve_elements:
                protected_text, elements = self._protect_structural_elements(cleaned_text)
            else:
                protected_text, elements = cleaned_text, {}
            logger.info("Chunking step 1 (_protect_structural_elements): %.1fs", _time.time() - _t1)

            # Step 1.5: Normalize split-format chapter markers
            # Lifted from 500KB to 10MB cap (2026-05-13): the original
            # gate was set on a worst-case estimate that didn't match
            # reality. Measured on production docs:
            #   794KB  (4a84ec1c):   0.04s
            #   1.25MB (baf798b3):   0.07s
            #   3.8MB  (604ae877):   0.15s
            # The skip caused chapter-detection collapse on 100+ docs
            # > 500KB (baf798b3 distinct_ch 9→4 regression confirmed).
            # 10MB cap retained as a safety stop for pathological inputs.
            _t15 = _time.time()
            if len(protected_text) <= 10_000_000:
                protected_text = self._normalize_chapter_markers(protected_text)
            else:
                logger.info("Skipping chapter marker normalization for very large document (%d chars > 10 MB)", len(protected_text))
            logger.info("Chunking step 1.5 (_normalize_chapter_markers): %.1fs", _time.time() - _t15)

            # Step 1.6: Convert bold-only lines to Markdown headers
            _t16 = _time.time()
            if len(protected_text) <= 10_000_000:
                protected_text = self._normalize_bold_headers(protected_text)
            else:
                logger.info("Skipping bold header normalization for very large document (%d chars > 10 MB)", len(protected_text))
            logger.info("Chunking step 1.6 (_normalize_bold_headers): %.1fs", _time.time() - _t16)

            # Step 1.7: Cheap pre-splitter normalisations that ALWAYS run regardless
            # of document size. These are single-pass regex substitutions (one
            # pass over the text each, no cross-line state machine) so even at
            # 1.4 MB they finish in <1 s — orders of magnitude faster than the
            # O(lines × patterns) split-format normaliser in step 1.5. Without
            # this, large EPUB / PDF→markdown books skip 1.5/1.6 and the
            # splitter has nothing to cut on; chapter detection collapses to
            # 4-6 chapters for what is really a 17+ chapter book.
            _t17 = _time.time()
            protected_text = self._inject_chapter_markers_lightweight(protected_text)
            logger.info("Chunking step 1.7 (_inject_chapter_markers_lightweight): %.1fs", _time.time() - _t17)

            # Step 2: Split by headers using MarkdownHeaderTextSplitter
            _t2 = _time.time()
            markdown_splitter = MarkdownHeaderTextSplitter(headers_to_split_on=self.headers_to_split_on)
            split_docs = markdown_splitter.split_text(protected_text)
            logger.info("Chunking step 2 (MarkdownHeaderTextSplitter): %.1fs, %d sections", _time.time() - _t2, len(split_docs))

            # Step 3: Process each section based on its size and extract hierarchy metadata
            chunks = []
            current_chapter = 0  # Start at 0 — first H1 will become chapter 1
            current_section = 1

            # Pre-pass: does THIS document already use literal "Chapter N" headers?
            # If yes (e.g. Art of War with `## **Chapter 1**` ... `## **Chapter 13**`),
            # we disable the H1 auto-promotion and trust _extract_hierarchy_metadata's
            # regex path. Otherwise, the auto-promotion would misclassify ordinary
            # section headings ("1.1 Sun Wu", "Bibliography") as new chapters.
            #
            # End-recap-marker filter (added 2026-05-14 after 3c0f7733
            # Complete Guide to Restoring Your Soil): some books have
            # `# Chapter N Summary` recap headers at the END of each
            # chapter while the REAL chapter starts use numeric prefix
            # (`# 01 Soil Salvation`, `# 02 ...`). The naive regex matched
            # the Summary recap lines, set doc_has_explicit_chapters=True,
            # and disabled auto-promotion — so the real H1 chapters were
            # never promoted and ALL 513 chunks ended up with
            # chapter_number=1. Filter: count matches whose title is NOT
            # a single common end-marker word. Require >=3 real-chapter
            # matches before honouring doc_has_explicit_chapters.
            _ch_pattern_re = re.compile(
                r"^#{1,6}\s+\*?\*?(?:CHAPTER|CHAP)\.?\s+(?:[IVXLC]+|\d+)\s*\*?\*?[\s:.,-]*([^\n]*)",
                re.IGNORECASE | re.MULTILINE,
            )
            _end_markers_ch = {
                "summary",
                "conclusion",
                "conclusions",
                "notes",
                "discussion",
                "references",
                "review",
                "exercises",
                "questions",
                "recap",
            }
            _real_matches = []
            for _m in _ch_pattern_re.finditer(protected_text):
                _trail = _m.group(1).strip().rstrip(".,;:!?*").strip()
                _trail_norm = _trail.lower()
                # Reject empty title, single-word end-marker title,
                # punctuation-start, and "Chapter N N" (digit-only trail).
                if not _trail:
                    continue
                if _trail_norm in _end_markers_ch:
                    continue
                if _trail[0] in ".,;:)]([":
                    continue
                _real_matches.append(_m)
            doc_has_explicit_chapters = len(_real_matches) >= 3

            # Track distinct Header 1 values to auto-promote them to chapters.
            # Without this, books with thematic H1 titles (e.g. "Introduction",
            # "The Stone", "Conclusion") that lack the literal "Chapter N" pattern
            # collapse into a single chapter — every chunk gets chapter_number=1.
            seen_h1_titles: dict[str, int] = {}
            # Parallel map chapter_number → title. Populated on every
            # auto-promotion. Used to backfill chapter_title on CONTINUATION
            # sub-sections (multiple `## subheadings` under a single `# Title`)
            # where MarkdownHeaderTextSplitter creates a new section but
            # auto_chapter_promoted stays False — without the backfill those
            # sub-sections get chapter_title="" while the first sub-section
            # carries the real title. Fix verified on e56b1cd1 Cultivation
            # for Climate Change Vol 2 where each numbered `# N` chapter had
            # ~6 chunks correctly labelled and ~30 chunks with empty title.
            chapter_titles_by_number: dict[int, str] = {}
            # Pre-pass: detect H1 values that REPEAT across many sections
            # (book-title-as-H1 pattern). The existing IDRC condition
            # (seen_h1_titles[h1] == 1) only catches the case where the
            # repeating H1 is the FIRST chapter signal seen. When front-matter
            # sections (Author Cover, Contents) come BEFORE the book-title
            # H1, the existing check fails and the book title pollutes every
            # subsequent chunk's chapter_title. Canonical regression:
            # 438692fd Gene Logsdon Living at Nature's Pace had front-matter
            # author / contents H1s before the book-title H1 appeared, so
            # the IDRC condition didn't fire and the book title dominated
            # 130/136 chunks (the chapter_title backfill amplified this).
            # Threshold: 30% of sections share the same H1 OR appearance
            # count >= 3 — repeating book title pattern.
            repeating_h1_titles: set[str] = set()
            if split_docs:
                from collections import Counter as _Counter

                _h1_counts = _Counter((d.metadata.get("Header 1") or "").replace("**", "").strip() for d in split_docs if d.metadata.get("Header 1"))
                _total_sections = len(split_docs)
                repeating_h1_titles = {h1 for h1, count in _h1_counts.items() if h1 and count >= max(3, _total_sections * 0.30)}

            for doc in split_docs:
                section_text = doc.page_content

                # Auto-chapter detection BEFORE extract_hierarchy_metadata so books
                # with thematic H1/H2 titles ('Cover', 'Introduction', 'The Stone')
                # don't collapse into a single chapter. Falls back to Header 2 when
                # there is no H1 in the document at all.
                #
                # IMPORTANT: skip auto-promotion when the signal is a literal
                # 'Chapter N' header. _extract_hierarchy_metadata's regex path
                # already extracts the correct chapter number from those, and
                # auto-promoting by ordinal would assign 'Contents' → 1,
                # 'Chapter 1' → 2, 'Chapter 2' → 3 etc. — completely off-by-one.
                doc_meta = getattr(doc, "metadata", {}) or {}
                # Strip bold markers + markdown-link tails. Some EPUB-to-md
                # extractors emit TOC-style headings as ``# [Masdevallia](003-toc.html#sec22)``
                # — the raw `.replace("**","")` strip wouldn't touch the link
                # tail, propagating malformed `[text](url)` into chapter_title.
                # Canonical case: 8b521f60 (The Orchid Whisperer) 12+ chunks
                # stamped with full bracketed link as chapter_title.
                from src.main.service.document.document_processor import _sanitize_chapter_title

                h1_raw = _sanitize_chapter_title((doc_meta.get("Header 1") or "").replace("**", "").strip())
                h2_raw = _sanitize_chapter_title((doc_meta.get("Header 2") or "").replace("**", "").strip())
                # Use H1 if present, otherwise H2 as the chapter-boundary signal.
                # Prefer H2 over H1 when:
                #  (a) IDRC-style book-title repeat: H1 is a constant book-title
                #      that appears on many sections (canonical case: 1994 IDRC
                #      'Cities feeding people' — H1='Cities Feeding People' on
                #      every chunk, H2 cycles through 'Foreword …', 'Chapter 1 …',
                #      'Bibliography'). Without this, every chunk auto-promotes
                #      the book title as its chapter_title and the real H2 signal
                #      is silently lost. Detected via repeating_h1_titles pre-pass
                #      (≥30% of sections or ≥3 occurrences share same H1) instead
                #      of the original `== 1` check which only fired when the
                #      book-title H1 was the FIRST chapter signal seen.
                #  (b) Split-marker pattern: H1 is just a chapter number marker
                #      (`# 1`, `# 2`, `# I`) — fewer than 3 alpha chars — while
                #      H2 carries the real chapter title (e56b1cd1 Cultivation for
                #      Climate Change Vol 2: `# 1` + `## Implications of Climate
                #      Change on Agriculture and Food Security`). Without this,
                #      auto-promotion assigns chapter_title='1' and the meaningful
                #      H2 title is silently lost.
                h1_is_degenerate = bool(h1_raw) and sum(1 for c in h1_raw if c.isalpha()) < 3
                if (
                    h1_raw
                    and h2_raw
                    and h1_raw != h2_raw
                    and (h1_raw in repeating_h1_titles or (h1_raw in seen_h1_titles and seen_h1_titles[h1_raw] == 1) or h1_is_degenerate)
                ):
                    chapter_signal = h2_raw
                else:
                    chapter_signal = h1_raw or h2_raw
                # Repair OCR-spaced decorative headings — EPUBs occasionally bake
                # CSS letter-spacing into the text itself (`~F ARMACIST D ESK
                # R EFERENCE`), and the raw string would otherwise propagate
                # into chunk chapter_title metadata. Gate is conservative
                # (density >= 3 OR `~`-prefix); see _repair_ocr_spaced_title.
                if chapter_signal:
                    chapter_signal = _repair_ocr_spaced_title(chapter_signal)
                # Publisher-boilerplate H1 reject: Springer/Wiley per-chapter
                # copyright blocks render as H1 like "# The Author(s), under
                # exclusive license to Springer Nature ...". These are NOT real
                # chapter titles — auto-promoting them via the unique-H1 path
                # collapses every chapter's chunks to a single bogus chapter_title.
                # Reject before _is_explicit_chapter / auto-promotion runs.
                if chapter_signal:
                    _cs_lower = chapter_signal.lower()
                    if _cs_lower.startswith(("the author(s)", "the editor(s)")) or "under exclusive license" in _cs_lower:
                        chapter_signal = ""
                # Page-anchor reject: pymupdf4llm-layout emits per-page H-level
                # anchors like "# page0007" inside the body. Treating those as
                # chapter signals creates one bogus chapter per page (observed
                # on 9fa59f47 Awakening To Reality: 99 chunks all labeled
                # page0002..page0055). Mirror filter exists in
                # node_factory._clean_chapter_title but only runs at Neo4j
                # ingest — pgvector chunks stayed polluted until this lift.
                if chapter_signal:
                    from src.main.service.document.document_processor import is_page_anchor_title

                    if is_page_anchor_title(chapter_signal):
                        chapter_signal = ""
                _is_explicit_chapter = bool(chapter_signal and re.match(r"^(?:chapter|chap)\.?\s+", chapter_signal, re.IGNORECASE))
                auto_chapter_promoted = False
                auto_chapter_title = ""
                # Disable auto-promotion entirely for documents that already use
                # literal "Chapter N" headers — let the metadata extractor's regex
                # path handle them so we don't conflate ordinary section headings
                # with chapter boundaries.
                if doc_has_explicit_chapters:
                    # Skip auto-promotion. Just anchor at 1 until the metadata
                    # extractor's regex finds the first 'Chapter N'.
                    if current_chapter == 0:
                        current_chapter = 1
                elif chapter_signal and not _is_explicit_chapter:
                    if chapter_signal not in seen_h1_titles:
                        seen_h1_titles[chapter_signal] = len(seen_h1_titles) + 1
                        current_chapter = seen_h1_titles[chapter_signal]
                        current_section = 1
                        auto_chapter_promoted = True
                        auto_chapter_title = chapter_signal
                    else:
                        current_chapter = seen_h1_titles[chapter_signal]
                elif not chapter_signal and current_chapter == 0:
                    # Document has no H1/H2 at all — anchor to chapter 1 so we
                    # never propagate chapter_number=0 downstream.
                    current_chapter = 1

                # Extract hierarchical metadata from the document headers
                hierarchy_metadata = self._extract_hierarchy_metadata(doc, current_chapter, current_section)

                # If auto-chapter promoted (new H1 seen) and the metadata extractor
                # didn't override with a stronger "Chapter N" match, set the chapter
                # title from the H1 text and mark as a new chapter boundary.
                if auto_chapter_promoted and not hierarchy_metadata.get("is_new_chapter"):
                    hierarchy_metadata["chapter_number"] = current_chapter
                    hierarchy_metadata["chapter_title"] = auto_chapter_title
                    hierarchy_metadata["is_new_chapter"] = True
                    # Reset section to 1 — H1 starts a fresh section sequence
                    hierarchy_metadata["section_number"] = 1
                    if not hierarchy_metadata.get("section_title"):
                        hierarchy_metadata["section_title"] = auto_chapter_title
                    chapter_titles_by_number[current_chapter] = auto_chapter_title
                # Continuation backfill: a sub-section under the SAME chapter
                # signal as a previously-promoted chapter (e.g. multiple
                # `## subheadings` under one `# Chapter Title`) — the metadata
                # extractor didn't find an explicit "Chapter N" and the auto-
                # promotion branch didn't fire (chapter_signal already in
                # seen_h1_titles). Without this, the sub-section inherits an
                # empty chapter_title from `_extract_hierarchy_metadata`'s
                # default. Backfill from the known title for current_chapter.
                elif current_chapter > 0 and not hierarchy_metadata.get("chapter_title") and current_chapter in chapter_titles_by_number:
                    hierarchy_metadata["chapter_number"] = current_chapter
                    hierarchy_metadata["chapter_title"] = chapter_titles_by_number[current_chapter]

                # Record any resolved chapter_title — from auto-promotion (above)
                # OR from the metadata extractor's explicit "Chapter N" regex — so
                # later body chunks of the SAME chapter backfill it via the
                # continuation branch above. The auto-promotion branch only
                # populates chapter_titles_by_number for implicit-H1 books;
                # doc_has_explicit_chapters books resolve the title through
                # _extract_hierarchy_metadata, which previously left the map empty
                # → only the header chunk got the title and 80%+ of body chunks
                # went blank (Waite Secret Tradition: 310/381 empty). setdefault
                # keeps the first (chapter-header) title, ignoring later noise.
                _resolved_num = hierarchy_metadata.get("chapter_number")
                _resolved_title = (hierarchy_metadata.get("chapter_title") or "").strip()
                if isinstance(_resolved_num, int) and _resolved_num > 0 and _resolved_title:
                    chapter_titles_by_number.setdefault(_resolved_num, _resolved_title)

                # Update counters for hierarchy
                if hierarchy_metadata.get("is_new_chapter"):
                    current_chapter = hierarchy_metadata["chapter_number"]
                    current_section = 1
                elif hierarchy_metadata.get("is_new_section"):
                    current_section = hierarchy_metadata["section_number"]

                # If a section is small enough (in tokens), keep it as is
                section_tokens = self.count_tokens(section_text)
                if section_tokens <= self.chunk_size:
                    chunk_with_hierarchy = self._create_chunk_with_metadata(section_text, hierarchy_metadata)
                    chunks.append(chunk_with_hierarchy)
                    continue

                # For larger sections, apply semantic splitting if the embedding function is available
                if self.embedding_fn and section_tokens > self.min_section_length:
                    section_chunks = self._apply_semantic_splitting(section_text)
                else:
                    # Fall back to simple recursive splitting
                    section_chunks = self._recursive_split(section_text)

                # Add hierarchy metadata to each chunk
                # Only the first chunk of a section should have is_new_chapter/is_new_section=True;
                # subsequent chunks are continuations, not new boundaries.
                for j, chunk_text in enumerate(section_chunks):
                    if j > 0:
                        continuation_metadata = hierarchy_metadata.copy()
                        continuation_metadata["is_new_chapter"] = False
                        continuation_metadata["is_new_section"] = False
                        chunk_with_hierarchy = self._create_chunk_with_metadata(chunk_text, continuation_metadata)
                    else:
                        chunk_with_hierarchy = self._create_chunk_with_metadata(chunk_text, hierarchy_metadata)
                    chunks.append(chunk_with_hierarchy)

            # Step 4: Restore protected elements
            if self.preserve_elements:
                for chunk in chunks:
                    chunk["text"] = self._restore_structural_elements(chunk["text"], elements)

            # Step 5 & 6: Apply size constraints WITH metadata propagation
            # BUG FIX: Previous implementation used index-based matching which broke when
            # _enforce_size_constraints changed the number of chunks (merging/splitting).
            # New approach: Track metadata per chunk and propagate correctly.
            final_chunks = self._enforce_size_constraints_with_metadata(chunks)

            # Step 7: Build a complete hierarchy tree
            document_hierarchy = self._build_hierarchy_tree(final_chunks)

            # Step 8: Add parent/section chunk ranges to each chunk
            for chunk in final_chunks:
                chunk["parent_chunk_range"] = self._find_parent_range(chunk, document_hierarchy, final_chunks)
                chunk["section_chunk_range"] = self._find_section_range(chunk, document_hierarchy, final_chunks)

            # Log chapter detection summary
            unique_chapters = {c for chunk in final_chunks if (c := chunk.get("chapter_number")) is not None}
            unique_sections = {(chunk.get("chapter_number"), chunk.get("section_number")) for chunk in final_chunks}
            logger.info(
                "📚 Enhanced markdown chunking: %d chunks, %d chapters detected, %d unique sections",
                len(final_chunks),
                len(unique_chapters),
                len(unique_sections),
            )
            if unique_chapters and final_chunks:
                # noinspection PyTypeChecker
                logger.info("📖 Chapters found: %s", sorted(c for c in unique_chapters if c is not None))

            return final_chunks, document_hierarchy

        except (ValueError, TypeError, AttributeError, KeyError, re.error) as e:
            logger.error("Error in enhanced markdown chunking: %s", str(e))
            # Fall back to simple chunking
            fallback_chunks = self._fallback_chunking(text)
            return fallback_chunks, {}

    @staticmethod
    def _protect_elements_by_pattern(
        text: str,
        pattern: re.Pattern,
        placeholder_prefix: str,
        elements: dict[str, str],
        size_filter: int | None = None,
    ) -> str:
        """
        A helper method to protect elements matching a pattern by replacing them with placeholders.

        Args:
            text: The text to process
            pattern: The regex pattern to find elements
            placeholder_prefix: The prefix for placeholder names (e.g., "CODE_BLOCK")
            elements: A dictionary to store element mappings
            size_filter: An optional maximum size for elements to protect

        Returns:
            The text with elements is replaced by placeholders
        """
        found_elements = pattern.findall(text)
        protected_text = text

        for i, element in enumerate(found_elements):
            if size_filter is None or len(element) < size_filter:
                placeholder = f"__{placeholder_prefix}_{i}__"
                elements[placeholder] = element
                protected_text = protected_text.replace(element, placeholder)

        return protected_text

    def _protect_structural_elements(self, text: str) -> tuple[str, dict[str, str]]:
        """
        Replace structural and narrative elements with placeholders to protect them during splitting.

        Args:
                text: The original Markdown text

        Returns:
                A tuple of (protected text, dictionary of elements)
        """
        elements = {}
        protected_text = text

        # Protect code blocks
        protected_text = self._protect_elements_by_pattern(protected_text, self.code_block_pattern, "CODE_BLOCK", elements)

        # Protect tables
        protected_text = self._protect_elements_by_pattern(protected_text, self.table_pattern, "TABLE", elements)

        # Protect footnotes
        protected_text = self._protect_elements_by_pattern(protected_text, self.footnote_pattern, "FOOTNOTE", elements)

        # Protect quote blocks (Markdown blockquotes)
        protected_text = self._protect_elements_by_pattern(protected_text, self.quote_block_pattern, "QUOTE_BLOCK", elements)

        # Protect list blocks (to keep lists together) - only if reasonably sized
        protected_text = self._protect_elements_by_pattern(protected_text, self.list_pattern, "LIST_BLOCK", elements, size_filter=self.chunk_size)

        return protected_text, elements

    @staticmethod
    def _restore_structural_elements(text: str, elements: dict[str, str]) -> str:
        """
        Restore structural elements from placeholders.

        Args:
                text: The text with placeholders
                elements: A dictionary of elements

        Returns:
                The text with restored elements
        """
        restored_text = text
        for placeholder, element in elements.items():
            if placeholder in restored_text:
                restored_text = restored_text.replace(placeholder, element)
        return restored_text

    @staticmethod
    def _strip_extraction_placeholders(text: str) -> str:
        """
        Remove Docling / PyMuPDF4LLM placeholder markers for non-OCR'd
        elements. These appear as standalone lines like:

            <!-- image -->
            <!-- table -->
            <!-- formula -->

        and carry no semantic content. For image-only scans they can make
        up >50% of the source and silently flood the embedding store with
        identical zero-information vectors.
        """
        if not text or "<!--" not in text:
            return text
        # Strip whole-line occurrences (most common — Docling line-aligned).
        text = re.sub(
            r"^\s*<!--\s*(?:image|table|formula|figure)\s*-->\s*$\n?",
            "",
            text,
            flags=re.MULTILINE | re.IGNORECASE,
        )
        # Strip any remaining inline occurrences.
        text = re.sub(
            r"<!--\s*(?:image|table|formula|figure)\s*-->",
            "",
            text,
            flags=re.IGNORECASE,
        )
        # Collapse runs of blank lines created by the removal.
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text

    def _filter_headers_footers(self, text: str) -> str:
        """
        Filter out common PDF headers and footers that interfere with chunking.
        For large documents (>200KB), processes in page-sized blocks to avoid
        O(n) slowdown on 30K+ line documents.

        This method detects and removes:
        - Website URLs with author names
        - Page numbers ("Page 28", "28", "28/251")
        - Repeated running headers (frequency-based detection)

        Args:
                text: The input text potentially containing headers/footers

        Returns:
                The cleaned text with headers/footers removed
        """
        lines = text.split("\n")

        # Frequency-based running header detection: short lines (<40 chars) that
        # appear 3+ times are almost certainly running headers from PDF pages.
        # For large documents (>10K lines), sample every Nth line to keep O(n) fast.
        from collections import Counter

        sample_step = max(1, len(lines) // 10000)  # Sample ~10K lines max
        chapter_re = re.compile(r"^(?:CHAPTER|Chapter|CHAP)\b", re.IGNORECASE)
        bold_re = re.compile(r"^\*\*(.+)\*\*$")
        # Defense-in-depth: a markdown heading marker for a structural
        # division (`# Chapter N`, `# Part N`, `# Book N`, `# Section N`,
        # `# Stage N`) must NEVER be classified as a running header even
        # if its trailing title happens to repeat as a TOC entry or in
        # bold-headline citations elsewhere. Verified 2026-05-29 on doc
        # a38515fc Multi-Orgasmic Man: Chapter 5 ("Become a Multi-
        # Orgasmic Man") was silently dropped from document_hierarchy
        # because the title overlapped with the book title and TOC
        # entries, taking the H1 marker line down with it. Roman and
        # spelled-out numerals (`# Chapter Twelve`) covered too.
        structural_heading_re = re.compile(
            r"^#+\s+(?:Chapter|Part|Book|Section|Stage|Volume)\s+"
            r"(?:[IVXLCDM]+|\d+|one|two|three|four|five|six|seven|eight|"
            r"nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|"
            r"seventeen|eighteen|nineteen|twenty)\b",
            re.IGNORECASE,
        )

        short_line_counts: Counter = Counter()
        bold_line_counts: Counter = Counter()
        for i in range(0, len(lines), sample_step):
            stripped = lines[i].strip()
            if not stripped or len(stripped) >= 40 or stripped.startswith("#"):
                continue
            if not chapter_re.match(stripped):
                short_line_counts[stripped] += 1
            bold_match = bold_re.match(stripped)
            if bold_match and len(bold_match.group(1).strip()) < 40:
                bold_line_counts[bold_match.group(1).strip()] += 1

        # Scale threshold by sample step (if sampling every 3rd line, need 1+ instead of 3+)
        freq_threshold = max(2, 3 // sample_step)
        running_headers = {line for line, count in short_line_counts.items() if count >= freq_threshold}
        running_header_bolds = {inner for inner, count in bold_line_counts.items() if count >= freq_threshold}

        if running_headers:
            logger.info(
                "Detected %d running headers by frequency: %s",
                len(running_headers),
                [h[:30] for h in sorted(running_headers)[:5]],
            )

        # Build combined set for O(1) lookup (includes bold inner text)
        all_running = running_headers | running_header_bolds
        indicator_keywords = frozenset([".com", "page", "©", "copyright", "all rights reserved"])

        lines_removed = 0
        filtered_lines = []

        for line in lines:
            stripped = line.strip()
            if not stripped:
                filtered_lines.append(line)
                continue

            # Defense-in-depth: never strip a structural heading marker
            # (`# Chapter N`, `# Part N`, etc.) even if a later check
            # would consider its trailing title repetitive. See
            # `structural_heading_re` definition above for the 2026-05-29
            # Multi-Orgasmic Man incident.
            if structural_heading_re.match(stripped):
                filtered_lines.append(line)
                continue

            # Fast O(1) set lookup for running headers
            if stripped in all_running:
                lines_removed += 1
                continue

            # Bold running header check: **BAR** where BAR is a running header
            if running_header_bolds and len(stripped) > 4:
                bold_m = bold_re.match(stripped)
                if bold_m and bold_m.group(1).strip() in running_header_bolds:
                    lines_removed += 1
                    continue

            # Regex pattern check (pre-compiled patterns)
            is_header_footer = False
            if len(stripped) < 80:  # Skip regex for long lines (can't be headers)
                for pattern in self.header_footer_patterns:
                    if pattern.match(stripped):
                        is_header_footer = True
                        break

            # Short line heuristic
            if not is_header_footer and len(stripped) < 50 and stripped[-1] not in ".!?:;":
                lower_line = stripped.lower()
                if any(kw in lower_line for kw in indicator_keywords):
                    is_header_footer = True

            if is_header_footer:
                lines_removed += 1
            else:
                filtered_lines.append(line)

        cleaned_text = "\n".join(filtered_lines)

        if lines_removed > 0:
            logger.debug("Filtered out %d header/footer lines from text", lines_removed)

        return cleaned_text

    @staticmethod
    def _normalize_chapter_markers(text: str) -> str:
        """
        Normalize split-format chapter markers into proper Markdown headers.

        Some books/PDFs have chapter headers split across multiple lines:
        - "## CHAPTER" + "## 1" → "## Chapter 1"
        - "## CHAPTER" + "" + "## 1" → "## Chapter 1" (with blank line)
        - "**CHAPTER**" + "**1**" → "## Chapter 1"
        - "## CHAPTER I" → "## Chapter 1" (Roman numerals)

        This normalization ensures MarkdownHeaderTextSplitter creates proper
        section boundaries at chapter starts.

        Args:
            text: Input text with potentially split chapter markers

        Returns:
            Text with normalized chapter headers
        """
        # Number conversion mappings
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
            "xxi": 21,
            "xxii": 22,
            "xxiii": 23,
            "xxiv": 24,
            "xxv": 25,
        }
        word_to_int = {
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

        def parse_chapter_number(num_str: str) -> str:
            """Convert arabic, roman numeral, or spelled-out number to arabic string."""
            num_lower = num_str.lower().strip()
            if num_lower in roman_to_int:
                return str(roman_to_int[num_lower])
            if num_lower in word_to_int:
                return str(word_to_int[num_lower])
            return num_str

        def get_header_level(_line: str) -> int:
            """Extract header level from Markdown line."""
            match = re.match(r"^(#+)", _line.strip())
            return len(match.group(1)) if match else 2

        lines = text.split("\n")
        result = []
        i = 0
        chapters_normalized = 0

        # Pre-compile all chapter detection regexes ONCE (not per-line)
        spelled_numbers = (
            "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty"
        )
        _re_pattern1 = re.compile(
            rf"^(#{{1,6}})\s*\*?\*?(?:CHAPTER|CHAP)\.?\s+([IVXLC]+|\d+|{spelled_numbers})\*?\*?(?:\s*[-:.]?\s*(.*))?$",
            re.IGNORECASE,
        )
        # Cat-E P2 v8: Pre-scan to build the set of chapter numbers that
        # have AN H1 CHAPTER MARKER WITH NON-TRIVIAL TITLE elsewhere in
        # the same document. Used by Pattern 6 below to reject plain-
        # text "Chapter N: Title" lines that are TOC entries OR body
        # cross-references redundant with an H1 chapter start. SPELLED
        # ordering must be LONGEST-FIRST to fix the alternation greedy
        # bug — without this, "Chapter Fourteen" matches "Four" before
        # "Fourteen" and the pre-scan sets the wrong chapter number.
        # Canonical: cc32d8f5 Alchemy of Dreams — 11 TOC entries at
        # L29-L147 were normalized to ## Chapter N: Title H2s,
        # driving current_chapter up to 11 before front-matter was
        # reached. Regression scan: 3 prior parse_done docs change,
        # all confirmed safe (chapter info preserved via H1 path).
        _spelled_longest_first = "|".join(
            sorted(
                [
                    "one",
                    "two",
                    "three",
                    "four",
                    "five",
                    "six",
                    "seven",
                    "eight",
                    "nine",
                    "ten",
                    "eleven",
                    "twelve",
                    "thirteen",
                    "fourteen",
                    "fifteen",
                    "sixteen",
                    "seventeen",
                    "eighteen",
                    "nineteen",
                    "twenty",
                ],
                key=len,
                reverse=True,
            )
        )
        _h1_ch_re_for_prescan = re.compile(
            rf"^#\s+(?:CHAPTER|CHAP)\.?\s+([IVXLC]+|\d+|{_spelled_longest_first})\s*[:\-.]?\s*(.*)$",
            re.IGNORECASE,
        )
        _h1_ch_nums_with_title: set[int] = set()
        for _ln in lines:
            _m_h1 = _h1_ch_re_for_prescan.match(_ln.strip())
            if not _m_h1:
                continue
            _h1_num_raw = (_m_h1.group(1) or "").lower().strip()
            _h1_title = (_m_h1.group(2) or "").strip()
            # Resolve to integer chapter number (roman/arabic/spelled).
            _resolved: int | None = None
            if _h1_num_raw in roman_to_int:
                _resolved = roman_to_int[_h1_num_raw]
            elif _h1_num_raw in word_to_int:
                _resolved = word_to_int[_h1_num_raw]
            else:
                try:
                    _resolved = int(_h1_num_raw)
                except ValueError:
                    _resolved = None
            if _resolved is not None and _h1_title and len(_h1_title) >= 4:
                _h1_ch_nums_with_title.add(_resolved)
        _skipped = 0
        _checked = 0

        while i < len(lines):
            line = lines[i]
            stripped = line.strip()

            # Fast skip: only lines containing 'CHAP' or starting with '#'
            if stripped and "chap" not in stripped[:30].lower() and stripped[0] != "#":
                result.append(line)
                i += 1
                _skipped += 1
                continue
            _checked += 1

            # Pattern 1: Single-line "## CHAPTER 1"
            single_match = _re_pattern1.match(stripped)
            if single_match:
                header_hashes = single_match.group(1)
                chapter_num = parse_chapter_number(single_match.group(2))
                chapter_title = single_match.group(3) or ""
                # Strip any leftover bold markers from title
                chapter_title = chapter_title.replace("**", "").strip()
                lines_consumed = 1  # At minimum, consume the current line

                # Look ahead for a separate title line (common in PDFs):
                # ## **Chapter 5**   ← current line (just matched)
                # # **TACTICAL DISPOSITIONS**   ← title on next line (H1)
                # This prevents MarkdownHeaderTextSplitter from losing chapter context
                # when an H1 title follows an H2 chapter marker.
                if not chapter_title:
                    for lookahead in range(1, 4):
                        if i + lookahead >= len(lines):
                            break
                        next_line = lines[i + lookahead].strip()
                        if not next_line:
                            continue
                        # Match any header line: # **TITLE** or # TITLE
                        title_match = re.match(r"^#{1,6}\s*\*?\*?(.*?)\*?\*?\s*$", next_line)
                        if title_match:
                            lookahead_title = title_match.group(1).strip()
                            if lookahead_title and not re.match(r"(?:CHAPTER|CHAP)\.?\s", lookahead_title, re.IGNORECASE):
                                chapter_title = lookahead_title
                                lines_consumed = lookahead + 1
                                logger.debug("Merged chapter title from next line: Chapter %s: %s", chapter_num, chapter_title)
                        break  # Stop after first non-blank line (whether matched or not)

                title_suffix = f": {chapter_title}" if chapter_title.strip() else ""
                result.append(f"{header_hashes} Chapter {chapter_num}{title_suffix}")
                chapters_normalized += 1
                logger.debug("Normalized single-line chapter: %s → Chapter %s%s", stripped[:50], chapter_num, title_suffix)
                i += lines_consumed
                continue

            # Pattern 2: Split format "## CHAPTER" followed by "## <number>" (with optional blank lines)
            # Matches: ## CHAPTER, ## CHAP, ## CHAPTER., ### CHAPTER, etc.
            if re.match(r"^#{1,6}\s*(?:CHAPTER|CHAP)\.?\s*$", stripped, re.IGNORECASE):
                header_level = get_header_level(stripped)
                matched_split = False

                # Look ahead up to 3 lines (to skip blank lines)
                for lookahead in range(1, 4):
                    if i + lookahead >= len(lines):
                        break
                    next_line = lines[i + lookahead].strip()

                    # Skip blank lines
                    if not next_line:
                        continue

                    # Check if the next non-blank line is a number (Arabic, roman, or spelled-out)
                    # Matches: ## 1, ### I, ## **2**, ###### IV, ## One, **Three**, etc.
                    number_match = re.match(
                        rf"^(?:#{{1,6}}\s*)?(?:\*\*)?([IVXLC]+|\d+|{spelled_numbers})(?:\*\*)?\s*$",
                        next_line,
                        re.IGNORECASE,
                    )
                    if number_match:
                        chapter_num = parse_chapter_number(number_match.group(1))
                        result.append(f"{'#' * header_level} Chapter {chapter_num}")
                        chapters_normalized += 1
                        logger.debug(
                            "Normalized split chapter (gap=%d): ## CHAPTER + %s → ## Chapter %s",
                            lookahead,
                            next_line,
                            chapter_num,
                        )
                        # Skip all lines up to and including the number line
                        i += lookahead + 1
                        matched_split = True
                        break
                    else:
                        # Non-blank, non-number line found - stop looking
                        break

                if not matched_split:
                    # No match found in lookahead, keep the original line
                    result.append(line)
                    i += 1
                continue

            # Pattern 3: Bold format "**CHAPTER**" followed by "**<number>**" (with optional blank lines)
            if re.match(r"^\*\*(?:CHAPTER|CHAP)\.?\*\*\s*$", stripped, re.IGNORECASE):
                matched_bold = False
                for lookahead in range(1, 4):
                    if i + lookahead >= len(lines):
                        break
                    next_line = lines[i + lookahead].strip()

                    if not next_line:
                        continue

                    number_match = re.match(r"^\*\*([IVXLC]+|\d+)\*\*\s*$", next_line, re.IGNORECASE)
                    if number_match:
                        chapter_num = parse_chapter_number(number_match.group(1))
                        result.append(f"## Chapter {chapter_num}")
                        chapters_normalized += 1
                        logger.debug("Normalized bold chapter: **CHAPTER** + **%s** → ## Chapter %s", next_line, chapter_num)
                        i += lookahead + 1
                        matched_bold = True
                        break
                    else:
                        break

                if not matched_bold:
                    result.append(line)
                    i += 1
                continue

            # Pattern 4: Italic format "*Chapter One*", "*Chapter 1*", "*Chapter IV*"
            # Also matches underscore italic: "_CHAPTER 1. TITLE_" (Project Gutenberg /
            # pymupdf4llm convention). Both `*..*` and `_.._` are valid markdown italics.
            # Common in EPUB-to-markdown conversions where chapters use italic markers.
            italic_match = re.match(
                rf"^\*(?:CHAPTER|CHAP)\.?\s+([IVXLC]+|\d+|{spelled_numbers})\*(?:\s*[-:.]?\s*(.*))?$",
                stripped,
                re.IGNORECASE,
            )
            if not italic_match:
                # Try underscore italic: "_CHAPTER 1. INTRODUCTION_"
                italic_match = re.match(
                    rf"^_(?:CHAPTER|CHAP)\.?\s+([IVXLC]+|\d+|{spelled_numbers})(?:\s*[-:.]?\s*([^_]*))?_\s*$",
                    stripped,
                    re.IGNORECASE,
                )
            if italic_match:
                chapter_num = parse_chapter_number(italic_match.group(1))
                chapter_title = (italic_match.group(2) or "").replace("*", "").replace("_", "").strip()
                lines_consumed = 1

                # Look ahead for a title on the next line (e.g., ALL CAPS title after chapter marker)
                if not chapter_title:
                    for lookahead in range(1, 4):
                        if i + lookahead >= len(lines):
                            break
                        next_line = lines[i + lookahead].strip()
                        if not next_line:
                            continue
                        # Non-blank line that looks like a title (ALL CAPS or short text, not a paragraph)
                        if len(next_line) < 80 and not next_line.endswith("."):
                            chapter_title = next_line.replace("*", "").replace("**", "").strip()
                            lines_consumed = lookahead + 1
                            logger.debug("Merged italic chapter title from next line: Chapter %s: %s", chapter_num, chapter_title)
                        break

                title_suffix = f": {chapter_title}" if chapter_title else ""
                result.append(f"## Chapter {chapter_num}{title_suffix}")
                chapters_normalized += 1
                logger.debug("Normalized italic chapter: %s → ## Chapter %s%s", stripped, chapter_num, title_suffix)
                i += lines_consumed
                continue

            # Pattern 5: Single-italic format "*CHAPTER*" followed by "*<number>*" (split across lines)
            if re.match(r"^\*(?:CHAPTER|CHAP)\.?\*\s*$", stripped, re.IGNORECASE):
                matched_italic_split = False
                for lookahead in range(1, 4):
                    if i + lookahead >= len(lines):
                        break
                    next_line = lines[i + lookahead].strip()
                    if not next_line:
                        continue
                    number_match = re.match(rf"^\*?([IVXLC]+|\d+|{spelled_numbers})\*?\s*$", next_line, re.IGNORECASE)
                    if number_match:
                        chapter_num = parse_chapter_number(number_match.group(1))
                        result.append(f"## Chapter {chapter_num}")
                        chapters_normalized += 1
                        logger.debug("Normalized split italic chapter: *CHAPTER* + %s → ## Chapter %s", next_line, chapter_num)
                        i += lookahead + 1
                        matched_italic_split = True
                        break
                    else:
                        break

                if not matched_italic_split:
                    result.append(line)
                    i += 1
                continue

            # Pattern 6: Plain text "CHAPTER 1" or "CHAPTER 1: Introduction" (no Markdown formatting)
            # Common in scanned PDFs where parser doesn't detect heading structure.
            # Also handles "CHAPTER" alone followed by number on next line.
            plain_single = re.match(
                rf"^(?:CHAPTER|CHAP)\.?\s+([IVXLC]+|\d+|{spelled_numbers})(?:\s*[-:.]?\s*(.*))?$",
                stripped,
                re.IGNORECASE,
            )
            # Sub-section cross-reference guard. Body prose lines starting
            # with "Chapter N.M ..." (e.g. "Chapter 1.3 (SFA) and..." —
            # text wrap from a sentence "see Chapter 1.3 ..." that put
            # "Chapter 1.3..." at the start of its line) match the regex
            # but are NOT chapter headings. Detect: source line literally
            # has "Chapter N.M" cross-reference pattern (digit dot digit).
            # Legit "Chapter 1. Introduction" has space after the period,
            # not a digit. Confirmed signal-3+ on e4e8b05b (Forest
            # Resources Russia, 3 polluted titles), ac47a5ad, and others.
            if plain_single and re.match(r"^(?:CHAPTER|CHAP)\.?\s+\d+\.\d", stripped, re.IGNORECASE):
                plain_single = None
            # Body-prose stop-word guard. Body sentences like "Chapter 3.
            # Countries, or groups of countries, can have market power in"
            # (8136f0cf Farm wars line 5404) match the regex syntactically
            # but the captured "title" is a sentence fragment ending in a
            # preposition / conjunction / article. Pattern C in
            # document_processor.py already rejects this shape; same
            # guard is needed here in chunker Pattern 6 because it runs
            # FIRST (synthetic header injection) and persists into
            # MarkdownHeaderTextSplitter metadata.
            if plain_single:
                _trail_raw = (plain_single.group(2) or "").strip().rstrip(".,;:!?")
                # Punctuation-start reject. Body sentences wrapping
                # "see Chapter N). next-clause..." or "Chapter N. (continued)"
                # produce title starting with ")", "(", ".", ",", ";", ":".
                # Real chapter titles start alphanumeric / quote /
                # opening dash. Mirrors the existing Pattern 1 guard at
                # line 2214 in _extract_hierarchy_metadata.
                if _trail_raw and _trail_raw[0] in ".,;:)]([":
                    plain_single = None
            if plain_single:
                _trail_raw = (plain_single.group(2) or "").strip().rstrip(".,;:!?")
                if _trail_raw and len(_trail_raw) >= 4:
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
                    _last = _trail_raw.split()[-1].lower() if _trail_raw.split() else ""
                    if _last in _stop:
                        plain_single = None
            # Cat-E P2 v8: H1-redundancy rejection. When an H1 chapter
            # marker with NON-TRIVIAL title (≥4 chars) for the SAME
            # chapter number exists elsewhere in this document, the
            # plain-text "Chapter N: Title" line is redundant — it's
            # either a TOC entry (clustered near doc top before the
            # real chapter starts) OR a body cross-reference
            # ("Chapter 14)" type). Emitting `## Chapter N: ...` from
            # such lines either pollutes the chapter assignment when
            # the TOC drives current_chapter ahead of front-matter
            # (cc32d8f5 ch=11 swallowed 17 Preface/Introduction chunks)
            # OR creates dual H1+H2 markers where MHTS prefers H2 but
            # H2 is empty (cc32d8f5 ch=5 lost "Language of the Soul"
            # title). Regression scan: 3 prior parse_done docs change
            # (07bc9b9e, 4723c542, c37828be) — all confirmed safe
            # (chapter info preserved via H1 path).
            if plain_single:
                _my_num_raw = (plain_single.group(1) or "").lower().strip()
                _my_resolved: int | None = None
                if _my_num_raw in roman_to_int:
                    _my_resolved = roman_to_int[_my_num_raw]
                elif _my_num_raw in word_to_int:
                    _my_resolved = word_to_int[_my_num_raw]
                else:
                    try:
                        _my_resolved = int(_my_num_raw)
                    except ValueError:
                        _my_resolved = None
                if _my_resolved is not None and _my_resolved in _h1_ch_nums_with_title:
                    plain_single = None
            # Cat-E P3: Lowercase-title rejection. Body cross-references
            # like "Chapter 9 for more information" (cc32d8f5 line 5432)
            # match the regex but the captured title starts with a
            # lowercase preposition/article. Real chapter titles ALWAYS
            # start with uppercase letter, digit, or quote. Catches
            # body-prose false positives that survive the stop-word
            # guard (e.g. "Chapter N discusses the topic..." — "discusses"
            # is not in the stop set but the title is body prose).
            # 21-doc regression scan confirmed: every hit is a confirmed
            # body cross-reference; zero false rejections of real chapters.
            if plain_single:
                _trail_raw_p3 = (plain_single.group(2) or "").strip()
                if _trail_raw_p3 and _trail_raw_p3[0].isalpha() and _trail_raw_p3[0].islower():
                    plain_single = None
            if plain_single:
                chapter_num = parse_chapter_number(plain_single.group(1))
                chapter_title = (plain_single.group(2) or "").strip()
                lines_consumed = 1

                # Look ahead for title on next line (e.g., "CHAPTER 1\nINTRODUCTION")
                if not chapter_title:
                    for lookahead in range(1, 4):
                        if i + lookahead >= len(lines):
                            break
                        next_line = lines[i + lookahead].strip()
                        if not next_line:
                            continue
                        if next_line.lstrip().startswith("#"):
                            break
                        if len(next_line) < 80 and not next_line.endswith(".") and not next_line[0].islower():
                            chapter_title = next_line.replace("*", "").replace("**", "").strip()
                            lines_consumed = lookahead + 1
                        break

                title_suffix = f": {chapter_title}" if chapter_title else ""
                result.append(f"## Chapter {chapter_num}{title_suffix}")
                chapters_normalized += 1
                logger.debug("Normalized plain-text chapter: %s → ## Chapter %s%s", stripped, chapter_num, title_suffix)
                i += lines_consumed
                continue

            # Pattern 7: Plain text "CHAPTER" alone, followed by number on next line
            if re.match(r"^(?:CHAPTER|CHAP)\.?\s*$", stripped, re.IGNORECASE):
                matched_plain_split = False
                for lookahead in range(1, 4):
                    if i + lookahead >= len(lines):
                        break
                    next_line = lines[i + lookahead].strip()
                    if not next_line:
                        continue
                    number_match = re.match(rf"^([IVXLC]+|\d+|{spelled_numbers})\s*$", next_line, re.IGNORECASE)
                    if number_match:
                        chapter_num = parse_chapter_number(number_match.group(1))
                        result.append(f"## Chapter {chapter_num}")
                        chapters_normalized += 1
                        i += lookahead + 1
                        matched_plain_split = True
                        break
                    else:
                        break

                if not matched_plain_split:
                    result.append(line)
                    i += 1
                continue

            result.append(line)
            i += 1

        logger.info(
            "_normalize_chapter_markers: %d lines total, %d skipped, %d checked, %d normalized",
            len(lines),
            _skipped,
            _checked,
            chapters_normalized,
        )
        if chapters_normalized > 0:
            logger.info("📖 Normalized %d split-format chapter markers", chapters_normalized)

        return "\n".join(result)

    @staticmethod
    def _inject_chapter_markers_lightweight(text: str) -> str:
        """Cheap O(n) pre-splitter normalisations that ALWAYS run, regardless
        of document size. The split-format normaliser in
        ``_normalize_chapter_markers`` is gated by a 500 K-char guard because
        its line-by-line state machine has a high constant factor; these two
        regex passes do not.

        Step 2: inline ``CHAPTER N. Title`` injection. Some EPUB / flat-
        markdown sources have ZERO MarkdownHeaderTextSplitter-recognisable
        headers (no ``#``, no ALL-CAPS standalone, no ``**CHAPTER**``) but
        DO have inline ``CHAPTER N. Title`` runs sitting in the middle of
        paragraph prose. Without intervention the splitter produces one
        mega-chunk that swallows several whole chapters and downstream
        ``_assign_cross_page_chapter_metadata`` then attributes the entire
        mass to "Chapter 1" with a polluted title that's actually body
        text.

        Step 3: split-TOC merge. Some PDF→markdown extractors (pymupdf4llm
        at certain page widths) split a multi-line chapter heading across
        an H3 line and a following H1 line whose tail carries the chapter
        number, e.g. ``### Sow welfare in the farrowing`` followed by
        ``# crate and alternatives 2``. Treated naively the H1 is the
        primary header and the chunker ends up with "crate and
        alternatives 2" as the chapter title; downstream chapter coverage
        scrambles. Merge the two fragments into one proper
        ``## CHAPTER N. Full Title``.

        Both regexes are idempotent — already-prefixed ``## CHAPTER`` lines
        and already-merged headers don't match.
        """
        # Line-anchored CHAPTER detector. `\s+` would let the regex span a
        # paragraph boundary (\n is part of \s), so a body footnote like
        # "in Chapter 11.\nIndeed, aspects of multifunctional…" was matched
        # as `CHAPTER 11. Indeed, aspects…` and injected as a fake H2
        # header. The `skip_content_match` gate then promoted these
        # injections OVER the real H1 chapters and collapsed 12-chapter
        # books to 3 distinct chapter_number entries.
        # Tightening: require space/tab (not arbitrary whitespace) between
        # `N.` and the title, and exclude both \n and \r from the title
        # char-class. Regression scan over 105 parse_done docs (2026-05-15):
        # 13 docs hit the loose regex (d653d4fc=18 injections, 604ae877=4,
        # d99842c7=3, 3618fc43=3, …) — every drop is a body footnote with
        # no real chapter heading lost. Live re-chunk of 3618fc43 with the
        # tightened regex: 3 → 13 distinct chapter_number (all 12 real H1
        # + 1 introduction). See systemic_blockers entry
        # INJECT_CHAPTER_MARKERS_LIGHTWEIGHT_BODY_PROSE_CROSS_NEWLINE.
        inline_re = re.compile(
            r"(?<!\n## )(?<!\n)\bCHAPTER\s+(\d{1,2}|[IVXLC]{1,5})\.[ \t]+([A-Z][^.\n\r]{4,80})",
            re.IGNORECASE,
        )

        # Set of chapter numbers that ALREADY exist as a real `## Chapter N` /
        # `# Chapter N` heading in the (post-normalize) text. A plain `## N.`
        # numbered header is also counted. The inject pass exists to RECOVER
        # chapter boundaries that the splitter can't see; injecting a chapter
        # number that already has a real header only ever duplicates — and the
        # match is almost always a body-prose mention ("...discussed in chapter
        # 13. Here I will note...") rather than a genuine inline heading. So we
        # suppress per-hit when the number is already covered, instead of a
        # document-wide skip. The document-wide skip (below) was too coarse:
        # books like 4710bf45 (Calakmul) have only 3 surviving `## Chapter N`
        # headers (noisy OCR) yet rely on the inject pass to recover chapters
        # 3/4/5 from genuine inline ALL-CAPS headings — a blanket skip there
        # would lose real chapters. Per-hit suppression keeps those while still
        # killing the Passport-to-the-Cosmos "chapter 13" body-mention.
        _covered_chapter_nums: set[str] = set()
        for _m in re.finditer(
            r"^#{1,2}\s+(?:Chapter\s+)?(\d{1,2}|[IVXLC]{1,5})[:.]",
            text,
            re.MULTILINE | re.IGNORECASE,
        ):
            _covered_chapter_nums.add(_m.group(1).upper())

        def _inject(match: re.Match[str]) -> str:
            num = match.group(1).upper()
            title = match.group(2).strip().rstrip(",;:")
            # Already have a real header for this chapter number → the match is
            # a body-prose mention, not a heading. Leave the text untouched.
            if num in _covered_chapter_nums:
                return match.group(0)
            return f"\n\n## CHAPTER {num}. {title}\n\n"

        # Skip inline-CHAPTER injection when the document already has clean
        # numbered H2 chapter markers (`## 1. Title`, `## 2. Title` …).
        # The inject pass exists for books with ZERO splitter-recognisable
        # headings; running it on a doc that already chapters cleanly turns
        # body footnotes ("Chapter 5 below. See generally…") into phantom
        # chapter headings (observed on `e1f308be` Agriculture and the WTO,
        # which has 6 real `## N. Title` H2 markers AND 3 footnote
        # references that the regex over-matched as fake chapters).
        existing_h2_chapters = len(re.findall(r"^##\s+\d{1,2}\.\s+", text, re.MULTILINE))
        # Extend the guard: docs with native `# Chapter N` H1 markers
        # (the typical EPUB / fiction shape) also have no need for the
        # body-line inject pass. Verified on doc cc32d8f5 The Alchemy of
        # Dreams 2026-05-29: pre-splitter regex over-matched the body
        # line `possible themes in chapter 9. Regardless of the
        # symbolism in the` at source L7316 and injected a fake H2
        # `## CHAPTER 9. Regardless of the symbolism in the`, which
        # then propagated as chapter_title onto 5 chunks plus a
        # document_hierarchy root key plus a Cat-G summary. The doc
        # has 11 native `# Chapter N: Title` H1s — they already give
        # the splitter every chapter boundary it needs.
        existing_h1_chapters = len(
            re.findall(
                r"^#\s+(?:CHAPTER|Chapter|chapter)\s+(?:\d+|[IVXLC]+)\b",
                text,
                re.MULTILINE,
            )
        )
        if existing_h2_chapters >= 3 or existing_h1_chapters >= 3:
            injected_text, inline_count = text, 0
            logger.debug(
                "Skipping inline-CHAPTER injection: %d H2 + %d H1 numbered chapters already present",
                existing_h2_chapters,
                existing_h1_chapters,
            )
        else:
            injected_text, inline_count = inline_re.subn(_inject, text)
            if inline_count > 0:
                logger.info(
                    "📖 Injected %d inline-CHAPTER MD headers so splitter can cut on them",
                    inline_count,
                )

        split_toc_re = re.compile(
            r"^### (\S[^\n]{4,60})\n\s*# ([^\n]{1,40})\s+(\d{1,2})\s*$",
            re.MULTILINE,
        )

        def _merge_split_toc(match: re.Match[str]) -> str:
            h3_part = match.group(1).strip().rstrip(":,;-")
            h1_part = match.group(2).strip().rstrip(":,;-")
            num = match.group(3)
            return f"\n\n## CHAPTER {num}. {h3_part} {h1_part}\n\n"

        merged_text, merge_count = split_toc_re.subn(_merge_split_toc, injected_text)
        if merge_count > 0:
            logger.info(
                "📖 Merged %d split-TOC chapter fragments (### + # → ## CHAPTER N. ...)",
                merge_count,
            )

        # Step 4: EPUB-link ToC detection. EPUB→md conversion turns each ToC
        # entry into a markdown link `[**N TITLE**](file.xhtml#anchor)`, which
        # the splitter cannot use as a heading anchor. Detect a cluster of ≥3
        # such links with sequential numbering, then promote each to a
        # `## N. TITLE` header so MarkdownHeaderTextSplitter can cut on them.
        # Strict gates mirror Tier 3.5: tight cluster (≤100 lines apart),
        # numbering monotonic with gap ≤ 3, range coherent (max-min ≤ len*2).
        epub_link_re = re.compile(
            r"^\s*\[\s*\*\*\s*(\d{1,2})\s+([^\]\*\n]{2,80}?)\s*\*\*\s*\]\([^)]+\.xhtml(?:#[^)]*)?\)\s*$",
            re.MULTILINE,
        )
        epub_candidates: list[tuple[int, int, str]] = []
        for m in epub_link_re.finditer(merged_text):
            try:
                ch_num = int(m.group(1))
            except (TypeError, ValueError):
                continue
            if not (1 <= ch_num <= 50):
                continue
            title = m.group(2).strip().rstrip(",;:.")
            if title and len(title) >= 3:
                epub_candidates.append((m.start(), ch_num, title))

        if len(epub_candidates) >= 3:
            # Cluster check: number gap ≤ 3 between consecutive entries
            best_cluster: list[tuple[int, int, str]] = []
            for start_idx in range(len(epub_candidates)):
                cluster = [epub_candidates[start_idx]]
                for next_idx in range(start_idx + 1, len(epub_candidates)):
                    num_diff = epub_candidates[next_idx][1] - cluster[-1][1]
                    if 0 <= num_diff <= 3:
                        cluster.append(epub_candidates[next_idx])
                if len(cluster) > len(best_cluster):
                    best_cluster = cluster

            nums = [c[1] for c in best_cluster]
            coherent = len(best_cluster) >= 3 and (max(nums) - min(nums)) <= len(best_cluster) * 2
            if coherent:
                # Replace each accepted EPUB link with a `## N. TITLE` header
                # so the ToC itself becomes navigable.
                accepted_offsets = {c[0]: (c[1], c[2]) for c in best_cluster}

                def _epub_replace(m: re.Match[str]) -> str:
                    if m.start() not in accepted_offsets:
                        return m.group(0)
                    num, title = accepted_offsets[m.start()]
                    return f"\n\n## {num}. {title}\n\n"

                merged_text = epub_link_re.sub(_epub_replace, merged_text)
                logger.info(
                    "📖 Step 4: promoted %d EPUB-link ToC entries to `## N. Title` headers",
                    len(best_cluster),
                )

                # Step 4b: scan body for first bold occurrence of each
                # extracted chapter title and promote those too. Without
                # this the splitter sees 12 `## N. Title` markers all in the
                # ToC section + one giant 340K-char body section. Body
                # promotion gives the splitter real chapter boundaries.
                # Strict: only first occurrence per title is promoted, AFTER
                # the ToC area (offset > last accepted_offset), so we don't
                # touch the ToC itself.
                last_toc_offset = max(accepted_offsets.keys())
                body_promoted = 0
                for _, ch_num, ch_title in best_cluster:
                    # Search body (after ToC area) for `**TITLE**` occurrence
                    body_re = re.compile(
                        r"^\*\*\s*" + re.escape(ch_title) + r"\s*\*\*\s*$",
                        re.MULTILINE | re.IGNORECASE,
                    )
                    m_body = body_re.search(merged_text, pos=last_toc_offset + 1)
                    if m_body:
                        merged_text = merged_text[: m_body.start()] + f"\n\n## {ch_num}. {ch_title}\n\n" + merged_text[m_body.end() :]
                        body_promoted += 1
                if body_promoted > 0:
                    logger.info(
                        "📖 Step 4b: promoted %d body bold-title occurrences to `## N. Title` headers (chapter boundaries)",
                        body_promoted,
                    )

        # Step 5: deep-header Chapter promotion. Some PDF→md extractors
        # emit chapter heads at H3/H4/H5/H6 instead of H1/H2 (BAR series
        # convention uses H5 `##### **Chapter One – Title**`, etc.).
        # MarkdownHeaderTextSplitter still splits on those, but the
        # downstream `_extract_hierarchy_metadata` auto-promoter reads
        # only Header 1 / Header 2, so the chapter signal is silently
        # dropped. Rewrite each deep-header bold Chapter marker to
        # `## CHAPTER N. Title` so the standard chapter detection
        # path picks them up.
        #
        # Canonical case: 6b3e7878 'Early Medieval Agriculture in
        # Ireland' (1.59 MB, 6 H5 chapter markers `##### **Chapter
        # One – The Farming Landscape …**` … `Chapter Three`). Without
        # this step the chunker collapsed to 2 chapters.
        #
        # Strict gates (verified safe against a 231-doc regression
        # scan — exactly 2 hits: the target Early Medieval doc and
        # Natural Beekeeping which fails on position):
        #   (1) ≥3 distinct chapter numbers
        #   (2) FIRST appearance ≤30 % of doc — rejects back-of-book
        #       Chapter cross-reference lists (Natural Beekeeping
        #       eb9e546a has H4 Chapter markers clustered at line 3062
        #       of ~3500, i.e. 87 % — gets rejected)
        #   (3) Bold-wrapped + `Chapter <num/word/roman> <sep> <title>`
        #       full form — body mentions like `chapter 5 below` lack
        #       the bold + separator + title and never match.
        deep_header_re = re.compile(
            r"^(?P<hashes>#{3,6})\s+\*\*\s*Chapter\s+"
            r"(?P<num>\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|"
            r"eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[IVXLC]+)"
            r"\s*[–—\-:]\s*(?P<title>[^*\n]{3,200}?)\s*\*\*\s*$",
            re.MULTILINE | re.IGNORECASE,
        )
        deep_word_to_num = {
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
        deep_roman_to_num = {
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
        deep_candidates: list[tuple[int, int, str]] = []
        for m in deep_header_re.finditer(merged_text):
            raw = m.group("num").lower()
            if raw.isdigit():
                num = int(raw)
            elif raw in deep_word_to_num:
                num = deep_word_to_num[raw]
            elif raw in deep_roman_to_num:
                num = deep_roman_to_num[raw]
            else:
                continue
            if 1 <= num <= 50:
                deep_candidates.append((m.start(), num, m.group("title").strip()))

        if len({c[1] for c in deep_candidates}) >= 3 and merged_text:
            _doc_len = max(len(merged_text), 1)
            _first_pct = deep_candidates[0][0] / _doc_len
            if _first_pct <= 0.30:
                # Promote each H3-H6 bold Chapter marker to H2.
                def _promote_deep_chapter(match: re.Match[str]) -> str:
                    raw = match.group("num").lower()
                    if raw.isdigit():
                        n = int(raw)
                    elif raw in deep_word_to_num:
                        n = deep_word_to_num[raw]
                    elif raw in deep_roman_to_num:
                        n = deep_roman_to_num[raw]
                    else:
                        return match.group(0)
                    title = match.group("title").strip()
                    return f"\n\n## CHAPTER {n}. {title}\n\n"

                merged_text, deep_count = deep_header_re.subn(_promote_deep_chapter, merged_text)
                if deep_count > 0:
                    logger.info(
                        "📖 Step 5: promoted %d H3-H6 bold-Chapter markers to `## CHAPTER N. Title` headers (deep-header chapter axis)",
                        deep_count,
                    )

        # Step 6: number-only H3 + title-on-next-line H5 pattern.
        # Some publishers (OUP encyclopedic volumes, e.g. Hamilton 2015
        # 'Ecology of Agricultural Landscapes' baf798b3) emit chapter
        # heads as a number-only H3 followed by an H5 title on the next
        # non-empty line:
        #     ### **1**
        #     ##### Climate Trends in Long-Term Ecological Research Plots
        # Neither Step 5 (requires literal `Chapter N – Title`) nor the
        # standard Pattern A-D matches this split shape. Merge the two
        # into a `## CHAPTER N. Title` header so the standard chapter
        # detection picks them up.
        #
        # Strict gates (verified safe on a 231-doc regression scan —
        # exactly 1 hit: the target Hamilton 2015 doc):
        #   (1) ≥3 distinct chapter numbers
        #   (2) FIRST appearance ≤30 % of doc
        #   (3) H3 line must be exactly `### **N**` (bold number alone,
        #       no extra text — rejects body H3s)
        #   (4) Next non-empty line must be an H5 with title text
        number_only_h3_re = re.compile(
            r"^###\s+\*\*\s*"
            r"(?P<num>\d{1,3}|[IVXLC]+|one|two|three|four|five|six|seven|eight|nine|ten|"
            r"eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)"
            r"\s*\*\*\s*\n+\s*\n?"
            r"#{4,6}\s+(?P<title>[^\n]{3,200})\s*$",
            re.MULTILINE | re.IGNORECASE,
        )
        p6_candidates: list[tuple[int, int, str]] = []
        for m in number_only_h3_re.finditer(merged_text):
            raw = m.group("num").lower()
            if raw.isdigit():
                num = int(raw)
            elif raw in deep_word_to_num:
                num = deep_word_to_num[raw]
            elif raw in deep_roman_to_num:
                num = deep_roman_to_num[raw]
            else:
                continue
            if 1 <= num <= 50:
                p6_candidates.append((m.start(), num, m.group("title").strip()))

        if len({c[1] for c in p6_candidates}) >= 3 and merged_text:
            _doc_len = max(len(merged_text), 1)
            _first_pct = p6_candidates[0][0] / _doc_len
            if _first_pct <= 0.30:

                def _promote_number_only(match: re.Match[str]) -> str:
                    raw = match.group("num").lower()
                    if raw.isdigit():
                        n = int(raw)
                    elif raw in deep_word_to_num:
                        n = deep_word_to_num[raw]
                    elif raw in deep_roman_to_num:
                        n = deep_roman_to_num[raw]
                    else:
                        return match.group(0)
                    title = match.group("title").strip()
                    return f"\n\n## CHAPTER {n}. {title}\n\n"

                merged_text, p6_count = number_only_h3_re.subn(_promote_number_only, merged_text)
                if p6_count > 0:
                    logger.info(
                        "📖 Step 6: merged %d number-only H3 + H5-title pairs into `## CHAPTER N. Title` headers (split-header chapter axis)",
                        p6_count,
                    )

        # Step 7: H6 `Chapter N` + H4 title pattern. Some Springer /
        # Kluwer academic volumes ('Economics of Sustainable Energy in
        # Agriculture' f4f05a98) emit chapter
        # heads as:
        #     ###### **Chapter N**
        #
        #     #### **TITLE**
        # where the chapter NUMBER lives in H6 and the title in H4 on
        # the next non-empty line. Pattern 5/6 do not catch this
        # specific shape. Without it the chunker collapses to ~4
        # chapters from 16 real chapter markers.
        #
        # Strict gates (regression scan: 3 hits in 231 docs, all real
        # academic books with sole-axis H6 chapters at front of book):
        #   (1) ≥5 `###### **Chapter N**` lines
        #   (2) Zero H1/H2 lines matching `Chapter N` pattern (H6 is
        #       the SOLE chapter axis — when H1/H2 already chapter
        #       cleanly, Step 7 does not fire)
        #   (3) FIRST H6 chapter appears in first 30 % of doc (rejects
        #       back-of-book Chapter cross-reference sections)
        #   (4) H6 followed by H4 with title (skip H6-only with no
        #       following title — those would emit `## CHAPTER N. `
        #       with no real title)
        h6_chapter_re = re.compile(
            r"^######\s+\*\*\s*Chapter\s+"
            r"(?P<num>\d{1,3}|[IVXLC]+|one|two|three|four|five|six|seven|eight|nine|ten|"
            r"eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)"
            r"\s*\*\*\s*\n+\s*"
            r"#{3,4}\s+(?P<title>[^\n]{3,200}?)\s*$",
            re.MULTILINE | re.IGNORECASE,
        )
        # Gate 2: any H1/H2 line with literal "chapter N" word?
        h1_h2_chapter_existing = re.search(
            r"^#{1,2}\s+\*?\*?\s*Chapter\s+\d+",
            merged_text,
            re.MULTILINE | re.IGNORECASE,
        )
        if not h1_h2_chapter_existing:
            p7_candidates: list[tuple[int, int, str]] = []
            for m in h6_chapter_re.finditer(merged_text):
                raw = m.group("num").lower()
                if raw.isdigit():
                    num = int(raw)
                elif raw in deep_word_to_num:
                    num = deep_word_to_num[raw]
                elif raw in deep_roman_to_num:
                    num = deep_roman_to_num[raw]
                else:
                    continue
                if 1 <= num <= 50:
                    p7_candidates.append((m.start(), num, m.group("title").strip()))

            if len({c[1] for c in p7_candidates}) >= 5 and merged_text:
                _doc_len = max(len(merged_text), 1)
                _first_pct = p7_candidates[0][0] / _doc_len
                if _first_pct <= 0.30:

                    def _promote_h6_chapter(match: re.Match[str]) -> str:
                        raw = match.group("num").lower()
                        if raw.isdigit():
                            n = int(raw)
                        elif raw in deep_word_to_num:
                            n = deep_word_to_num[raw]
                        elif raw in deep_roman_to_num:
                            n = deep_roman_to_num[raw]
                        else:
                            return match.group(0)
                        title = match.group("title").strip()
                        # Strip stray bold/italic markers — title may be split
                        # across multiple `**...**` runs (e.g. `**SUSTAINABLE
                        # ENERGY:** **ISSUES AND SCOPE**`) and the loose
                        # regex captures everything between `#### ` and the
                        # line break. Collapse whitespace too.
                        title = re.sub(r"\*+", " ", title)
                        title = normalize_whitespace(title)
                        return f"\n\n## CHAPTER {n}. {title}\n\n"

                    merged_text, p7_count = h6_chapter_re.subn(_promote_h6_chapter, merged_text)
                    if p7_count > 0:
                        logger.info(
                            "📖 Step 7: merged %d H6 `Chapter N` + H3/H4 title pairs into `## CHAPTER N. Title` headers (academic-book sole-H6-axis)",
                            p7_count,
                        )

        return merged_text

    @staticmethod
    def _normalize_bold_headers(text: str) -> str:
        """
        Convert bold-only lines to Markdown headers for better section detection.

        PDF-to-Markdown conversion often produces bold text like "**LAYING PLANS**"
        instead of proper Markdown headers "## LAYING PLANS". The MarkdownHeaderTextSplitter
        only detects "#"-prefixed headers, so these bold lines get missed entirely,
        resulting in generic "Section 1" headings for 84%+ of chunks.

        Uses frequency analysis to skip running headers: a bold line appearing 3+ times
        is a repeated PDF running header (e.g., "**BAR**"), not a real section heading.

        Args:
            text: Input text with potential bold-only lines

        Returns:
            Text with bold-only lines converted to Markdown headers
        """
        # Skip bold-normalize entirely when the doc has an EPUB-link ToC
        # cluster (`[**N TITLE**](file.xhtml#anchor)` runs of ≥3). The
        # downstream `_inject_chapter_markers_lightweight` Step 4 promotes
        # those entries to authoritative `## N. Title` headers; running
        # bold-normalize on the same doc would convert every body
        # `**Sub-heading**` to a phantom chapter (159 chapters observed on
        # 73e41a83 'Keeping Chickens' before this gate).
        epub_toc_signal = re.compile(
            r"^\s*\[\s*\*\*\s*\d{1,2}\s+[^\]\*\n]{2,80}?\s*\*\*\s*\]\([^)]+\.xhtml(?:#[^)]*)?\)",
            re.MULTILINE,
        )
        if len(epub_toc_signal.findall(text)) >= 3:
            logger.info(
                "Skipping bold-normalize: EPUB-link ToC cluster detected (Step 4 will promote)",
            )
            return text

        lines = text.split("\n")

        # Pre-compile regex ONCE
        _bold_re = re.compile(r"^\*\*([^*]+)\*\*\s*$")
        _chapter_re = re.compile(r"^(?:CHAPTER|CHAP)\.?\s", re.IGNORECASE)

        # Count bold line occurrences — repeated bold lines are running headers, not sections
        # For large docs, sample to avoid slow counting
        from collections import Counter

        bold_counts: Counter = Counter()
        sample_step = max(1, len(lines) // 10000)
        for idx in range(0, len(lines), sample_step):
            m = _bold_re.match(lines[idx].strip())
            if m:
                bold_counts[m.group(1).strip()] += 1
        freq_threshold = max(2, 3 // sample_step)

        normalized = []
        conversions = 0

        for line in lines:
            stripped = line.strip()
            match = _bold_re.match(stripped)
            if match:
                header_text = match.group(1).strip()
                # Length floor: single-letter `**A**`...`**Z**` are alphabetical
                # INDEX entries, not section headings. Pure-digit `**1**` are
                # standalone chapter-page-numbers from EPUB layouts where the
                # number sits on its own line above the title — promoting them
                # creates one phantom chapter per page (159-chapter pollution
                # observed on 73e41a83 'Keeping Chickens', 2019).
                if (
                    4 <= len(header_text) < 80
                    and not header_text.isdigit()
                    and not header_text.endswith(".")
                    and not _chapter_re.match(header_text)
                    and bold_counts.get(header_text, 0) < freq_threshold
                ):
                    normalized.append(f"## {header_text}")
                    conversions += 1
                    continue
            normalized.append(line)

        if conversions > 0:
            logger.info("Converted %d bold-only lines to Markdown headers for section detection", conversions)

        return "\n".join(normalized)

    def _apply_semantic_splitting(self, text: str) -> list[str]:
        """
        Apply semantic splitting to a section of text.

        Args:
                text: The section text to split

        Returns:
                A list of semantically coherent chunks
        """
        if not self.embedding_fn:
            return self._recursive_split(text)

        # Split text into sentences
        sentences = re.split(r"(?<=[.!?])\s+", text)
        if len(sentences) <= 1:
            return [text]

        try:
            # Generate embeddings for each sentence
            embeddings = [self.embedding_fn(sentence) for sentence in sentences]

            # Compute similarity between consecutive sentences
            similarities = [self._cosine_similarity(embeddings[i], embeddings[i + 1]) for i in range(len(embeddings) - 1)]

            # Find breakpoints where similarity drops significantly
            breakpoints = self._compute_breakpoints(similarities)

            # Create chunks based on breakpoints
            chunks = []
            start_idx = 0

            for bp in sorted(breakpoints):
                if bp > start_idx:
                    chunk_sentences = sentences[start_idx : bp + 1]
                    chunks.append(" ".join(chunk_sentences))
                    start_idx = bp + 1

            # Add the last chunk if needed
            if start_idx < len(sentences):
                chunks.append(" ".join(sentences[start_idx:]))

            return chunks

        except (ValueError, TypeError, AttributeError, IndexError) as e:
            logger.error("Error in semantic splitting: %s", str(e))
            return self._recursive_split(text)

    @staticmethod
    def _compute_breakpoints(similarities: list[float], percentile: float = 10) -> list[int]:
        """
        Compute breakpoints based on similarity drops.

        Args:
                similarities: A list of similarity scores between consecutive sentences
                percentile: The percentile threshold for identifying breakpoints (lower = more splits)

        Returns:
                A list of indices where to split
        """
        if not similarities:
            return []

        # Calculate similarity drops
        similarity_drops = [similarities[i] - similarities[i + 1] if i + 1 < len(similarities) else 0 for i in range(len(similarities) - 1)]

        if not similarity_drops:
            return []

        # Find threshold using percentile
        threshold = float(np.percentile(similarity_drops, 100 - percentile))

        # Find breakpoints where similarity drops significantly
        breakpoints = [i for i, drop in enumerate(similarity_drops) if drop > threshold]

        return breakpoints

    def _recursive_split(self, text: str) -> list[str]:
        """
        Recursively split text based on paragraph breaks, then sentences if needed.
        Enhanced to respect paragraph boundaries and avoid mid-paragraph breaks.

        Args:
                text: The text to split

        Returns:
                A list of chunks
        """
        # Split by double newlines (paragraph breaks)
        paragraphs = re.split(r"\n\s*\n", text)

        chunks = []
        current_chunk = ""

        for paragraph in paragraphs:
            paragraph = paragraph.strip()
            if not paragraph:
                continue

            # If adding this paragraph would exceed the chunk size (in tokens)
            combined_text = current_chunk + "\n\n" + paragraph if current_chunk else paragraph
            combined_tokens = self.count_tokens(combined_text)

            if combined_tokens > self.chunk_size:
                # Save the current chunk if it has content
                if current_chunk:
                    chunks.append(current_chunk.strip())

                # If the paragraph itself is too large, split it by sentences
                paragraph_tokens = self.count_tokens(paragraph)
                if paragraph_tokens > self.chunk_size:
                    sentence_chunks = self._split_by_sentences(paragraph)
                    chunks.extend(sentence_chunks[:-1])  # Add all but last
                    current_chunk = sentence_chunks[-1] if sentence_chunks else ""
                else:
                    current_chunk = paragraph
            else:
                # Add paragraph to current chunk
                if current_chunk:
                    current_chunk += "\n\n" + paragraph
                else:
                    current_chunk = paragraph

        # Add the last chunk
        if current_chunk:
            chunks.append(current_chunk.strip())

        return chunks if chunks else [text]

    def _split_by_sentences(self, text: str) -> list[str]:
        """
        Split text by sentences when paragraphs are too large.

        Args:
                text: The text to split

        Returns:
                A list of sentence-based chunks
        """
        # Split by sentence boundaries
        sentences = re.split(r"(?<=[.!?])\s+", text)

        chunks = []
        current_chunk = ""

        for sentence in sentences:
            # Check token count instead of character length
            combined_text = current_chunk + " " + sentence if current_chunk else sentence
            combined_tokens = self.count_tokens(combined_text)

            if combined_tokens > self.chunk_size:
                if current_chunk:
                    chunks.append(current_chunk.strip())
                current_chunk = sentence
            else:
                current_chunk = combined_text

        if current_chunk:
            chunks.append(current_chunk.strip())

        return chunks if chunks else [text]

    def _enforce_size_constraints_with_metadata(self, chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """
        Enforce size constraints while properly propagating metadata.
        - When splitting a chunk, propagate the parent's metadata to all children
        - When merging chunks, use the first chunk's metadata

        Args:
            chunks: A list of chunk dictionaries with text and metadata

        Returns:
            A list of chunks meeting size constraints with correct metadata
        """
        if not chunks:
            return []

        # Step 1: Merge small chunks while preserving metadata
        merged_chunks = []
        current_merged = None

        min_chunk_size = self.chunk_size // 4  # 25% of target size

        for chunk in chunks:
            chunk_tokens = self.count_tokens(chunk["text"])

            if chunk_tokens >= min_chunk_size:
                # Chunk is large enough, flush any pending merge and add this chunk
                if current_merged:
                    merged_chunks.append(current_merged)
                    current_merged = None
                merged_chunks.append(chunk.copy())
            else:
                # Small chunk - try to merge with previous or next
                if current_merged:
                    # Merge with pending chunk
                    current_merged["text"] = current_merged["text"] + "\n\n" + chunk["text"]
                    # Keep the first chunk's metadata (already set)
                else:
                    # Start a new merge group with this chunk's metadata
                    current_merged = chunk.copy()

        # Flush any remaining merged chunk
        if current_merged:
            merged_chunks.append(current_merged)

        # Step 2: Split large chunks while preserving metadata
        final_chunks = []

        for chunk in merged_chunks:
            chunk_tokens = self.count_tokens(chunk["text"])

            if chunk_tokens <= self.chunk_size:
                # Chunk is within the target size
                final_chunks.append(chunk)
            elif chunk_tokens <= self.max_chunk_size:
                # Chunk is larger than target but within the acceptable range
                split_texts = self._recursive_split(chunk["text"])
                if split_texts and all(self.count_tokens(t) <= self.max_chunk_size for t in split_texts):
                    # Successfully split - propagate parent's metadata to all children
                    for split_text in split_texts:
                        child_chunk = chunk.copy()
                        child_chunk["text"] = split_text
                        child_chunk["is_new_chapter"] = False  # Only first chunk marks new chapter
                        child_chunk["is_new_section"] = False
                        final_chunks.append(child_chunk)
                else:
                    # Keep the original chunk if split failed
                    final_chunks.append(chunk)
            else:
                # Chunk exceeds the hard limit-force split
                logger.warning(
                    "Chunk exceeds hard limit (%s tokens > %s tokens), forcing split",
                    chunk_tokens,
                    self.max_chunk_size,
                )
                split_texts = self._force_split_by_words(chunk["text"])
                for split_text in split_texts:
                    child_chunk = chunk.copy()
                    child_chunk["text"] = split_text
                    child_chunk["is_new_chapter"] = False
                    child_chunk["is_new_section"] = False
                    final_chunks.append(child_chunk)

        return final_chunks

    def _fallback_chunking(self, text: str) -> list[dict[str, Any]]:
        """
        Fallback to simple sliding window chunking if enhanced chunking fails.

        Args:
                text: The text to chunk

        Returns:
                A list of chunk dictionaries with text and default metadata
        """
        # Loud warning — callers should notice when markdown header detection failed
        # because the post-process _assign_cross_page_chapter_metadata() is the only
        # chance to recover meaningful chapter assignment.
        logger.warning(
            "enhanced_markdown fell back to sliding-window chunking (no markdown headers detected). "
            "Chapter metadata will rely on post-processing chapter detection. "
            "chunk_size=%d overlap=%d",
            self.chunk_size,
            self.chunk_overlap,
        )

        # Use utility function for sliding window chunking
        chunk_texts = sliding_window_chunking(text=text, chunk_size=self.chunk_size, chunk_overlap=self.chunk_overlap)

        # Default metadata signals "chapter unknown" — chapter_number=0 so that the
        # post-processing step _assign_cross_page_chapter_metadata can detect that no
        # real chapter was identified yet and apply regex/font-based detection cleanly.
        # Do NOT default to Chapter 1 here — that silently mislabels 100% of chunks
        # in books where header-based chunking fails.
        return [
            self._create_chunk_with_metadata(
                chunk_text,
                {
                    "chapter_number": 0,
                    "section_number": 0,
                    "chapter_title": "",
                    "section_title": "",
                    "is_new_chapter": False,
                    "is_new_section": False,
                    "header_level": None,
                },
            )
            for chunk_text in chunk_texts
        ]

    @staticmethod
    def _cosine_similarity(vec1, vec2) -> float:
        """
        Calculate cosine similarity between two vectors.

        Args:
                vec1: The first vector
                vec2: The second vector

        Returns:
                The cosine similarity score
        """
        # noinspection PyTypeChecker
        return np.dot(vec1, vec2) / (np.linalg.norm(vec1) * np.linalg.norm(vec2))

    def get_metadata(self) -> dict[str, Any]:
        """
        Get metadata about the chunking strategy.

        Returns:
                A dictionary containing strategy metadata
        """
        metadata = super().get_metadata()
        metadata.update(
            {
                "headers_to_split_on": self.headers_to_split_on,
                "preserve_elements": self.preserve_elements,
                "min_section_length": self.min_section_length,
                "has_embedding_fn": self.embedding_fn is not None,
            }
        )
        return metadata

    @staticmethod
    def _extract_hierarchy_metadata(doc, default_chapter: int, default_section: int) -> dict[str, Any]:
        """
        Extract hierarchical metadata from a Markdown document section.

        Args:
            doc: A document section from MarkdownHeaderTextSplitter
            default_chapter: The default chapter number if not detected
            default_section: The default section number if not detected

        Returns:
            A dictionary containing hierarchy metadata
        """
        metadata = {
            "chapter_number": default_chapter,
            "section_number": default_section,
            # Blank titles — post-processing will fill these in based on real detection.
            # Synthesizing "Chapter N" here would pollute downstream chapter counts.
            "chapter_title": "",
            "section_title": "",
            "is_new_chapter": False,
            "is_new_section": False,
            "header_level": None,
        }

        # Check if a document has header metadata from MarkdownHeaderTextSplitter
        if hasattr(doc, "metadata") and doc.metadata:
            headers = doc.metadata

            # Roman numeral conversion helper
            def roman_to_arabic(roman: str) -> int | None:
                """Convert any well-formed roman numeral to arabic number.

                Replaces a hardcoded lookup that ran out at xxv (25), causing
                page-numeral preface chapters like xxvi / xxvii / xxviii / il /
                c to fall through to a naked `int(roman)` and crash the
                chunker with `invalid literal for int() with base 10`.
                """
                if not roman:
                    return None
                values = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}
                s = roman.lower()
                if not all(ch in values for ch in s):
                    return None
                total = 0
                prev = 0
                for ch in reversed(s):
                    v = values[ch]
                    if v < prev:
                        total -= v
                    else:
                        total += v
                    prev = v
                return total if total > 0 else None

            # Look for chapter-level headers (H1 or H2)
            if "Header 1" in headers or "Header 2" in headers:
                # Check BOTH headers for chapter patterns: Header 2 may contain "Chapter X: TITLE"
                # while Header 1 is a parent section like "Bibliography" or "Introduction".
                # We prioritize whichever header contains a chapter pattern.
                # Apply boundary sanitizer to strip markdown-link tails and
                # orphan bold markers that the raw `.replace("**","")` misses.
                # Mirrors the same call at h1_raw/h2_raw line ~352 in the
                # auto-promotion path. Canonical incident: 8b521f60 (Orchid
                # Whisperer) `# [Masdevallia](003-toc.html#sec22)` headings.
                from src.main.service.document.document_processor import _sanitize_chapter_title, is_page_anchor_title

                header1_text = _sanitize_chapter_title((headers.get("Header 1") or "").replace("**", "").strip())
                header2_text = _sanitize_chapter_title((headers.get("Header 2") or "").replace("**", "").strip())

                # Page-anchor reject: pymupdf4llm-layout per-page anchors
                # ("page0029", "pg12", "p027") are not real chapter titles.
                # Zero them so downstream regex / fallback paths don't pick
                # them up. See is_page_anchor_title docstring.
                if is_page_anchor_title(header1_text):
                    header1_text = ""
                if is_page_anchor_title(header2_text):
                    header2_text = ""

                chapter_match_h1 = re.search(r"chapter\s+([IVXLC]+|\d+)[:.]?\s*(.*)", header1_text, re.IGNORECASE) if header1_text else None
                chapter_match_h2 = re.search(r"chapter\s+([IVXLC]+|\d+)[:.]?\s*(.*)", header2_text, re.IGNORECASE) if header2_text else None

                # Prefer whichever header has a chapter pattern; fall back to Header 1
                if chapter_match_h2:
                    chapter_match = chapter_match_h2
                    header_text = header2_text
                elif chapter_match_h1:
                    chapter_match = chapter_match_h1
                    header_text = header1_text
                else:
                    chapter_match = None
                    header_text = header1_text or header2_text
                    # H1→H2 fallback: when neither H1 nor H2 has a chapter
                    # pattern AND H2 is present and different from H1,
                    # prefer H2 as the section heading. The H1 in this case
                    # is almost always the constant book-title repeated on
                    # every chunk while H2 is the per-section heading.
                    # Canonical case: 1994 IDRC 'Cities feeding people'
                    # had H1='Cities Feeding People' on every chunk while
                    # H2 cycled through 'Foreword …', 'Chapter 1 …',
                    # 'Bibliography'; without this fallback the chunker
                    # stamped every chunk with the book-title H1 and the
                    # real H2 section signal was silently lost.
                    if header2_text and header2_text != header1_text and re.match(r"^[A-Z0-9]", header2_text) and len(header2_text) < 200:
                        header_text = header2_text
                    # H1+H3 fallback: when neither H1 nor H2 has a chapter
                    # pattern AND header_text would be a long book-root H1
                    # (≥30 chars) AND Header 3 is present with a usable
                    # value, prefer H3 as the more granular section heading.
                    # Without this, books with H1=book-title + H3=chapter
                    # (no real H2, e.g. Amazonian Black Earths a7049056)
                    # stamp every chunk with the book title as
                    # section_heading and silently drop the H3 chapter
                    # signal — the downstream `_assign_cross_page_chapter_metadata`
                    # then has no per-chunk section info to disambiguate.
                    header3_text = (headers.get("Header 3") or "").replace("**", "").strip()
                    if header3_text and re.match(r"^[A-Z0-9]", header3_text) and len(header3_text) < 100 and len(header_text) >= 30:
                        header_text = header3_text
                    # H4/H6 fallback: when H1/H2/H3 are all absent or
                    # already routed to a generic value (book-title H1),
                    # try H4 then H6 as the section heading. Canonical
                    # case: Brian Capon 'Botany for Gardeners' (d99842c7)
                    # where the source uses `## **Botany for Gardeners**`
                    # (single H2 = book title) + `#### _PART_` + `######
                    # _Chapter_` for the actual chapter hierarchy. Without
                    # this fallback every chunk inherits the book-title
                    # H2 as section_heading and the H4/H6 chapter signal
                    # is silently dropped — Pattern D body matching is
                    # the only remaining signal and it catches at most
                    # half the real chapters.
                    if (not header_text or len(header_text) >= 30) and not header3_text:
                        header4_text = (headers.get("Header 4") or "").replace("**", "").replace("_", "").strip()
                        header6_text = (headers.get("Header 6") or "").replace("**", "").replace("_", "").strip()
                        if header4_text and re.match(r"^[A-Z0-9]", header4_text) and len(header4_text) < 100:
                            header_text = header4_text
                        elif header6_text and re.match(r"^[A-Z0-9]", header6_text) and len(header6_text) < 100:
                            header_text = header6_text

                # Reject body-fragment + end-marker H1/H2 matches BEFORE
                # accepting. The chapter_match regex
                # `chapter\s+([IVXLC]+|\d+)[:.]?\s*(.*)` captures the title
                # tail; body fragments (`Chapter 5 ). The best ...`) and
                # end-of-chapter recap headers (`Chapter 2 Summary`) need
                # the same rejection logic as Pattern 1 below. Without
                # this, MarkdownHeaderTextSplitter metadata (Header 1/2)
                # propagates the polluted title to chunks.
                if chapter_match:
                    _trail_raw = chapter_match.group(2).strip().rstrip(".,;:!?")
                    if _trail_raw and _trail_raw[0] in ".,;:)]([":
                        chapter_match = None
                if chapter_match:
                    _trail_raw = chapter_match.group(2).strip().rstrip(".,;:!?")
                    _end_markers_hdr = {
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
                    if _trail_raw and _trail_raw.lower() in _end_markers_hdr:
                        chapter_match = None
                # Try to extract chapter number and title (Arabic or roman numerals)
                if chapter_match:
                    num_str = chapter_match.group(1)
                    # Convert Roman to Arabic if possible; otherwise parse as
                    # decimal; otherwise fall back to default_chapter so a
                    # malformed numeral never crashes the chunker.
                    parsed = roman_to_arabic(num_str)
                    if parsed is not None:
                        chapter_num = parsed
                    elif num_str.isdigit():
                        chapter_num = int(num_str)
                    else:
                        chapter_num = default_chapter
                    chapter_title = chapter_match.group(2).strip() or header_text
                    # Strip trailing TOC page number ("Chapter 9 - Uncertainty
                    # in Agricultural Impact Assessment 223" → "...Assessment").
                    # See Pattern 1 below for the same heuristic. Applied
                    # here because the H1/H2 path captures the page-number
                    # suffix straight from `## Chapter N — TITLE 223` source
                    # headers when the upstream extractor promoted the TOC
                    # entry to a heading. Signal-3 across ac47a5ad, e4e8b05b,
                    # 6b3e7878.
                    _trail_m = re.search(r"^(.+?)\s+(\d{1,4})\s*$", chapter_title)
                    if _trail_m:
                        # Strip trailing dot-leader runs ". . . . . ." and
                        # leading "- " / "— " separators that the H1/H2
                        # path captures from `## Chapter N - Title ... 35`
                        # source. plain rstrip() with a char set can't
                        # handle alternating dot+space; explicit regex
                        # drops any trailing whitespace + dots + dashes.
                        _pre_text = re.sub(r"[\s.\-—]+$", "", _trail_m.group(1)).strip()
                        _pre_text = re.sub(r"^[\s.\-—]+", "", _pre_text).strip()
                        _num_val = int(_trail_m.group(2))
                        _num_len = len(_trail_m.group(2))
                        # Dot-leader signature is an unambiguous TOC tell.
                        # The text between "Title" and the trailing page
                        # number is filled with `. . . . .` runs that the
                        # extractor stripped from leading position but left
                        # in body. When we see ≥3 dot-leader signals in the
                        # original title, the trailing number is ALWAYS a
                        # page number — strip regardless of preceding word.
                        _has_dot_leader = bool(re.search(r"\.\s*\.\s*\.", _trail_m.group(1)))
                        _pre_last = re.findall(r"[A-Za-z]+|\d+", _pre_text)
                        _pre_last_word = _pre_last[-1].lower() if _pre_last else ""
                        _allowed_pre = {
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
                        # Strip on either: dot-leader signature (definite
                        # TOC) OR generic heuristic match OR section-heading
                        # word with 1-digit page number.
                        # Generic heuristic length lowered 20 → 12 (catches
                        # `Analysis of Cores 57` style — 17 chars). Third
                        # branch covers `Introduction 1`, `Conclusion 4`
                        # cases where the preceding section name unambiguously
                        # signals a page number follows. Canonical case:
                        # ac7bd9ae (Lithic Production System) — see
                        # document_processor.py::_strip_toc_page for parallel
                        # fix.
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
                            (_has_dot_leader and len(_pre_text) >= 10 and 1 <= _num_len <= 4)
                            or (len(_pre_text) >= 12 and not _is_year and _pre_last_word not in _allowed_pre and 2 <= _num_len <= 4)
                            or (_num_len == 1 and _pre_last_word in _section_heading_words and len(_pre_text) >= 8)
                        ):
                            chapter_title = _pre_text
                    logger.info("📖 Detected chapter from H1/H2 header: Chapter %d - %s", chapter_num, chapter_title)
                    metadata.update(
                        {
                            "chapter_number": chapter_num,
                            "chapter_title": chapter_title,
                            "section_title": chapter_title,
                            "section_number": 1,  # Reset section counter for new chapter
                            "is_new_chapter": True,
                            "header_level": 1 if "Header 1" in headers else 2,
                        }
                    )
                # Split-format detection: "## CHAPTER" in the header, "## 1" or "## I" in content
                # This handles books where chapter headers are split across lines:
                # ## CHAPTER
                # ## 1 (or ## I)
                # In the spring of 1988...
                elif header_text.strip().upper() in ["CHAPTER", "CHAP", "CHAPTER.", "CHAP."]:
                    content = doc.page_content if hasattr(doc, "page_content") else str(doc)
                    if content:
                        content_lines = content.split("\n")[:5]  # Check the first 5 lines
                        for line in content_lines:
                            line = line.strip()
                            # Match: ## 1, ### I, **2**, IV, ###### **XII**, etc.
                            number_match = re.search(r"^(?:#{1,6}\s*)?(?:\*\*)?([IVXLC]+|\d+)(?:\*\*)?\.?$", line, re.IGNORECASE)
                            if number_match:
                                num_str = number_match.group(1)
                                parsed = roman_to_arabic(num_str)
                                if parsed is not None:
                                    chapter_num = parsed
                                elif num_str.isdigit():
                                    chapter_num = int(num_str)
                                else:
                                    chapter_num = default_chapter
                                logger.info("📖 Detected split-format chapter from header+content: Chapter %d", chapter_num)
                                metadata.update(
                                    {
                                        "chapter_number": chapter_num,
                                        "chapter_title": f"Chapter {chapter_num}",
                                        "section_title": f"Chapter {chapter_num}",
                                        "section_number": 1,  # Reset section counter for new chapter
                                        "is_new_chapter": True,
                                        "header_level": 1 if "Header 1" in headers else 2,
                                    }
                                )
                                break
                if not metadata.get("is_new_chapter"):
                    # Validate header text before treating as a section.
                    # Real headers start with uppercase/digit, not sentence fragments.
                    is_valid_header = (
                        len(header_text) < 100  # Not too long
                        and not header_text.startswith('"')  # Not a quote
                        and not header_text.startswith("'")  # Not a quote
                        and not header_text.endswith("...")  # Not truncated
                        and header_text.strip()  # Not empty
                        and re.match(r"^[A-Z0-9]", header_text)  # Must start with uppercase or digit
                    )

                    if is_valid_header:
                        # Treat as a section if no chapter pattern found
                        # Auto-increment section_number so each H1/H2 section gets a unique number
                        metadata.update(
                            {
                                "section_number": default_section + 1,
                                "section_title": header_text,
                                "is_new_section": True,
                                "header_level": 1 if "Header 1" in headers else 2,
                            }
                        )

            # Look for section-level headers (H3, H4)
            elif "Header 3" in headers or "Header 4" in headers:
                header_text = headers.get("Header 3") or headers.get("Header 4", "")
                # Strip bold markers from header text (PDF artifacts)
                header_text = header_text.replace("**", "").strip()

                # Try to extract a section number
                section_match = re.search(r"section\s+(\d+):?\s*(.*)", header_text.lower())
                if section_match:
                    metadata.update(
                        {
                            "section_number": int(section_match.group(1)),
                            "section_title": section_match.group(2).strip() or header_text,
                            "is_new_section": True,
                            "header_level": 3 if "Header 3" in headers else 4,
                        }
                    )
                else:
                    # Validate header text before using.
                    # Real headers start with uppercase/digit, not sentence fragments.
                    is_valid_header = (
                        len(header_text) < 100
                        and not header_text.startswith('"')
                        and not header_text.startswith("'")
                        and not header_text.endswith("...")
                        and header_text.strip()
                        and re.match(r"^[A-Z0-9]", header_text)  # Must start with uppercase or digit
                    )

                    if is_valid_header:
                        # BUG FIX #2: When a pattern doesn't match, auto-increment section number
                        # This ensures sections are properly numbered even without explicit "Section X": format
                        metadata.update(
                            {
                                "section_number": default_section + 1,  # Auto-increment from default
                                "section_title": header_text,
                                "is_new_section": True,
                                "header_level": 3 if "Header 3" in headers else 4,
                            }
                        )

        # Additional extraction from content if no headers found
        content = doc.page_content if hasattr(doc, "page_content") else str(doc)
        if content and not metadata.get("is_new_chapter") and not metadata.get("is_new_section"):
            # Look for chapter markers in the first few lines
            lines = content.split("\n")[:5]  # Increased to 5 lines for multi-line chapter markers

            for i, line in enumerate(lines):
                line_lower = line.lower().strip()

                # Pattern 1: Standard "chapter 1" or "chapter I" format (case-insensitive, flexible)
                # Supports: Chapter, CHAPTER, Ch., Chap., arabic numbers, roman numerals, spelled-out
                #
                # `\b` word-boundary anchors are critical. Without the leading `\b`,
                # `ch\.?` matches the trailing "ch" inside any word (such, much,
                # rich, approach, which, …), and the unbounded `[IVXLC]+` then
                # captures one of the roman-numeral letters at the start of the
                # next word ("c" from "common", "v" from "variable"), producing
                # phantom chapters whose title is body text. Observed live on
                # "Agricultural Field Experiments" (e8f58e91): the line
                # "familiar with such common statistical tables" matched as
                # group(1)='c', group(2)='ommon statistical tables…'. The
                # roman alternative is also capped at {1,4} so a long all-caps
                # body word can't pretend to be a roman numeral. The trailing
                # `\b` after the captured number prevents partial-token matches
                # like "ch 7thing".
                chapter_match = re.search(
                    r"\b(?:chapter|chap\.?|ch\.?)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|[IVXLC]{1,4})\b[:.]?\s*(.*)",
                    line,
                    re.IGNORECASE,
                )
                # Body-prose reject. The `\b` word-boundary anchors block
                # mid-word matches like "such common", but a sentence that
                # *intentionally* names another chapter ("Chapter 2 and
                # Figure 1 in Chapter 9. Areas in hectares:") still passes
                # the regex — and Pattern 1 then steals the entire body
                # paragraph as the chapter title. Only reject when the
                # remainder both contains a body-prose joiner AND
                # references another chapter explicitly. Real headings
                # like "Chapter 7 Climate and Forests" pass because they
                # have a joiner but no second `chapter` token.
                if chapter_match:
                    _trail = chapter_match.group(2).strip()
                    if re.search(r"\b(and|in|of|see|cf\.?|cited|discussed)\b", _trail, re.IGNORECASE) and re.search(
                        r"\bchapter\b", _trail, re.IGNORECASE
                    ):
                        chapter_match = None
                # Mid-sentence cutoff reject. Real chapter titles end with
                # nouns / proper nouns; sentence-mid body cutoffs end with
                # prepositions, conjunctions, or articles (`Chapter 3. The
                # present discussion will be confined to`, where group(2)
                # captures everything after "Chapter 3. " up to the LINE
                # break and the line happens to cut mid-sentence). Confirmed
                # signal=3 across ac47a5ad, e4e8b05b, 6b3e7878 — all share
                # the H1=book-title + H2=boilerplate + real chapters at H3+
                # shape where body paragraphs reference earlier chapters
                # mid-flow. Reject when the trailing word is in the stop
                # set. Title text shorter than 4 chars passes (rare but
                # legit `Chapter 7 EU` for an abbreviated regional name).
                if chapter_match:
                    _trail = chapter_match.group(2).strip().rstrip(".,;:!?")
                    if _trail and len(_trail) >= 4:
                        _last_word = _trail.split()[-1].lower() if _trail.split() else ""
                        _stop_words = {
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
                        if _last_word in _stop_words:
                            chapter_match = None
                if chapter_match:
                    # Convert spelled-out or roman numbers to digits
                    number_str = chapter_match.group(1).lower()
                    word_map = {
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
                    }
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
                    }
                    if number_str in word_map:
                        chapter_num = word_map[number_str]
                    elif number_str in roman_map:
                        chapter_num = roman_map[number_str]
                    elif number_str.isdigit():
                        chapter_num = int(number_str)
                    else:
                        chapter_num = default_chapter
                    chapter_title = chapter_match.group(2).strip() or line.strip()

                    # Sentence-fragment / running-header guard. The body
                    # regex `\bchapter\s+\d+:?\s*(.*)` matches mid-paragraph
                    # mentions whose group(2) is either (a) a sentence
                    # fragment starting with punctuation (`. Cells, in
                    # turn…`, `), applied when there is no risk of frost…`),
                    # or (b) just a redundant running-header bleed
                    # (`CHAPTER 4` repeated at the top of every page).
                    # Without this guard the chunker stamps body chunks with
                    # those polluted titles, then the dedup-by-chapter-number
                    # step in downstream content matching keeps the LAST
                    # value — collapsing a 10-chapter book down to ~4. Skip
                    # the match entirely; the per-chunk current_chapter
                    # tracking will keep its prior valid state. Verified
                    # against 84 affected docs in production: only
                    # punctuation-starting titles are unambiguous bugs;
                    # lowercase-starting titles can be legitimate
                    # non-English text (e.g. `teológica fundamental`,
                    # `appendix e`), so they pass.
                    _bare = re.sub(r"[\s\.\#:\*]+", "", chapter_title.lower())
                    _is_redundant_keyword = re.fullmatch(r"chap(?:ter|\.?)\d+", _bare) is not None
                    if chapter_title and (chapter_title[0] in ".,;:)]([" or _is_redundant_keyword):
                        continue

                    # TOC dot-leader page-number reject. Pattern 1 sometimes
                    # catches a TOC entry like "Uncertainty in Agricultural
                    # Impact Assessment ........ 223" — after the chunker
                    # strips dot-leaders the trailing page number remains
                    # tacked onto the title. Real titles with a trailing
                    # number have it in semantic context (years like 1492
                    # immediately after a noun like "since", fragment refs
                    # like "Pindar Fragment 122"). The TOC artifact has the
                    # trailing number after a typical sentence-form noun
                    # phrase with no number context. Heuristic: when the
                    # title ends with " <2-4 digit number>" AND the word
                    # immediately before the number is NOT one of a small
                    # list of number-carrying nouns (year qualifier, ref
                    # form), reject.
                    # TOC dot-leader trailing-page-number reject. Pattern 1
                    # sometimes catches a TOC entry like "Uncertainty in
                    # Agricultural Impact Assessment ......... 223" — after
                    # the chunker strips the dot-leaders the trailing page
                    # number remains tacked onto the title. Real titles with
                    # a trailing number tend to either carry a year
                    # (1500-2099) or a number-carrying word immediately
                    # before the digits ("Pindar Fragment 122", "since
                    # 1492", "Volume 3"). The TOC artifact has the trailing
                    # digit after generic title prose with no number context.
                    _trail_num_m = re.search(r"^(.+?)\s+(\d{1,4})\s*$", chapter_title)
                    if _trail_num_m:
                        _pre_text = re.sub(r"[\s.\-—]+$", "", _trail_num_m.group(1)).strip()
                        _pre_text = re.sub(r"^[\s.\-—]+", "", _pre_text).strip()
                        _num_val = int(_trail_num_m.group(2))
                        _num_len = len(_trail_num_m.group(2))
                        _has_dot_leader = bool(re.search(r"\.\s*\.\s*\.", _trail_num_m.group(1)))
                        _pre_last = re.findall(r"[A-Za-z]+|\d+", _pre_text)
                        _pre_last_word = _pre_last[-1].lower() if _pre_last else ""
                        _allowed_pre = {
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
                        if (_has_dot_leader and len(_pre_text) >= 10 and 1 <= _num_len <= 4) or (
                            len(_pre_text) >= 20 and not _is_year and _pre_last_word not in _allowed_pre and 2 <= _num_len <= 4
                        ):
                            continue

                    logger.info("📖 Detected chapter from content (Pattern 1): Chapter %d - %s", chapter_num, chapter_title)
                    metadata.update(
                        {
                            "chapter_number": chapter_num,
                            "chapter_title": chapter_title,
                            "section_title": chapter_title,
                            "section_number": 1,  # Reset section counter for new chapter
                            "is_new_chapter": True,
                        }
                    )
                    break

                # Pattern 2: "CHAPTER" on one line, number on the next line (more flexible)
                # Format: **CHAPTER**, CHAPTER, ## CHAPTER, etc. followed by arabic or roman number
                if re.search(r"^(?:#{1,6}\s*)?(?:\*\*)?(?:chapter|chap)(?:\*\*)?$", line_lower) and i + 1 < len(lines):
                    next_line = lines[i + 1].strip()
                    # Extract number from various formats: "## **2**", "## I", "###### **IV**", "**4**", etc.
                    number_match = re.search(r"(?:#{1,6}\s*)?(?:\*\*)?([IVXLC]+|\d+)(?:\*\*)?", next_line, re.IGNORECASE)
                    if number_match:
                        num_str = number_match.group(1).lower()
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
                        }
                        chapter_num = roman_map.get(num_str, int(num_str) if num_str.isdigit() else default_chapter)

                        # Check if there's a third line with additional info (like month/year)
                        chapter_title = f"Chapter {chapter_num}"
                        if i + 2 < len(lines):
                            third_line = lines[i + 2].strip()
                            # If the third line has text (not just Markdown), use it as part of the title
                            if third_line and not third_line.startswith("#"):
                                chapter_title = f"Chapter {chapter_num} - {third_line}"

                        logger.info("📖 Detected chapter from content (Pattern 2): Chapter %d - %s", chapter_num, chapter_title)
                        metadata.update(
                            {
                                "chapter_number": chapter_num,
                                "chapter_title": chapter_title,
                                "section_title": chapter_title,
                                "section_number": 1,  # Reset section counter for new chapter
                                "is_new_chapter": True,
                            }
                        )
                        break

                # Check for section patterns
                section_match = re.search(r"section\s+(\d+):?\s*(.*)", line_lower)
                if section_match:
                    metadata.update(
                        {
                            "section_number": int(section_match.group(1)),
                            "section_title": section_match.group(2).strip() or line.strip(),
                            "is_new_section": True,
                        }
                    )
                    break

        # Pattern 3 (fallback): full-content scan for inline `CHAPTER N. Title`.
        # Triggers ONLY when Patterns 1-2 above (which scan lines[:5]) didn't
        # flip is_new_chapter. Use case: flat-markdown EPUBs whose chapter
        # marker is buried mid-chunk because the source had no MD headers and
        # no ALL-CAPS standalone line — the `CHAPTER 3. SOMETHING` marker
        # sits inline with the body. Without this fallback the chunker
        # collapses every such chapter into "Chapter 1 / Section 1" and
        # downstream summary generation gets a single 500-char title that
        # is actually body text.
        if content and not metadata.get("is_new_chapter") and not metadata.get("is_new_section"):
            inline_match = re.search(
                r"\bCHAPTER\s+([IVXLC]+|\d{1,2})\.\s+([A-Z][^.\n]{4,80})",
                content,
            )
            if inline_match:
                num_str = inline_match.group(1).lower()
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
                }
                if num_str in roman_map:
                    chapter_num = roman_map[num_str]
                elif num_str.isdigit():
                    chapter_num = int(num_str)
                else:
                    chapter_num = default_chapter

                inline_title = inline_match.group(2).strip()
                logger.info(
                    "📖 Detected chapter from content (Pattern 3, full-scan): Chapter %d - %s",
                    chapter_num,
                    inline_title,
                )
                metadata.update(
                    {
                        "chapter_number": chapter_num,
                        "chapter_title": inline_title,
                        "section_title": inline_title,
                        "section_number": 1,
                        "is_new_chapter": True,
                    }
                )

        # Control-character strip: PDF→md extractors occasionally embed
        # ASCII control bytes inside chapter heading text (`## **1
        # \x07Orientation: …**` from Deep Agroecology b656dca5). The BEL
        # byte (`\x07`) and other C0 control chars (0x00-0x1F except
        # `\t`/`\n`) plus DEL (`\x7F`) are never part of a legitimate
        # human-authored title, so strip them silently before downstream
        # validation runs.
        _CONTROL_RE = re.compile(r"[\x00-\x08\x0B-\x1F\x7F]")
        for _key in ("chapter_title", "section_title"):
            _val = metadata.get(_key)
            if isinstance(_val, str) and _CONTROL_RE.search(_val):
                metadata[_key] = _CONTROL_RE.sub("", _val).strip()

        # Sentence-fragment guard: chapter / section titles starting with
        # punctuation (`)`, `,`, `.`, `;`, `:`) or a lowercase letter are
        # almost always mid-sentence body text that the splitter mistakenly
        # propagated into a header field. Drop them so downstream readers see
        # an empty title rather than `") , applied when there is no risk of
        # frost…"` (Building with Straw Bales chapter 11 was hit by exactly
        # this 2026-05-10). The post-Tier-3 / content-matching paths in
        # `_assign_cross_page_chapter_metadata` then have a clean slate to
        # assign a proper title from the detected chapter list.
        for _key in ("chapter_title", "section_title"):
            _val = metadata.get(_key) or ""
            _stripped = _val.strip()
            if not _stripped:
                continue
            _first = _stripped[0]
            if (not _first.isalnum() and _first not in ('"', "'", "“", "‘", "«")) or (_first.isalpha() and _first.islower()):
                metadata[_key] = ""

        return metadata

    @staticmethod
    def _create_chunk_with_metadata(chunk_text: str, hierarchy_metadata: dict[str, Any]) -> dict[str, Any]:
        """
        Create a chunk dictionary with text and hierarchy metadata.

        Args:
            chunk_text: The text content of the chunk
            hierarchy_metadata: The hierarchy metadata to include

        Returns:
            A dictionary containing text and metadata
        """

        # Sentence-fragment guard at the SINGLE chunk-write point. Catches
        # garbage titles propagated from any upstream path (auto-promote,
        # H1/H2 chapter_match, header inheritance through
        # MarkdownHeaderTextSplitter), not just the ones routed through
        # _extract_hierarchy_metadata. Building with Straw Bales (c37828be)
        # chapter 11 inherited '") , applied when there is no risk of
        # frost…"' from a Header 2 = "Chapter 11" split where the next body
        # line was a sentence fragment promoted into Header content.
        def _clean(_t: str) -> str:
            if not _t:
                return ""
            _s = _t.strip()
            if not _s:
                return ""
            _f = _s[0]
            if not _f.isalnum() and _f not in ('"', "'", "“", "‘", "«"):
                return ""
            if _f.isalpha() and _f.islower():
                return ""
            return _t

        return {
            "text": chunk_text,
            # Default to 0/empty so post-processing _assign_cross_page_chapter_metadata
            # can detect "chapter unknown" and apply regex/font-based detection cleanly.
            # Never default to Chapter 1 — it silently mislabels whole books.
            "chapter_number": hierarchy_metadata.get("chapter_number", 0),
            "section_number": hierarchy_metadata.get("section_number", 0),
            "chapter_title": _clean(hierarchy_metadata.get("chapter_title", "")),
            "section_title": _clean(hierarchy_metadata.get("section_title", "")),
            "is_new_chapter": hierarchy_metadata.get("is_new_chapter", False),
            "is_new_section": hierarchy_metadata.get("is_new_section", False),
            "header_level": hierarchy_metadata.get("header_level"),
            "word_count": len(chunk_text.split()) if chunk_text else 0,
        }

    @staticmethod
    def _build_hierarchy_tree(chunks: list[dict[str, Any]]) -> dict[str, Any]:
        """
        Build a nested hierarchy tree from a flat chunk list.

        This creates a tree structure where each node represents a heading (chapter/section)
        and contains its chunk range and nested children.

        Args:
            chunks: List of chunks with hierarchy metadata

        Returns:
            Nested dictionary representing document structure with chunk ranges
            Example:
            {
                "H1: Chapter 1": {
                    "chunk_range": [0, 25],
                    "heading_level": 1,
                    "children": {
                        "H2: Section 1.1": {
                            "chunk_range": [0, 10],
                            "heading_level": 2,
                            "children": {}
                        }
                    }
                }
            }
        """
        hierarchy = {}
        stack = []  # Stack to track the current path in a tree: [(heading_text, node, level), ...]

        for i, chunk in enumerate(chunks):
            # Check if this chunk starts a new heading
            if chunk.get("is_new_chapter") or chunk.get("is_new_section"):
                heading_text = chunk.get("chapter_title") if chunk.get("is_new_chapter") else chunk.get("section_title")
                heading_level = chunk.get("header_level") or 1  # Handle None values

                # Create a heading key with a level prefix (e.g., "H1: Chapter Title")
                heading_key = f"H{heading_level}: {heading_text}"

                # Pop stack to appropriate level (remove deeper nodes)
                while stack and stack[-1][2] >= heading_level:
                    stack.pop()

                # Create a new node
                node = {
                    "chunk_range": [i, i],
                    "heading_level": heading_level,
                    "children": {},
                }  # Will expand as we see more chunks

                # Insert into a tree
                if not stack:
                    # Top-level heading
                    hierarchy[heading_key] = node
                else:
                    # Nested heading - add to parent's children
                    parent_node = stack[-1][1]
                    parent_node["children"][heading_key] = node

                # Push to stack
                stack.append((heading_key, node, heading_level))

            # Expand chunk ranges for all nodes in the stack
            for _heading_text, node, _level in stack:
                node["chunk_range"][1] = i

        return hierarchy

    @staticmethod
    def _find_parent_range(chunk: dict[str, Any], hierarchy: dict[str, Any], all_chunks: list[dict[str, Any]]) -> list[int]:
        """
        Find the parent section chunk range for this chunk.

        The parent is the next level up in the hierarchy (e.g., if a chunk is in an H3 section,
         the parent is the H2 section containing it).

        Args:
            chunk: The chunk to find parent range for
            hierarchy: Document hierarchy tree
            all_chunks: All chunks in the document

        Returns:
            [start_index, end_index] of a parent section, or [chunk_index, chunk_index] if no parent
        """
        chunk_idx = all_chunks.index(chunk) if chunk in all_chunks else 0

        def search_tree(tree, target_idx, parent_range=None, depth=0):
            """Recursively search a tree for chunk and return parent range"""
            for _heading, node in tree.items():
                range_start, range_end = node["chunk_range"]

                # Skip nodes with invalid ranges (None values)
                if range_start is None or range_end is None:
                    continue

                # Check if this node contains the chunk
                if range_start <= target_idx <= range_end:
                    # If this node has children, recurse into them
                    if node.get("children"):
                        _result = search_tree(node["children"], target_idx, node["chunk_range"], depth + 1)
                        if _result:
                            return _result

                    # This is the deepest node containing the chunk
                    # Return the current node's range (which is the parent of the chunk)
                    return parent_range if parent_range else node["chunk_range"]

            return parent_range

        result = search_tree(hierarchy, chunk_idx)
        return result if result else [chunk_idx, chunk_idx]

    @staticmethod
    def _find_section_range(chunk: dict[str, Any], hierarchy: dict[str, Any], all_chunks: list[dict[str, Any]]) -> list[int]:
        """
        Find the immediate section chunk range for this chunk.

        This is the deepest (most specific) section containing the chunk.

        Args:
            chunk: The chunk to find section range for
            hierarchy: Document hierarchy tree
            all_chunks: All chunks in the document

        Returns:
            [start_index, end_index] of an immediate section, or [chunk_index, chunk_index] if no section
        """
        chunk_idx = all_chunks.index(chunk) if chunk in all_chunks else 0

        def search_tree(tree, target_idx, current_range=None):
            """Recursively search a tree for the deepest node containing chunk"""
            deepest_range = current_range

            for _heading, node in tree.items():
                range_start, range_end = node["chunk_range"]

                # Skip nodes with invalid ranges (None values)
                if range_start is None or range_end is None:
                    continue

                # Check if this node contains the chunk
                if range_start <= target_idx <= range_end:
                    # Update deepest range to this node
                    deepest_range = node["chunk_range"]

                    # If this node has children, recurse to find an even deeper match
                    if node.get("children"):
                        child_result = search_tree(node["children"], target_idx, deepest_range)
                        if child_result:
                            deepest_range = child_result

                    break  # Found the containing node, no need to check siblings

            return deepest_range

        result = search_tree(hierarchy, chunk_idx)
        return result if result else [chunk_idx, chunk_idx]
