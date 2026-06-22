"""
PDF Chapter Detection using structural features.

Detects chapter boundaries in PDFs using a 3-tier approach:
1. TOC extraction (fastest, most reliable when available)
2. Font-size heuristics (universal, works for most PDFs)
3. Returns empty list as fallback (caller uses regex)
"""

from collections import Counter
import re

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Common chapter number pattern for extracting numbers from titles
_CHAPTER_NUM_PATTERN = re.compile(
    r"(?:chapter|chap\.?|ch\.?)\s+(\d+|[IVXLC]+)",
    re.IGNORECASE,
)

_ROMAN_MAP = {
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


def _parse_chapter_number(text: str) -> int | None:
    """Extract a chapter number from text like 'Chapter 5', 'III. Title', etc."""
    m = _CHAPTER_NUM_PATTERN.search(text)
    if m:
        val = m.group(1)
        lower = val.lower()
        if lower in _ROMAN_MAP:
            return _ROMAN_MAP[lower]
        if val.isdigit():
            return int(val)
    # Try leading number: "5. Introduction"
    m2 = re.match(r"^(\d+)[\.\s]", text.strip())
    if m2:
        return int(m2.group(1))
    return None


def _clean_title(raw: str) -> str:
    """Clean a raw title string — strip chapter prefix, normalize whitespace."""
    # Remove "Chapter N:" / "Chapter N." prefix
    cleaned = re.sub(
        r"^(?:chapter|chap\.?|ch\.?)\s+(?:\d+|[IVXLC]+)\s*[:\.\-—–]?\s*",
        "",
        raw,
        flags=re.IGNORECASE,
    ).strip()
    # Remove leading number prefix: "5. " or "5 "
    cleaned = re.sub(r"^\d+[\.\s]+", "", cleaned).strip()
    # Title-case if ALL CAPS
    if cleaned and cleaned == cleaned.upper() and len(cleaned) > 3:
        from src.main.utils.text.formatting import smart_title_case

        cleaned = smart_title_case(cleaned)
    return cleaned if cleaned else raw.strip()


class PDFChapterDetector:
    """Detects chapter boundaries in PDFs using structural features."""

    @staticmethod
    def detect_chapters(file_path: str) -> list[tuple[int, int, str]]:
        """
        Detect chapter boundaries in a PDF file.

        Returns a list of (page_number, chapter_number, chapter_title) sorted by page.
        Uses TOC first, then font-size heuristics. Returns empty list if detection
        fails or finds fewer than 2 chapters.

        Args:
            file_path: Absolute path to the PDF file

        Returns:
            List of (page_num, chapter_num, chapter_title) tuples, 0-indexed pages
        """
        if not file_path.lower().endswith(".pdf"):
            return []

        try:
            chapters = PDFChapterDetector._detect_from_toc(file_path)
            if chapters:
                logger.info(
                    "PDF chapter detection via TOC: %d chapters found in %s",
                    len(chapters),
                    file_path,
                )
                return chapters

            chapters = PDFChapterDetector._detect_from_font_size(file_path)
            if chapters:
                logger.info(
                    "PDF chapter detection via font-size: %d chapters found in %s",
                    len(chapters),
                    file_path,
                )
                return chapters

            # Tier 3: LLM-based TOC detection for complex/unusual PDFs
            chapters = PDFChapterDetector._detect_from_llm(file_path)
            if chapters:
                logger.info(
                    "PDF chapter detection via LLM: %d chapters found in %s",
                    len(chapters),
                    file_path,
                )
                return chapters

            logger.debug("No chapters detected in PDF: %s", file_path)
            return []

        except Exception as e:
            logger.warning("PDF chapter detection failed for %s: %s", file_path, str(e))
            return []

    @staticmethod
    def _detect_from_toc(file_path: str) -> list[tuple[int, int, str]]:
        """Tier 1: Detect chapters from PDF Table of Contents."""
        import pymupdf

        try:
            doc = pymupdf.open(file_path)
        except Exception as e:
            logger.debug("Cannot open PDF for TOC: %s", str(e))
            return []

        try:
            toc = doc.get_toc()
            if not toc:
                return []

            # Filter to level-1 entries only
            level1_entries = [(title, page - 1) for level, title, page in toc if level == 1 and page > 0]
            if len(level1_entries) < 2:
                return []

            # Reject publisher-archival filename slugs (Anna's Archive convention
            # for academic journals — JSS, BAR, etc.). When the outline is mostly
            # archival noise (≥50%), drop the entire outline and fall through to
            # font-size / LLM detection. For mixed outlines, drop individual
            # entries. Verified incident 553e7a08 (JSS 68 1980): 64 polluted
            # chapter_titles across 1233 chunks; cross-corpus scan 43 docs / 633
            # distinct slugs, 0 false positives across 8082 corpus titles.
            from src.main.service.document.document_processor import is_archival_filename_title

            archival_hits = sum(1 for title, _ in level1_entries if is_archival_filename_title(title))
            if archival_hits >= max(2, len(level1_entries) // 2):
                logger.info(
                    "PDF outline rejected (%d/%d archival-filename entries in %s)",
                    archival_hits,
                    len(level1_entries),
                    file_path,
                )
                return []

            chapters = []
            seq_num = 0
            for title, page in level1_entries:
                if is_archival_filename_title(title):
                    # Mixed outline: drop just this slug, keep the rest.
                    continue
                ch_num = _parse_chapter_number(title)
                if ch_num is not None:
                    seq_num = ch_num
                else:
                    seq_num += 1
                clean = _clean_title(title)
                if is_archival_filename_title(clean):
                    continue
                if not clean:
                    clean = f"Chapter {seq_num}"
                chapters.append((page, seq_num, clean))

            return chapters if len(chapters) >= 2 else []

        finally:
            doc.close()

    @staticmethod
    def _detect_from_font_size(file_path: str) -> list[tuple[int, int, str]]:
        """Tier 2: Detect chapters using font-size heuristics."""
        import pymupdf

        try:
            doc = pymupdf.open(file_path)
        except Exception as e:
            logger.debug("Cannot open PDF for font analysis: %s", str(e))
            return []

        try:
            total_pages = len(doc)
            if total_pages < 3:
                return []

            # Pass 1: Collect all font sizes to determine body font size
            all_font_sizes: list[float] = []
            page_texts: list[list[dict]] = []  # per-page list of text spans

            for page_idx in range(total_pages):
                page = doc[page_idx]
                page_height = page.rect.height
                page_dict = page.get_text("dict")
                spans_on_page = []

                for block in page_dict.get("blocks", []):
                    if block.get("type") != 0:  # text blocks only
                        continue
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            text = span.get("text", "").strip()
                            if not text:
                                continue
                            font_size = span.get("size", 0)
                            flags = span.get("flags", 0)
                            is_bold = bool(flags & (1 << 4))  # bit 4 = bold
                            # bbox: (x0, y0, x1, y1)
                            bbox = span.get("bbox", (0, 0, 0, 0))
                            y_top = bbox[1]
                            position_ratio = y_top / page_height if page_height > 0 else 1.0

                            span_info = {
                                "text": text,
                                "size": round(font_size, 1),
                                "bold": is_bold,
                                "y_ratio": position_ratio,
                                "page": page_idx,
                            }
                            spans_on_page.append(span_info)
                            # Count font sizes weighted by text length for body detection
                            all_font_sizes.extend([round(font_size, 1)] * len(text))

                page_texts.append(spans_on_page)

            if not all_font_sizes:
                return []

            # Body font = most common font size (mode)
            size_counts = Counter(all_font_sizes)
            body_font_size = size_counts.most_common(1)[0][0]
            # Threshold: font must be at least 1.4x body size to be a heading
            heading_threshold = body_font_size * 1.4

            logger.debug(
                "Font analysis: body=%.1ftp, heading_threshold=%.1ftp, pages=%d",
                body_font_size,
                heading_threshold,
                total_pages,
            )

            # Pass 2: Find heading candidates on each page
            raw_chapters: list[tuple[int, str, float]] = []  # (page, text, font_size)

            for page_idx, spans in enumerate(page_texts):
                if not spans:
                    continue

                # Collect heading candidates: large, bold, in upper portion of page
                heading_candidates = []
                for span in spans:
                    if (
                        span["size"] >= heading_threshold
                        and span["bold"]
                        and span["y_ratio"] < 0.45  # upper 45% of page
                        and len(span["text"]) < 100
                    ):
                        heading_candidates.append(span)

                if not heading_candidates:
                    continue

                # Group adjacent heading spans into heading blocks
                # (spans on the same page close together form one heading)
                groups = PDFChapterDetector._group_heading_spans(heading_candidates)

                for group in groups:
                    combined_text = " ".join(s["text"] for s in group)
                    max_size = max(s["size"] for s in group)
                    # Skip if the combined text is too long (likely a paragraph, not a heading)
                    if len(combined_text) > 120:
                        continue
                    # Skip likely running headers (very short, appear on many pages)
                    if len(combined_text) < 3:
                        continue
                    raw_chapters.append((page_idx, combined_text.strip(), max_size))

            if not raw_chapters:
                return []

            # Pass 3: Filter out running headers (text that appears on many pages)
            raw_chapters = PDFChapterDetector._filter_running_headers(raw_chapters, total_pages)

            if len(raw_chapters) < 2:
                return []

            # Pass 4: Merge consecutive entries on same page (e.g., "Chapter 1" + "INTRODUCTION")
            merged = PDFChapterDetector._merge_same_page_entries(raw_chapters)

            # Pass 5: Assign chapter numbers
            chapters = []
            seq_num = 0
            for page_idx, text, _ in merged:
                ch_num = _parse_chapter_number(text)
                if ch_num is not None:
                    seq_num = ch_num
                else:
                    seq_num += 1
                title = _clean_title(text)
                if not title:
                    title = f"Chapter {seq_num}"
                chapters.append((page_idx, seq_num, title))

            return chapters if len(chapters) >= 2 else []

        finally:
            doc.close()

    @staticmethod
    def _group_heading_spans(candidates: list[dict]) -> list[list[dict]]:
        """Group heading spans that are close together into blocks."""
        if not candidates:
            return []

        # Sort by vertical position
        sorted_spans = sorted(candidates, key=lambda s: s["y_ratio"])
        groups: list[list[dict]] = [[sorted_spans[0]]]

        for span in sorted_spans[1:]:
            prev = groups[-1][-1]
            # If close vertically (within ~5% of page height), same group
            if abs(span["y_ratio"] - prev["y_ratio"]) < 0.06:
                groups[-1].append(span)
            else:
                groups.append([span])

        return groups

    @staticmethod
    def _filter_running_headers(
        entries: list[tuple[int, str, float]],
        total_pages: int,
    ) -> list[tuple[int, str, float]]:
        """Remove entries that look like running headers (same text on many pages)."""
        # Count how often each normalized text appears
        text_counts: Counter = Counter()
        for _, text, _ in entries:
            normalized = text.strip().lower()
            text_counts[normalized] += 1

        # If a text appears on more than 30% of pages, it's likely a running header
        threshold = max(3, total_pages * 0.3)
        filtered = []
        for page, text, size in entries:
            normalized = text.strip().lower()
            if text_counts[normalized] < threshold:
                filtered.append((page, text, size))

        if len(entries) != len(filtered):
            logger.debug(
                "Filtered %d running headers from %d candidates",
                len(entries) - len(filtered),
                len(entries),
            )

        return filtered

    @staticmethod
    def _merge_same_page_entries(
        entries: list[tuple[int, str, float]],
    ) -> list[tuple[int, str, float]]:
        """Merge heading entries on the same page (e.g., 'Chapter 1' + 'INTRODUCTION')."""
        if not entries:
            return []

        merged: list[tuple[int, str, float]] = []
        i = 0
        while i < len(entries):
            page, text, size = entries[i]
            # Check if next entry is on the same page
            if i + 1 < len(entries) and entries[i + 1][0] == page:
                next_text = entries[i + 1][1]
                next_size = entries[i + 1][2]
                # If first part has "chapter" keyword, combine with title
                has_chapter_kw = bool(re.search(r"(?:chapter|chap\.?|ch\.?)\s+", text, re.IGNORECASE))
                if has_chapter_kw:
                    combined = f"{text}: {next_text}"
                    merged.append((page, combined, max(size, next_size)))
                    i += 2
                    continue
                # If second part has "chapter" keyword (reverse order), skip second
                has_chapter_kw_next = bool(re.search(r"(?:chapter|chap\.?|ch\.?)\s+", next_text, re.IGNORECASE))
                if has_chapter_kw_next:
                    combined = f"{next_text}: {text}"
                    merged.append((page, combined, max(size, next_size)))
                    i += 2
                    continue

            merged.append((page, text, size))
            i += 1

        return merged

    @staticmethod
    def _detect_from_llm(file_path: str) -> list[tuple[int, int, str]]:
        """
        Tier 3: Use LLM to detect chapters from the first pages of a PDF.

        Sends the text of the first 15 pages to the LLM and asks it to identify
        chapter/section boundaries. Handles complex TOC formats that heuristics miss.
        Only used as a last resort when Tiers 1-2 fail.
        """
        import pymupdf

        try:
            doc = pymupdf.open(file_path)
        except Exception as e:
            logger.debug("Cannot open PDF for LLM TOC: %s", str(e))
            return []

        try:
            # Extract text from first 15 pages
            max_pages = min(15, len(doc))
            page_texts = []
            for i in range(max_pages):
                text = doc[i].get_text().strip()
                if text:
                    page_texts.append(f"--- PAGE {i + 1} ---\n{text[:2000]}")

            if not page_texts:
                return []

            combined = "\n".join(page_texts)

            # Use synchronous LLM call (document processing runs in worker threads)
            try:
                # noinspection PyUnresolvedReferences
                import asyncio

                # noinspection PyUnresolvedReferences
                from pydantic import BaseModel, Field

                # noinspection PyUnresolvedReferences
                from pydantic_ai import Agent

                # noinspection PyUnresolvedReferences
                from src.main.utils.llm.agent_model_utils import get_system_agent_model

                class ChapterEntry(BaseModel):
                    page: int = Field(description="1-indexed page number where the chapter starts")
                    title: str = Field(description="Chapter title (without 'Chapter N:' prefix)")

                class ChapterList(BaseModel):
                    chapters: list[ChapterEntry] = Field(default_factory=list)

                agent_config = get_system_agent_model(agent_type="chapter_detector")
                model_string = agent_config.get_pydantic_ai_model()
                # noinspection PyArgumentList
                agent = Agent(
                    model=model_string,
                    system_prompt=(
                        "You analyze PDF page text to find chapter or major section boundaries. "
                        "Return a JSON list of chapters with their starting page numbers and titles. "
                        "Only include top-level chapters/parts, not subsections. "
                        "If this text does not contain identifiable chapters, return an empty list."
                    ),
                    output_type=ChapterList,
                    retries=1,
                )

                prompt = f"Find the chapter boundaries in this PDF text:\n\n{combined[:8000]}"

                # Run in event loop if available, otherwise create new one
                try:
                    asyncio.get_running_loop()
                    # Can't await in sync context - fall back to asyncio.run
                    raise RuntimeError("Cannot run async in sync context")
                except RuntimeError:
                    # noinspection PyTypeChecker
                    result = asyncio.run(agent.run(user_prompt=prompt))

                if result is None:
                    return []
                chapters = []
                for i, ch in enumerate(result.output.chapters):
                    page_num = ch.page - 1  # Convert to 0-indexed
                    if page_num < 0:
                        page_num = 0
                    clean = _clean_title(ch.title)
                    ch_num = _parse_chapter_number(ch.title)
                    if ch_num is None:
                        ch_num = i + 1
                    chapters.append((page_num, ch_num, clean))

                return chapters if len(chapters) >= 2 else []

            except ImportError:
                logger.debug("Pydantic AI not available for LLM TOC detection")
                return []
            except Exception as llm_err:
                logger.debug("LLM TOC detection failed: %s", str(llm_err)[:200])
                return []

        finally:
            doc.close()
