"""
Real-time citation extraction from streaming LLM responses.
"""

from dataclasses import dataclass
import os
import re

from langchain_core.documents import Document

from src.main.dto.streaming import CitationInfoPacket
from src.main.utils.core.logger import get_logger
from src.main.utils.text.formatting import truncate_at_word_boundary

logger = get_logger(__name__)


def _prettify_stored_filename(name: str) -> str:
    """Turn a stored upload filename into a readable citation title.

    Uploads land on disk as ``scrapalot_<uuid>_<sanitized-original>.<ext>`` (the
    uuid namespaces the file). Used only as the LAST fallback when neither the
    extracted metadata nor ``documents.title`` has a title — strip the prefix +
    uuid + extension and de-underscore so a citation reads like a title instead
    of leaking the raw on-disk name.
    """
    base = os.path.basename(name or "")
    base = re.sub(r"\.(epub|pdf|docx?|txt|md|rtf|html?)$", "", base, flags=re.IGNORECASE)
    base = re.sub(
        r"^scrapalot_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_",
        "",
        base,
        flags=re.IGNORECASE,
    )
    base = base.replace("_", " ").strip()
    return base or (name or "")


@dataclass
class CitationMatch:
    """Represents a citation match found in text"""

    citation_nums: list[int]
    start_pos: int
    end_pos: int
    original_text: str


class StreamingCitationProcessor:
    """
    Processes tokens in real-time to extract citation markers.

    Supports formats:
    - [1], [2], [3]
    - [1,2,3]
    - [1, 2, 3]
    - [[1]], [[2]]
    - [[1]](url)
    """

    def __init__(
        self,
        context_docs: list[Document],
        max_citation_num: int | None = None,
        user_query: str | None = None,
    ):
        """
        Initialize citation processor.

        Args:
            context_docs: Retrieved documents that can be cited
            max_citation_num: Maximum valid citation number (defaults to len(context_docs))
            user_query: The user's question (used as the claim for Smart Citation
                stance classification). When None, stance classification is skipped.
        """
        self.context_docs = context_docs
        self.user_query = user_query
        # Track all emitted citations so we can retro-classify them as one batch
        self._emitted_citations: list[CitationInfoPacket] = []
        self.max_citation_num = max_citation_num if max_citation_num is not None else len(context_docs)

        # Validate max_citation_num doesn't exceed available documents
        if self.max_citation_num > len(context_docs):
            logger.warning(
                "max_citation_num (%s) exceeds available documents (%s). Capping to %s",
                self.max_citation_num,
                len(context_docs),
                len(context_docs),
            )
            self.max_citation_num = len(context_docs)

        # Preload enriched metadata for citation formatting
        self._doc_metadata: dict[str, dict] = {}
        try:
            self._load_enriched_metadata()
        except Exception as e:
            logger.debug("Could not pre-load enriched metadata: %s", e)

        # Tracking state
        self.buffer = ""  # Accumulated tokens for pattern matching
        self.in_code_block = False
        self.code_block_count = 0
        self.cited_documents = set()  # Document IDs already cited
        self.recent_citations = set()  # Recently cited (within last N chars)
        self.non_citation_chars = 0  # Chars since last citation

        # Citation patterns
        # Matches: [1], [2,3], [1, 2], etc.
        self.citation_pattern = re.compile(r"\[(\d+(?:,\s*\d+)*)\]")
        # Matches: [[1]], [[2]], etc.
        self.double_bracket_pattern = re.compile(r"\[\[(\d+)\]\]")
        # Matches incomplete citations: [, [1, [1,, etc.
        self.possible_citation = re.compile(r"\[\d*,?\s*$")

    def _load_enriched_metadata(self):
        """Preload extracted_metadata for all context documents in one DB query."""
        doc_ids = []
        for doc in self.context_docs:
            did = doc.metadata.get("document_id")
            if did and did not in self._doc_metadata:
                doc_ids.append(did)
        if not doc_ids:
            return
        from sqlalchemy import text

        from src.main.config.database import SessionLocal

        db = SessionLocal()
        try:
            # `documents.id` is `uuid`; `doc_ids` is a list of strings
            # extracted from chunk metadata JSON. Postgres refuses
            # `id = ANY(:ids)` with "operator does not exist: uuid = text"
            # — cast both sides to text so the comparison is valid for
            # any UUID format the chunks may have stored.
            rows = db.execute(
                text("SELECT id::text, extracted_metadata FROM documents WHERE id::text = ANY(:ids)"),
                {"ids": doc_ids},
            ).fetchall()
            for row in rows:
                meta = row[1]
                if meta and isinstance(meta, dict):
                    resolved = meta.get("resolved", {})
                    if resolved:
                        self._doc_metadata[row[0]] = resolved
        except Exception as e:
            logger.debug("Enriched metadata query failed: %s", e)
        finally:
            db.close()

    @staticmethod
    def _format_apa_short(resolved: dict) -> str:
        """Build a short APA-style citation string from resolved metadata."""
        authors = resolved.get("authors", [])
        year = resolved.get("year")
        title = resolved.get("title", "")
        parts = []
        if authors:
            last = authors[0].split(",")[0].strip() if "," in authors[0] else authors[0].split()[-1]
            if len(authors) > 2:
                parts.append(f"{last} et al.")
            elif len(authors) == 2:
                last2 = authors[1].split(",")[0].strip() if "," in authors[1] else authors[1].split()[-1]
                parts.append(f"{last} & {last2}")
            else:
                parts.append(last)
        if year:
            parts.append(f"({year})")
        if title:
            parts.append(title[:60] + ("..." if len(title) > 60 else ""))
        return ". ".join(parts) + "." if parts else ""

    def process_token(self, token: str) -> tuple[str, list[CitationInfoPacket]]:
        """
        Process a single token and extract citations.

        Args:
            token: The token string from LLM

        Returns:
            Tuple of (display_text, citations_found)
        """
        self.buffer += token

        # Track code blocks (``` markers)
        if "```" in token:
            self.code_block_count += token.count("```")
            self.in_code_block = self.code_block_count % 2 != 0

        # Don't extract citations from code blocks
        if self.in_code_block:
            result = self.buffer
            self.buffer = ""
            self.non_citation_chars += len(result)
            return result, []

        # Clear recent citations if we've moved past them (>100 chars)
        if self.non_citation_chars > 100:
            self.recent_citations.clear()
            self.non_citation_chars = 0

        # Check for complete citation patterns
        citations_found: list[CitationInfoPacket] = []

        # First check for double-bracket citations [[1]]
        double_matches = list(self.double_bracket_pattern.finditer(self.buffer))

        # Collect positions of double-bracket matches to avoid overlaps
        double_match_ranges = [(m.start(), m.end()) for m in double_matches]

        # Then check for single-bracket citations [1], [1,2], excluding overlaps with double brackets
        single_matches = []
        for match in self.citation_pattern.finditer(self.buffer):
            # Check if this match overlaps with any double-bracket match
            is_overlap = any(match.start() >= start and match.end() <= end for start, end in double_match_ranges)
            if not is_overlap:
                single_matches.append(match)

        # Combine all matches and sort by position
        all_matches = double_matches + single_matches

        if not all_matches:
            # Check if buffer could be start of citation
            if self.possible_citation.search(self.buffer):
                # Hold the buffer, might be incomplete citation
                # But prevent unbounded growth - max 50 chars for incomplete citation
                if len(self.buffer) > 50:
                    result = self.buffer
                    self.buffer = ""
                    self.non_citation_chars += len(result)
                    return result, []
                return "", []
            else:
                # No citations, return buffer
                result = self.buffer
                self.buffer = ""
                self.non_citation_chars += len(result)
                return result, []

        # Process found citations
        result = ""
        last_end = 0

        for match in sorted(all_matches, key=lambda m: m.start()):
            # Add text before citation
            result += self.buffer[last_end : match.start()]

            # Parse citation numbers
            nums_str = match.group(1)
            citation_nums = [int(n.strip()) for n in nums_str.split(",")]

            # Process each citation number
            formatted_citations = []
            for num in citation_nums:
                # Validate citation number and document availability
                if not (1 <= num <= self.max_citation_num):
                    logger.warning("Invalid citation number: %s", num)
                    continue

                # Get the referenced document with bounds check
                doc_idx = num - 1
                if doc_idx >= len(self.context_docs):
                    logger.warning("Citation %s exceeds available documents (%s)", num, len(self.context_docs))
                    continue

                doc = self.context_docs[doc_idx]

                # Use citation number as dedup key (not doc_id) because
                # multiple chunks from the same document have different citation numbers
                citation_key = num

                # Check if already cited recently
                if citation_key in self.recent_citations:
                    logger.debug("Skipping duplicate citation: %s", num)
                    continue

                # Mark as cited
                self.recent_citations.add(citation_key)
                self.non_citation_chars = 0

                # Create citation packet (only if new in this response)
                if citation_key not in self.cited_documents:
                    self.cited_documents.add(citation_key)
                    citation_packet = self._build_packet(num, doc)
                    citations_found.append(citation_packet)
                    self._emitted_citations.append(citation_packet)

                # Format citation for display
                formatted_citations.append(f"[[{num}]]")

            # Add formatted citations to result
            if formatted_citations:
                result += "".join(formatted_citations)

            last_end = match.end()

        # Keep remaining buffer
        self.buffer = self.buffer[last_end:]

        return result, citations_found

    def _build_packet(self, num: int, doc) -> CitationInfoPacket:
        """Construct a CitationInfoPacket for citation `num` referencing `doc`.
        Shared by inline-[N] marker extraction and the no-marker fallback so both
        produce identical, fully-resolved citation cards (URL, APA, excerpt)."""
        doc_id = doc.metadata.get("document_id", f"doc_{num}")

        # Extract filename — try source, then file_name from metadata
        source = doc.metadata.get("source") or doc.metadata.get("file_name") or f"Document {num}"
        if "/" in source or "\\" in source:
            source = os.path.basename(source)

        # Construct URL for PDF viewer
        full_path = doc.metadata.get("file_path") or doc.metadata.get("url") or doc.metadata.get("source") or ""

        # Resolved (extracted) metadata is the first-choice title source.
        resolved = self._doc_metadata.get(doc_id, {})
        # Single DB lookup for file_path AND the canonical documents.title — run
        # when either is needed. Chunk metadata often lacks a file_path, and the
        # extracted-metadata title is frequently empty, in which case the clean
        # human title lives in documents.title. Without this the citation fell
        # back to the raw "scrapalot_<uuid>_<name>.epub" stored filename.
        db_title = ""
        needs_title = not resolved.get("title")
        # Chunk metadata sometimes carries a non-servable processing path
        # (/app/data/tmp/scrapalot_<uuid>_…) instead of the canonical
        # data/upload/ location — the viewer URL builder can't map /tmp/, so the
        # citation can't open the source. documents.file_path holds the correct
        # path, so treat a tmp path as "needs DB lookup" and let it override.
        _is_tmp_path = "/tmp/" in full_path or "/data/tmp/" in full_path
        is_uuid_id = isinstance(doc_id, str) and len(doc_id) == 36 and doc_id.count("-") == 4
        if is_uuid_id and (not full_path or needs_title or _is_tmp_path):
            try:
                from sqlalchemy import text as sa_text

                from src.main.config.database import SessionLocal

                _db = SessionLocal()
                try:
                    _row = _db.execute(sa_text("SELECT file_path, title FROM documents WHERE id = :did"), {"did": doc_id}).fetchone()
                    if _row:
                        if _row[0] and (not full_path or _is_tmp_path):
                            full_path = _row[0]
                        if needs_title and _row[1]:
                            db_title = str(_row[1])
                finally:
                    _db.close()
            except Exception as e:
                logger.debug("Non-critical citation title/path lookup failed: %s", e)

        # Extract the path starting from "data/upload/" using shared utility
        from src.main.utils.files.paths import normalize_upload_path_to_url

        url = normalize_upload_path_to_url(full_path, source)
        logger.debug("Citation URL for [%s]: full_path='%s' -> url='%s'", num, full_path, url)

        # Title preference: extracted metadata → documents.title → cleaned filename.
        enriched_title: str = str(resolved.get("title") or db_title or _prettify_stored_filename(source))
        raw_authors = resolved.get("authors")
        enriched_authors: list[str] | None = list(raw_authors) if isinstance(raw_authors, list) else None
        raw_year = resolved.get("year")
        # noinspection PyTypeChecker
        enriched_year: int | None = int(raw_year) if raw_year is not None else None
        formatted = self._format_apa_short(resolved) if resolved else None

        # noinspection PyTypeChecker
        return CitationInfoPacket(
            citation_num=num,
            document_id=doc_id,
            document_title=enriched_title,
            page=doc.metadata.get("page"),
            url=url,
            score=doc.metadata.get("score"),
            text=truncate_at_word_boundary(doc.page_content, 800) if doc.page_content else None,
            # citation_context is a compact, sentence-bounded excerpt used by
            # the UI as a blockquote under the citation card. ≤280 chars so it
            # fits cleanly into the popover without further truncation.
            citation_context=truncate_at_word_boundary(doc.page_content, 280) if doc.page_content else None,
            chunk_index=doc.metadata.get("chunk_index"),
            file_type=doc.metadata.get("type"),
            authors=enriched_authors,
            year=enriched_year,
            formatted_citation=formatted,
            is_bridge=bool(doc.metadata.get("is_bridge", False)),
            source_collection_id=doc.metadata.get("source_collection_id"),
            bridge_anchors=doc.metadata.get("bridge_anchors") or None,
            chunk_position_json=doc.metadata.get("position_json"),
        )

    def fallback_cite_top_docs(self, top_k: int = 5) -> list[CitationInfoPacket]:
        """No inline [N] markers were emitted by the model — attribute the top-k
        retrieved documents as document-level citations so the answer is still
        grounded. Returns [] when any citation was already emitted (markers found),
        so it never double-cites. context_docs are pre-deduplicated by the caller."""
        if self._emitted_citations:
            return []
        out: list[CitationInfoPacket] = []
        seen: set = set()
        for doc in self.context_docs:
            did = doc.metadata.get("document_id", id(doc))
            if did in seen:
                continue
            seen.add(did)
            num = len(out) + 1
            pkt = self._build_packet(num, doc)
            self.cited_documents.add(num)
            out.append(pkt)
            self._emitted_citations.append(pkt)
            if len(out) >= top_k:
                break
        return out

    async def classify_stance_batch(self) -> list[CitationInfoPacket]:
        """
        Run Smart Citation stance classification on all emitted citations.
        Returns a list of updated CitationInfoPacket objects (same citation_num)
        with stance + stance_confidence + stance_rationale populated. Callers
        should re-emit these so the frontend can colour existing chips.

        Gracefully degrades: if user_query is None, or classifier fails, returns [].

        Smart Citation stance classification lives in the notes_assistant feature
        set, which is removed in the Community Edition. This method therefore
        returns [] so callers fall back to plain (un-stanced) citation chips.
        """
        return []

    def flush(self) -> tuple[str, list[CitationInfoPacket]]:
        """
        Flush any remaining buffer content and extract any final citations.
        Call this when the stream ends.
        """
        if not self.buffer:
            return "", []

        # Process the remaining buffer one last time to catch any citations
        # that might have been held back waiting for more tokens
        final_text, citations = self.process_token("")

        # Add any remaining buffer content
        if self.buffer:
            final_text += self.buffer
            self.buffer = ""

        return final_text, citations


def normalize_citation_format(text: str) -> str:
    """
    Normalize various citation formats to standard [[n]] format.

    Examples:
        [1] -> [[1]]
        [1,2] -> [[1]][[2]]
        [[1]] -> [[1]] (unchanged)
    """

    # Convert [1,2,3] to [[1]][[2]][[3]]
    def replace_single(match):
        nums = [n.strip() for n in match.group(1).split(",")]
        return "".join(f"[[{n}]]" for n in nums)

    text = re.sub(r"\[(\d+(?:,\s*\d+)*)\]", replace_single, text)
    return text
