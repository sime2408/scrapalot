from collections.abc import AsyncGenerator
from uuid import UUID

from src.main.service.rag.rag_strategy import RAGStrategy
from src.main.service.rag.rag_utils import rerank_documents
from src.main.service.retriever.retriever import Retriever
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger
from src.main.utils.rag.prompt_utils import create_rag_prompt_template

logger = get_logger(__name__)


class RAGSimilaritySearch(RAGStrategy):
    def __init__(self, retriever: Retriever, llm, packet_emitter=None):
        super().__init__(llm, retriever=retriever, packet_emitter=packet_emitter)

        # Create standard RAG prompt template
        self.prompt_template = create_rag_prompt_template()

    async def execute(
        self,
        query: str,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
        top_k: int | None = None,
        similarity_threshold: float | None = None,
    ) -> AsyncGenerator[str, None]:
        """
        Execute a similarity search for the given query.

        This method:
        1. Performs initial retrieval using retriever
        2. Reranks the documents for best ordering
        3. Limits to max_results

        Args:
                query: The search query
                collection_ids: Optional list of collection IDs to search in
                document_ids: Optional list of specific document IDs to search
                top_k: Number of documents to retrieve (optional)
                similarity_threshold: Minimum similarity score (optional)

        Yields:
                Nothing (this is a simple strategy, no thinking tokens)
        """
        _pending_packets: list = []
        for packet in _pending_packets:
            yield packet

        logger.info(
            "Executing similarity search for query: %s, collection_ids: %s, document_ids: %s",
            query,
            collection_ids,
            document_ids,
        )

        # Initial retrieval
        docs = await self.retriever.process(prompt=query, collection_ids=collection_ids, document_ids=document_ids)

        if not docs:
            logger.warning("No documents found in initial retrieval")
            self.retrieved_documents = []
        else:
            # Rerank documents directly (skip LLM-based score_relevance which is slow and filters aggressively)
            reranked_docs = await rerank_documents(query, docs, self.retriever)

            max_results = resolved_config.get("rag", {}).get("max_results", 10)
            final_docs = reranked_docs[:max_results]

            logger.info("Found %d relevant documents after reranking", len(final_docs))
            self.retrieved_documents = final_docs

            # Layer 3 — if the retriever's tail-hook augmented the
            # context with bridge chunks (is_bridge=True), swap in the
            # bridge-prepended prompt template so synthesis receives the
            # cross-domain guidance block. No-op when bridge mode is disabled
            # or no bridge docs landed — prompt stays the default.
            await self._maybe_apply_bridge_prompt(query, collection_ids, final_docs)

        return

    async def _maybe_apply_bridge_prompt(
        self,
        query: str,
        collection_ids: list[UUID] | None,
        final_docs: list,
    ) -> None:
        # (CE) Cross-domain "bridge mode" relies on the knowledge graph, which is a
        # hosted-only feature. No-op in the Community Edition.
        return
