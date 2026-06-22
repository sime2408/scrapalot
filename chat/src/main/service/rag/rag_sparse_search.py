"""
RAG Sparse Search Strategy - BM25-based keyword retrieval.

Uses a two-phase approach:
1. Dense similarity fetch for corpus building (broad candidate set from pgvector)
2. BM25 re-ranking for precise keyword matching

This strategy is optimal when query_hints.keyword_importance > 0.7 or
preferred_search_mode == "sparse_lexical" — i.e. queries with exact codes,
rare technical terms, proper nouns, or quoted phrases that semantic embeddings
tend to miss.
"""

import asyncio
from collections.abc import AsyncGenerator
from uuid import UUID

from langchain_core.documents import Document

from src.main.service.rag.rag_strategy import RAGStrategy
from src.main.service.retriever.retriever import Retriever
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class RAGSparseSearch(RAGStrategy):
    """
    BM25-based sparse keyword search.

    Strategy flow:
    1. Fetch broad candidate set via dense similarity (pgvector) — provides corpus
    2. Build in-memory SparseLexicalRetriever (BM25) from those candidates
    3. Re-rank candidates with BM25 keyword score — surfaces exact matches
    4. Optionally boost user-supplied rare_terms from query_hints

    This gives a true BM25 signal (different from cosine similarity) without
    requiring a full-corpus tsvector index. The dense pre-fetch ensures we cover
    semantically related terms even when the exact keyword is absent.
    """

    # Multiplier applied to BM25 scores for terms from query_hints.rare_terms
    RARE_TERM_BOOST = 1.5

    def __init__(self, retriever: Retriever, llm, packet_emitter=None):
        super().__init__(llm, retriever=retriever, packet_emitter=packet_emitter)

    async def execute(
        self,
        query: str,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
        top_k: int | None = None,
        similarity_threshold: float | None = None,
    ) -> AsyncGenerator[str, None]:
        """Execute sparse BM25 search with dense candidate pre-fetch."""
        _pending_packets: list = []
        for packet in _pending_packets:
            yield packet

        max_results = top_k or resolved_config.get("rag", {}).get("max_results", 10)

        # Resolve rare_terms from query hints (for BM25 boosting)
        rare_terms: list[str] = []
        if self.query_hints:
            rare_terms = self.query_hints.get("rare_terms", [])
            keyword_importance = self.query_hints.get("keyword_importance", 0.5)
            logger.info(
                "RAGSparseSearch: keyword_importance=%.2f, rare_terms=%s",
                keyword_importance,
                rare_terms,
            )

        logger.info(
            "Executing sparse BM25 search for query: %s (collection_ids=%s)",
            query,
            collection_ids,
        )

        try:
            # Step 1: Dense fetch for corpus — retrieve wider candidate set
            candidate_k = max(max_results * 4, 40)
            if document_ids:
                candidates = await self.retriever.process(
                    prompt=query,
                    collection_ids=None,
                    document_ids=document_ids,
                )
            else:
                # Use similarity_search if available for k-control, else process()
                if hasattr(self.retriever, "similarity_search"):
                    candidates = await self.retriever.similarity_search(
                        prompt=query,
                        k=candidate_k,
                        collection_ids=collection_ids,
                    )
                else:
                    candidates = await self.retriever.process(
                        prompt=query,
                        collection_ids=collection_ids,
                    )

            if not candidates:
                logger.warning("RAGSparseSearch: no dense candidates — returning empty")
                self.retrieved_documents = []
                return

            logger.info("RAGSparseSearch: %d dense candidates for BM25 re-ranking", len(candidates))

            # Step 2: BM25 re-ranking in thread executor (CPU-bound)
            loop = asyncio.get_event_loop()
            # noinspection PyTypeChecker
            reranked = await loop.run_in_executor(
                None,
                lambda: self._bm25_rerank(candidates, query, rare_terms, max_results),
            )

            self.retrieved_documents = reranked

        except Exception as exc:
            logger.exception("RAGSparseSearch error: %s", str(exc))
            self.retrieved_documents = []

    def _bm25_rerank(
        self,
        candidates: list[Document],
        query: str,
        rare_terms: list[str],
        top_k: int,
    ) -> list[Document]:
        """Build BM25 index from candidates and return top-k re-ranked documents (sync)."""
        from src.main.service.retriever.lexical_retriever import SparseLexicalRetriever

        retriever = SparseLexicalRetriever(candidates)
        if not retriever.bm25:
            logger.warning("RAGSparseSearch: BM25 index not built — returning dense order")
            return candidates[:top_k]

        scored = retriever.get_relevant_documents(query, top_k=len(candidates))

        # Apply rare_term boost: re-score docs that contain any rare term.
        # Use max(score, floor) before multiplying so zero-BM25 docs with rare terms
        # still rank above zero-BM25 docs without rare terms.
        # noinspection PyPep8Naming
        RARE_FLOOR = 0.05
        if rare_terms:
            rare_lower = [t.lower() for t in rare_terms]
            boosted = []
            for doc in scored:
                content_lower = doc.page_content.lower()
                has_rare = any(t in content_lower for t in rare_lower)
                base_score = doc.metadata.get("score", 0.0)
                if has_rare:
                    boosted_score = max(base_score, RARE_FLOOR) * self.RARE_TERM_BOOST
                else:
                    boosted_score = base_score
                doc.metadata["score"] = boosted_score
                doc.metadata["bm25_boosted"] = has_rare
                boosted.append(doc)

            scored = sorted(boosted, key=lambda d: d.metadata.get("score", 0.0), reverse=True)

        for doc in scored:
            doc.metadata["retrieval_method"] = "sparse_bm25"

        return scored[:top_k]
