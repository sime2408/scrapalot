"""
Document Summary Service

Generates hierarchical summaries for documents:
- Chapter-level summaries from document chunks
- Book-level summary from chapter summaries

Uses the system agent LLM provider (configured via admin settings) for summarization.
"""

from decimal import Decimal
from typing import Any
from uuid import UUID

from pydantic_ai import Agent
from sqlalchemy import text
from sqlmodel import Session, select

from src.main.models.sqlmodel_models import Document, DocumentSummary
from src.main.utils.core.logger import get_logger


async def _embed_text(text_to_embed: str) -> list | None:
    """Embed a single text using the configured embedding model. Returns None on failure."""
    try:
        from src.main.service.llm.llm_factory import get_embeddings_model

        embeddings_model = get_embeddings_model()
        loop = __import__("asyncio").get_event_loop()
        vectors = await loop.run_in_executor(None, embeddings_model.embed_documents, [text_to_embed])
        return vectors[0] if vectors else None
    except Exception as exc:
        get_logger(__name__).warning("Embedding generation failed for summary: %s", exc)
        return None


logger = get_logger(__name__)


class DocumentSummaryService:
    """Service for generating and storing document summaries."""

    def __init__(self, db: Session):
        """
        Initialize the summary service.

        Args:
            db: Database session
        """
        self.db = db

        # Use the system agent model configuration (DB > config.yaml > env vars)
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        agent_config = get_system_agent_model(agent_type="synthesis")
        self.model = agent_config.get_pydantic_ai_model()

        # Create summarization agents
        self.chapter_agent = Agent(
            self.model,
            system_prompt=(
                "You are an expert at summarizing book chapters. "
                "Create concise, informative summaries that capture the main ideas, "
                "key concepts, and important details of each chapter. "
                "Focus on what the chapter teaches and its significance within the book. "
                "Keep summaries between 200-400 words."
            ),
        )

        self.book_agent = Agent(
            self.model,
            system_prompt=(
                "You are an expert at summarizing entire books. "
                "Given summaries of individual chapters, create a comprehensive book summary "
                "that captures the overall themes, main arguments, key insights, and significance. "
                "Synthesize the chapter summaries into a coherent overview. "
                "Keep the book summary between 400-800 words."
            ),
        )

        logger.info(
            "DocumentSummaryService initialized with model: %s",
            agent_config.get_pydantic_ai_model_string(),
        )

    @staticmethod
    def _extract_chapters_from_hierarchy(document_hierarchy: dict[str, Any]) -> list[dict[str, Any]]:
        """
        Extract chapter-level entries from a document hierarchy tree.

        The chunker emits hierarchies in two shapes that show up in production:

          (a) flat — every top-level key already has a ``chunk_range`` and is a
              real chapter. Common for clean PDFs whose chapter detection found
              real H1 headings ("PART 1", "PART 2", ...).

          (b) nested — there is a single root key (often "Introduction" or the
              book title) that wraps every real chapter under ``children``.
              The root either has no ``chunk_range`` at all, or has a range
              spanning the *entire* book — passing that one entry to a
              chapter-summary LLM means feeding the whole text in one go and
              blowing past the 128 k context window.

        We always prefer the deepest level whose nodes carry their own
        ``chunk_range``. When a parent has children that all carry ranges,
        descend; otherwise fall back to the parent itself (it really is a
        single-chapter doc). This way both shapes produce one chapter per
        real heading, not one chapter for the entire book.
        """

        def _collect(level: dict[str, Any], depth: int = 0) -> list[dict[str, Any]]:
            ranged_here: list[dict[str, Any]] = []
            descend_yields: list[dict[str, Any]] = []

            for heading, data in level.items():
                if not isinstance(data, dict):
                    continue
                children = data.get("children") if isinstance(data.get("children"), dict) else None

                # If the node has children that themselves have chunk_ranges,
                # those children are the real chapters — descend.
                if children and any(isinstance(v, dict) and "chunk_range" in v for v in children.values()):
                    nested = _collect(children, depth + 1)
                    if nested:
                        descend_yields.extend(nested)
                        continue

                if "chunk_range" in data:
                    ranged_here.append(
                        {
                            "title": heading,
                            "level": data.get("heading_level", depth + 1),
                            "chunk_start": data["chunk_range"][0],
                            "chunk_end": data["chunk_range"][1],
                        }
                    )

            # Combine descended (granular) children with top-level entries
            # that didn't descend. The earlier `descend_yields or ranged_here`
            # was a hard either/or that silently dropped top-level chapters
            # whenever ANY single top-level key had descendable children —
            # observed on "Advances in Pig Welfare" (Spinka 2017) where
            # "Introduction" had a child sub-chapter, so the function
            # returned just that one nested entry and ignored the four
            # other top-level chapters (Slaughter, Transport, "1.2)…",
            # "Tail biting"). Using `+` keeps both: descended chapters
            # for parents that have rich sub-structure, and the parent
            # itself for top-level keys that are leaf chapters. Each
            # top-level key that descended already used `continue` above
            # so it doesn't double-appear in ranged_here.
            return descend_yields + ranged_here

        chapters = _collect(document_hierarchy)
        chapters.sort(key=lambda c: c["chunk_start"])
        return chapters

    async def generate_chapter_summary(
        self,
        document_id: UUID,
        user_id: UUID,
        chapter_title: str,
        chapter_index: int,
        chunk_start: int,
        chunk_end: int,
    ) -> DocumentSummary | None:
        """
        Generate summary for a single chapter.

        Args:
            document_id: Document ID
            user_id: User ID
            chapter_title: Chapter title/heading
            chapter_index: Chapter index (0-based)
            chunk_start: Starting chunk index
            chunk_end: Ending chunk index

        Returns:
            DocumentSummary object or None if failed
        """
        # Defensive truncation: document_summaries.chapter_title is varchar(500).
        # When the chunker leaks body text into a heading (observed on
        # flat-markdown EPUB where a real `CHAPTER N.` marker is followed by
        # several paragraphs of text the chunker absorbed into the title),
        # an unbounded chapter_title silently crashes the INSERT with
        # StringDataRightTruncation, the exception is swallowed by the
        # caller's `except Exception` block, and the operator sees
        # `chapters_found=N, generated=0` after the LLM cost has already
        # been spent. Truncate to 497 + "…" so the row lands. Schema widen
        # to TEXT is the longer-term fix (Alembic), this is the immediate
        # one.
        _CHAPTER_TITLE_MAX = 500
        if chapter_title and len(chapter_title) > _CHAPTER_TITLE_MAX:
            logger.warning(
                "chapter_title for doc %s exceeds %d chars (%d), truncating",
                document_id,
                _CHAPTER_TITLE_MAX,
                len(chapter_title),
            )
            chapter_title = chapter_title[: _CHAPTER_TITLE_MAX - 1] + "…"

        try:
            # Fetch chunks for this chapter from langchain_pg_embedding table
            chunks_query = text("""
                SELECT document, (cmetadata->>'chunk_index')::int as chunk_index
                FROM langchain_pg_embedding
                WHERE cmetadata->>'document_id' = :document_id
                AND (cmetadata->>'chunk_index')::int >= :chunk_start
                AND (cmetadata->>'chunk_index')::int <= :chunk_end
                ORDER BY (cmetadata->>'chunk_index')::int
                """)

            # noinspection PyTypeChecker, PyDeprecationWarning, PyDeprecationInspection
            result = self.db.execute(
                chunks_query,
                {
                    "document_id": str(document_id),
                    "chunk_start": chunk_start,
                    "chunk_end": chunk_end,
                },
            ).fetchall()

            # Hierarchy / chunk-table drift fallback. The chunker rewrites
            # `langchain_pg_embedding` whenever a doc is reprocessed but
            # `documents.document_hierarchy` is only refreshed on the
            # graph-build phase, so a chapter range like `[400, 428]` can
            # point past the actual `MAX(chunk_index)` (e.g. 289). When
            # the strict range returns nothing, retry with the OPEN
            # interval `chunk_index >= chunk_start` so a slightly stale
            # hierarchy still produces a summary instead of a silent
            # zero-chapter result.
            if not result:
                # noinspection PyTypeChecker, PyDeprecationWarning, PyDeprecationInspection
                fallback = self.db.execute(
                    text("""
                        SELECT document, (cmetadata->>'chunk_index')::int as chunk_index
                        FROM langchain_pg_embedding
                        WHERE cmetadata->>'document_id' = :document_id
                          AND (cmetadata->>'chunk_index')::int >= :chunk_start
                        ORDER BY (cmetadata->>'chunk_index')::int
                        """),
                    {
                        "document_id": str(document_id),
                        "chunk_start": chunk_start,
                    },
                ).fetchall()
                if fallback:
                    logger.info(
                        "Chapter '%s' (range %d-%d) was out-of-bounds; using %d open-ended chunks ≥ %d",
                        chapter_title,
                        chunk_start,
                        chunk_end,
                        len(fallback),
                        chunk_start,
                    )
                    result = fallback

            if not result:
                # Still empty — try the whole-document fallback. A doc with
                # a single root "Section 1"-style hierarchy whose range no
                # longer corresponds to anything in the chunk table is
                # better summarised from chunk 0 than emitting zero
                # summaries silently.
                # noinspection PyTypeChecker, PyDeprecationWarning, PyDeprecationInspection
                full = self.db.execute(
                    text("""
                        SELECT document, (cmetadata->>'chunk_index')::int as chunk_index
                        FROM langchain_pg_embedding
                        WHERE cmetadata->>'document_id' = :document_id
                        ORDER BY (cmetadata->>'chunk_index')::int
                        """),
                    {"document_id": str(document_id)},
                ).fetchall()
                if full:
                    logger.warning(
                        "Chapter '%s' (range %d-%d) has no matching chunks at all; falling back to whole-doc summary across %d chunks",
                        chapter_title,
                        chunk_start,
                        chunk_end,
                        len(full),
                    )
                    result = full

            if not result:
                logger.warning(
                    "No chunks found for chapter: %s (chunks %d-%d)",
                    chapter_title,
                    chunk_start,
                    chunk_end,
                )
                return None

            # Combine chunk content (document field contains the text)
            chapter_text = "\n\n".join(row[0] for row in result)

            # 128 k context cap on gpt-4o-mini. Dense English text encodes
            # at roughly 3.1 chars/token, NOT the 4 chars/token rule of
            # thumb — measured: a 400 k-char chapter went to 129 k tokens
            # and tripped `context_length_exceeded`. We cap at 350 k chars
            # (~113 k tokens) which leaves ~15 k tokens for the system
            # prompt + 500-token output. Real-world overflow happens when a
            # chunker emits a single wrapper "Section" covering the whole
            # book; the chapter cannot be summarised in one shot anyway, so
            # we take a head + tail sample which still grounds the summary.
            _CHAPTER_TEXT_CAP = 350_000
            if len(chapter_text) > _CHAPTER_TEXT_CAP:
                head = chapter_text[: _CHAPTER_TEXT_CAP // 2]
                tail = chapter_text[-(_CHAPTER_TEXT_CAP // 2) :]
                logger.warning(
                    "Chapter '%s' is %d chars — exceeds %d-char cap, sampling head+tail",
                    chapter_title,
                    len(chapter_text),
                    _CHAPTER_TEXT_CAP,
                )
                chapter_text = head + "\n\n[... middle of chapter truncated for context-window safety ...]\n\n" + tail

            logger.info(
                "Generating summary for chapter '%s' (chunks %d-%d, %d chars)",
                chapter_title,
                chunk_start,
                chunk_end,
                len(chapter_text),
            )

            # Generate summary using Pydantic AI agent
            prompt = f"Summarize this chapter titled '{chapter_title}':\n\n{chapter_text}"
            result = await self.chapter_agent.run(prompt)
            from src.main.utils.llm.usage_tracker import track_agent_usage

            track_agent_usage(result, agent_type="chapter_summary", model="openai:gpt-4o-mini")

            summary_text = result.output

            # Estimate token count (rough approximation: 1 token ≈ 4 chars)
            token_count = len(chapter_text) // 4

            # Embed the summary text for semantic retrieval in rag_hybrid_summary_search
            summary_embedding = await _embed_text(summary_text)

            # Create summary record
            summary = DocumentSummary(
                document_id=document_id,
                user_id=user_id,
                summary_type="chapter",
                summary_text=summary_text,
                chapter_title=chapter_title,
                chapter_index=chapter_index,
                chunk_start_index=chunk_start,
                chunk_end_index=chunk_end,
                token_count=token_count,
                model_used="gpt-4o-mini",
                generation_cost=Decimal("0.0001"),  # Approximate cost
                embedding=summary_embedding,
            )

            self.db.add(summary)
            self.db.commit()
            self.db.refresh(summary)

            logger.info(
                "Generated summary for chapter '%s': %d words",
                chapter_title,
                len(summary_text.split()),
            )

            return summary

        except Exception as e:
            logger.exception("Error generating chapter summary for '%s': %s", chapter_title, str(e))
            self.db.rollback()
            return None

    async def generate_book_summary(
        self,
        document_id: UUID,
        user_id: UUID,
        document_name: str,
        chapter_summaries: list[DocumentSummary],
    ) -> DocumentSummary | None:
        """
        Generate summary for entire book from chapter summaries.

        Args:
            document_id: Document ID
            user_id: User ID
            document_name: Document filename/title
            chapter_summaries: List of chapter summary objects

        Returns:
            DocumentSummary object or None if failed
        """
        try:
            if not chapter_summaries:
                logger.warning(
                    "No chapter summaries available for book summary: %s",
                    document_name,
                )
                return None

            # Combine chapter summaries
            combined_summaries = []
            for idx, chapter_summary in enumerate(chapter_summaries, 1):
                combined_summaries.append(f"Chapter {idx}: {chapter_summary.chapter_title}\n{chapter_summary.summary_text}\n")

            combined_text = "\n\n".join(combined_summaries)

            logger.info(
                "Generating book summary for '%s' from %d chapter summaries",
                document_name,
                len(chapter_summaries),
            )

            # Generate book summary using Pydantic AI agent
            prompt = f"Create a comprehensive summary of the book '{document_name}' based on these chapter summaries:\n\n{combined_text}"
            result = await self.book_agent.run(prompt)
            from src.main.utils.llm.usage_tracker import track_agent_usage

            track_agent_usage(result, agent_type="book_summary", model="openai:gpt-4o-mini")

            summary_text = result.output

            # Calculate total tokens from all chapters
            total_tokens = sum(cs.token_count for cs in chapter_summaries if cs.token_count)

            # Embed the book summary for semantic retrieval
            book_embedding = await _embed_text(summary_text)

            # Create book summary record
            book_summary = DocumentSummary(
                document_id=document_id,
                user_id=user_id,
                summary_type="book",
                summary_text=summary_text,
                chapter_title=None,  # No specific chapter
                chapter_index=None,
                chunk_start_index=0,
                chunk_end_index=max(cs.chunk_end_index for cs in chapter_summaries if cs.chunk_end_index),
                token_count=total_tokens,
                model_used="gpt-4o-mini",
                generation_cost=Decimal("0.0002"),  # Approximate cost
                embedding=book_embedding,
            )

            self.db.add(book_summary)
            self.db.commit()
            self.db.refresh(book_summary)

            logger.info(
                "Generated book summary for '%s': %d words",
                document_name,
                len(summary_text.split()),
            )

            return book_summary

        except Exception as e:
            logger.exception("Error generating book summary for '%s': %s", document_name, str(e))
            self.db.rollback()
            return None

    async def generate_document_summaries(self, document_id: UUID, user_id: UUID) -> dict[str, Any]:
        """
        Generate all summaries for a document (chapters + book).

        This is the main entry point for document summarization.

        Args:
            document_id: Document ID
            user_id: User ID

        Returns:
            Dictionary with summary statistics
        """
        try:
            # Fetch document
            document = self.db.get(Document, document_id)
            if not document:
                logger.error("Document not found: %s", document_id)
                return {"error": "Document not found"}

            # Check if document has hierarchy
            if not document.document_hierarchy:
                logger.warning(
                    "Document %s has no hierarchy, skipping summarization",
                    document.filename,
                )
                return {"error": "No document hierarchy available"}

            logger.info(
                "Starting document summarization for: %s (ID: %s)",
                document.filename,
                document_id,
            )

            # Idempotency. Both `reprocess_document` and the standalone
            # `scrapalot.generate_document_summaries` Celery task call
            # this method. Without an explicit clear, a second run
            # appends a fresh chapter+book set on top of the old one
            # (observed in production: a doc ended up with 24 chapter
            # rows and 2 book rows where 12+1 was correct, because a
            # manual backfill script ran in parallel with the Celery
            # dispatch). Wipe the existing rows for this document up
            # front so the operation is truly idempotent.
            deleted = self.db.execute(
                text("DELETE FROM document_summaries WHERE document_id = CAST(:doc_id AS uuid)"),
                {"doc_id": str(document_id)},
            ).rowcount
            if deleted:
                logger.info(
                    "Cleared %d previous summary rows for %s before regeneration",
                    deleted,
                    document_id,
                )
                self.db.commit()

            # Extract chapters from hierarchy
            chapters = self._extract_chapters_from_hierarchy(document.document_hierarchy)

            if not chapters:
                logger.warning("No chapters found in hierarchy for: %s", document.filename)
                return {"error": "No chapters found in hierarchy"}

            logger.info("Found %d chapters to summarize", len(chapters))

            # Generate chapter summaries
            chapter_summaries = []
            for idx, chapter in enumerate(chapters):
                logger.info(
                    "Summarizing chapter %d/%d: %s",
                    idx + 1,
                    len(chapters),
                    chapter["title"],
                )

                summary = await self.generate_chapter_summary(
                    document_id=document_id,
                    user_id=user_id,
                    chapter_title=chapter["title"],
                    chapter_index=idx,
                    chunk_start=chapter["chunk_start"],
                    chunk_end=chapter["chunk_end"],
                )

                if summary:
                    chapter_summaries.append(summary)

            # Generate book summary from chapter summaries
            book_summary = None
            if chapter_summaries:
                logger.info("Generating overall book summary")
                book_summary = await self.generate_book_summary(
                    document_id=document_id,
                    user_id=user_id,
                    document_name=document.filename,
                    chapter_summaries=chapter_summaries,
                )

            result = {
                "document_id": str(document_id),
                "document_name": document.filename,
                "chapters_found": len(chapters),
                "chapter_summaries_generated": len(chapter_summaries),
                "book_summary_generated": book_summary is not None,
                "total_cost": sum(cs.generation_cost for cs in chapter_summaries if cs.generation_cost)
                + (book_summary.generation_cost if book_summary else Decimal("0")),
            }

            logger.info("Document summarization complete: %s", result)

            # Community Edition: knowledge-graph chapter-summary sync is not bundled.

            return result

        except Exception as e:
            logger.exception("Error in generate_document_summaries: %s", str(e))
            return {"error": str(e)}

    def get_document_summary(self, document_id: UUID) -> str | None:
        """
        Get the book-level summary for a document.

        Args:
            document_id: Document ID

        Returns:
            Summary text or None if not found
        """
        try:
            summary_query = select(DocumentSummary).where(DocumentSummary.document_id == document_id).where(DocumentSummary.summary_type == "book")

            summary = self.db.exec(summary_query).first()
            return summary.summary_text if summary else None

        except Exception as e:
            logger.exception("Error fetching document summary: %s", str(e))
            return None

    def get_chapter_summaries(self, document_id: UUID) -> list[DocumentSummary]:
        """
        Get all chapter summaries for a document.

        Args:
            document_id: Document ID

        Returns:
            List of DocumentSummary objects
        """
        try:
            summaries_query = (
                select(DocumentSummary)
                .where(DocumentSummary.document_id == document_id)
                .where(DocumentSummary.summary_type == "chapter")
                .order_by(DocumentSummary.chapter_index)
            )

            return list(self.db.exec(summaries_query).all())

        except Exception as e:
            logger.exception("Error fetching chapter summaries: %s", str(e))
            return []
