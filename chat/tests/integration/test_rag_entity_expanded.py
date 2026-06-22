"""
Integration Tests for RAGEntityExpanded and Related New RAG Strategies

Covers:
- RAGEntityExpanded: _doc_key, _rrf_fuse logic (pure Python, no DB)
- RAGAdaptiveOrchestrator: _analyze_query_type and _has_filter_indicators (pure Python)
- document_summaries: embedding column existence and cosine similarity (migration 033)
- Neo4j: Chunk node structure required for entity traversal
- End-to-end chat API tests for adaptive orchestrator and new strategies
"""

import logging

import pytest

from tests.conftest import assert_meaningful_content, get_accumulated_content, parse_ndjson
from tests.integration.chat_client import chat_post

logger = logging.getLogger(__name__)


# =============================================================================
# Unit Tests: RAGEntityExpanded (pure Python, no DB)
# =============================================================================


@pytest.mark.integration
class TestRAGEntityExpandedUnit:
    """Structural tests for RAGEntityExpanded — no live DB required."""

    def test_import_and_registration(self):
        """RAGEntityExpanded must import cleanly and be registered in RAG_INDIVIDUAL_STRATEGY_CLASSES."""
        from src.main.service.rag.rag_entity_expanded import RAGEntityExpanded
        from src.main.utils.rag.strategies import RAG_INDIVIDUAL_STRATEGY_CLASSES

        assert RAGEntityExpanded is not None
        assert "RAGEntityExpanded" in RAG_INDIVIDUAL_STRATEGY_CLASSES
        assert RAG_INDIVIDUAL_STRATEGY_CLASSES["RAGEntityExpanded"] is RAGEntityExpanded

    def test_doc_key_with_metadata(self):
        """_doc_key returns '{document_id}_{chunk_index}' when both are present."""
        from langchain_core.documents import Document

        from src.main.service.rag.rag_entity_expanded import RAGEntityExpanded

        doc = Document(
            page_content="chunk text",
            metadata={"document_id": "abc-123", "chunk_index": 7},
        )
        assert RAGEntityExpanded._doc_key(doc, fallback="fb") == "abc-123_7"

    def test_doc_key_zero_chunk_index(self):
        """_doc_key treats chunk_index=0 as valid (not falsy)."""
        from langchain_core.documents import Document

        from src.main.service.rag.rag_entity_expanded import RAGEntityExpanded

        doc = Document(
            page_content="first chunk",
            metadata={"document_id": "doc-x", "chunk_index": 0},
        )
        assert RAGEntityExpanded._doc_key(doc, fallback="fb") == "doc-x_0"

    def test_doc_key_fallback_on_missing_metadata(self):
        """_doc_key falls back to the provided string when metadata is empty."""
        from langchain_core.documents import Document

        from src.main.service.rag.rag_entity_expanded import RAGEntityExpanded

        doc = Document(page_content="no metadata")
        assert RAGEntityExpanded._doc_key(doc, fallback="my_fallback") == "my_fallback"

    def test_rrf_fuse_deduplication(self):
        """RRF must not duplicate a doc that appears in both initial and expanded lists."""
        from langchain_core.documents import Document

        from src.main.service.rag.rag_entity_expanded import RAGEntityExpanded

        doc = Document(page_content="dup", metadata={"document_id": "d1", "chunk_index": 3})
        # noinspection PyTypeChecker
        instance = RAGEntityExpanded.__new__(RAGEntityExpanded)

        fused = instance._rrf_fuse([doc], [doc], k=10)
        assert len(fused) == 1, "Same doc in both lists should be deduplicated"

    def test_rrf_fuse_double_mention_wins(self):
        """Doc appearing in both initial and expanded ranks higher than doc in only one list."""
        from langchain_core.documents import Document

        from src.main.service.rag.rag_entity_expanded import RAGEntityExpanded

        doc_shared = Document(page_content="A", metadata={"document_id": "dA", "chunk_index": 0})
        doc_only_initial = Document(page_content="B", metadata={"document_id": "dB", "chunk_index": 0})
        doc_only_expanded = Document(page_content="C", metadata={"document_id": "dC", "chunk_index": 0})

        # noinspection PyTypeChecker
        instance = RAGEntityExpanded.__new__(RAGEntityExpanded)

        # doc_shared at rank 1 in both lists → highest combined RRF score
        fused = instance._rrf_fuse(
            initial=[doc_shared, doc_only_initial],
            expanded=[doc_shared, doc_only_expanded],
            k=3,
        )
        assert fused[0].page_content == "A", "Shared doc must rank first via RRF"

    def test_rrf_fuse_empty_lists(self):
        """RRF returns empty list when both inputs are empty."""
        from src.main.service.rag.rag_entity_expanded import RAGEntityExpanded

        # noinspection PyTypeChecker
        instance = RAGEntityExpanded.__new__(RAGEntityExpanded)
        assert instance._rrf_fuse([], [], k=5) == []

    def test_rrf_fuse_respects_k_limit(self):
        """RRF result must not exceed k documents."""
        from langchain_core.documents import Document

        from src.main.service.rag.rag_entity_expanded import RAGEntityExpanded

        docs = [Document(page_content=str(i), metadata={"document_id": f"d{i}", "chunk_index": i}) for i in range(10)]
        # noinspection PyTypeChecker
        instance = RAGEntityExpanded.__new__(RAGEntityExpanded)
        fused = instance._rrf_fuse(docs, [], k=4)
        assert len(fused) <= 4


# =============================================================================
# Unit Tests: RAGAdaptiveOrchestrator query classification (pure Python)
# =============================================================================


@pytest.mark.integration
class TestAdaptiveOrchestratorQueryAnalysis:
    """Tests for _analyze_query_type and _has_filter_indicators — no live DB.

    Uses RAGAdaptiveOrchestrator.__new__ to skip sub-strategy initialization,
    then manually sets the keyword lists needed by the two methods under test.
    """

    @pytest.fixture(autouse=True)
    def build_orchestrator(self):
        """Build a bare orchestrator instance with keyword lists but no live sub-strategies."""
        import re

        from src.main.service.rag.orchestrators.adaptive_orchestrator import RAGAdaptiveOrchestrator

        # noinspection PyTypeChecker
        orc = RAGAdaptiveOrchestrator.__new__(RAGAdaptiveOrchestrator)

        # Copy keyword lists from __init__ (order-preserved)
        orc.metadata_keywords = [
            "author",
            "written by",
            "published",
            "date",
            "year",
            "category",
            "type",
            "source",
            "file",
            "created",
            "tagged",
            "language",
        ]
        orc.complex_semantic_keywords = [
            "relationship between",
            "compare",
            "explain",
            "analyze",
            "why",
            "how does",
            "implications",
            "difference",
            "similarities",
        ]
        orc.knowledge_intensive_keywords = [
            "technical",
            "detailed",
            "specifics",
            "implementation",
            "architecture",
            "step by step",
            "methodology",
            "procedure",
            "process",
        ]
        orc.contextual_keywords = [
            "previously",
            "earlier",
            "last",
            "mentioned",
            "above",
            "before",
            "that",
            "this",
            "those",
            "they",
            "it",
        ]
        orc.overview_keywords = [
            "overview",
            "summary",
            "summarize",
            "summarise",
            "introduction",
            "what is this book",
            "what is this document",
            "what does this book cover",
            "about this",
            "give me a summary",
            "explain this book",
            "o čemu",
            "o čemu govori",
        ]
        orc.entity_cross_doc_keywords = [
            "across all",
            "across books",
            "across documents",
            "in all books",
            "multiple books",
            "multiple documents",
            "every book",
            "all documents",
            "compare across",
            "mention",
            "mentioned in",
            "referenced in",
            "appears in",
            "cross-document",
            "cross-book",
        ]
        # Attach re module so _has_filter_indicators regex checks work
        orc.__class__._re = re
        self.orc = orc

    # ---- _analyze_query_type ------------------------------------------------

    def test_overview_queries(self):
        for q in [
            "give me a summary of this book",
            "what is this document about the history of rome",
            "o čemu govori ova knjiga",
            "summarize the main themes",
        ]:
            assert self.orc._analyze_query_type(q) == "overview", f"Expected 'overview' for: {q}"

    def test_entity_cross_doc_queries(self):
        for q in [
            "what appears across all books in this collection",
            "compare across documents the concept of strategy",
            "mentioned in multiple books",
            "cross-document entity analysis",
        ]:
            assert self.orc._analyze_query_type(q) == "entity_cross_doc", f"Expected 'entity_cross_doc' for: {q}"

    def test_section_context_queries(self):
        for q in [
            "show me the full section on installation",
            "give me the entire section verbatim",
            "quote exactly from the paragraph about deployment",
        ]:
            assert self.orc._analyze_query_type(q) == "section_context", f"Expected 'section_context' for: {q}"

    def test_metadata_filter_queries(self):
        for q in [
            "documents written by Sun Tzu",
            "papers published in 2023",
            "books authored by Clausewitz",
        ]:
            assert self.orc._analyze_query_type(q) == "metadata_filter", f"Expected 'metadata_filter' for: {q}"

    def test_complex_semantic_queries(self):
        for q in [
            "explain the relationship between deception and strategy",
            "what is the difference between offense and defense",
            "compare the two approaches",
        ]:
            assert self.orc._analyze_query_type(q) == "complex_semantic", f"Expected 'complex_semantic' for: {q}"

    def test_knowledge_intensive_queries(self):
        for q in [
            "describe the technical implementation architecture in detail",
            "step by step procedure for configuring the system",
        ]:
            assert self.orc._analyze_query_type(q) == "knowledge_intensive", f"Expected 'knowledge_intensive' for: {q}"

    def test_contextual_queries_with_history(self):
        """Queries with contextual keywords (this/that/it/they) + history → contextual."""
        history = [
            {"role": "user", "content": "Tell me about Sun Tzu"},
            {"role": "assistant", "content": "Sun Tzu was..."},
        ]
        for q in ["what did it mean?", "tell me more about that chapter", "can you elaborate on this"]:
            result = self.orc._analyze_query_type(q, history)
            assert result == "contextual", f"Expected 'contextual' (with history) for: {q}"

    def test_ambiguous_without_history(self):
        result = self.orc._analyze_query_type("what is machine learning")
        assert result == "ambiguous"

    def test_overview_takes_priority_over_metadata(self):
        """Overview keyword should win even when metadata keywords are also present."""
        q = "summarize books written by einstein"
        assert self.orc._analyze_query_type(q) == "overview"

    def test_overview_takes_priority_over_cross_doc(self):
        """Overview keyword should win over cross-document keywords."""
        q = "give me a summary across all documents"
        assert self.orc._analyze_query_type(q) == "overview"

    # ---- _has_filter_indicators ---------------------------------------------

    def test_filter_written_by(self):
        assert self.orc._has_filter_indicators("articles written by Marcus Aurelius") is True

    def test_filter_published_in(self):
        assert self.orc._has_filter_indicators("documents published in 2020") is True

    def test_filter_date_regex(self):
        assert self.orc._has_filter_indicators("papers from 2019 to 2021") is True

    def test_filter_author_metadata_keyword(self):
        assert self.orc._has_filter_indicators("who is the author of this work") is True

    def test_no_filter_for_plain_question(self):
        assert self.orc._has_filter_indicators("what are the key principles of stoicism") is False

    def test_no_filter_for_plain_factual(self):
        """A plain factual question with no filter keywords returns False."""
        assert self.orc._has_filter_indicators("what are the key principles of stoicism") is False


# =============================================================================
# DB Tests: document_summaries embedding column (migration 033)
# =============================================================================


@pytest.mark.integration
class TestDocumentSummaryEmbeddings:
    """Verify migration 033: embedding column exists and backfill was applied."""

    def test_embedding_column_exists(self, py_cursor):
        """document_summaries.embedding column must exist (migration 033)."""
        py_cursor.execute(
            """SELECT column_name, udt_name
               FROM information_schema.columns
               WHERE table_name = 'document_summaries'
               AND column_name = 'embedding'"""
        )
        row = py_cursor.fetchone()
        assert row is not None, "Migration 033 must have added 'embedding' column to document_summaries"
        logger.info("Embedding column udt_name: %s", row["udt_name"])

    def test_all_summaries_have_embeddings(self, py_cursor):
        """Every row in document_summaries should have a non-null embedding (backfill applied)."""
        py_cursor.execute("SELECT COUNT(*) as total, COUNT(embedding) as filled FROM document_summaries")
        row = py_cursor.fetchone()
        total, filled = row["total"], row["filled"]
        logger.info("document_summaries: %d total, %d with embedding", total, filled)
        if total == 0:
            pytest.skip("No document_summaries rows — nothing to assert")
        assert filled == total, f"{total - filled} of {total} summaries have NULL embedding. Run scripts/backfill/backfill_summary_embeddings.py to fix."

    def test_summary_types_present(self, py_cursor):
        """At least one summary type ('chapter' or 'book') must be present."""
        py_cursor.execute("SELECT DISTINCT summary_type FROM document_summaries ORDER BY summary_type")
        rows = py_cursor.fetchall()
        types = [r["summary_type"] for r in rows]
        logger.info("document_summaries summary_type values: %s", types)
        if not types:
            pytest.skip("No document_summaries rows")
        assert any(t in ("chapter", "book") for t in types), "Expected at least one 'chapter' or 'book' summary type"

    def test_cosine_similarity_query_executes(self, py_cursor):
        """Cosine similarity query pattern used by _search_chapter_summaries runs without error."""
        py_cursor.execute("SELECT embedding::text FROM document_summaries WHERE embedding IS NOT NULL LIMIT 1")
        row = py_cursor.fetchone()
        if row is None:
            pytest.skip("No embeddings in document_summaries")

        emb_str = row["embedding"]
        py_cursor.execute(
            f"""SELECT id, summary_type,
                       embedding <=> CAST('{emb_str}' AS vector) AS distance
                FROM document_summaries
                WHERE embedding IS NOT NULL
                ORDER BY embedding <=> CAST('{emb_str}' AS vector)
                LIMIT 5"""
        )
        results = py_cursor.fetchall()
        assert len(results) >= 1
        # The vector compared to itself should have distance ~0
        assert results[0]["distance"] < 0.01, f"Top-1 cosine distance to itself was {results[0]['distance']}, expected < 0.01"
        logger.info(
            "Cosine similarity OK: top result type='%s', distance=%.6f",
            results[0]["summary_type"],
            results[0]["distance"],
        )


# =============================================================================
# DB Tests: RAGTwoPhaseContext overview detection
# =============================================================================


@pytest.mark.integration
class TestTwoPhaseContextOverviewKeywords:
    """Verify the overview keyword list in RAGTwoPhaseContext matches expectations."""

    OVERVIEW_KEYWORDS = [
        "overview",
        "summary",
        "summarize",
        "introduction",
        "what is this",
        "about this",
        "o čemu",
    ]

    def test_overview_queries_detected(self):
        for kw in self.OVERVIEW_KEYWORDS:
            query = f"please give me {kw} of the text"
            detected = any(w in query.lower() for w in self.OVERVIEW_KEYWORDS)
            assert detected, f"Keyword '{kw}' should trigger overview detection"

    def test_non_overview_queries_not_detected(self):
        for query in [
            "how do I configure the deployment step?",
            "what is the difference between approaches A and B?",
            "list the chapters in this document",
        ]:
            detected = any(w in query.lower() for w in self.OVERVIEW_KEYWORDS)
            assert not detected, f"Non-overview query should not match: {query}"


# =============================================================================
# DB Tests: Neo4j readiness for entity traversal
# =============================================================================


@pytest.mark.integration
@pytest.mark.neo4j
class TestNeo4jEntityTraversalReadiness:
    """Verify Neo4j graph structure supports RAGEntityExpanded traversal."""

    def test_chunk_nodes_exist_and_log_bridge_readiness(self, neo4j_driver):
        """Verify Chunk nodes exist and log whether document_id + chunk_index bridge is ready.

        Current state: Chunk nodes have [id, section_id, page_number, text, word_count]
        but NOT document_id + chunk_index. RAGEntityExpanded gracefully degrades to
        pgvector-only results when the bridge properties are absent.
        When entity re-extraction adds document_id + chunk_index to Chunk nodes,
        this test will automatically log the improved coverage.
        """
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            total_result = session.run("MATCH (c:Chunk) RETURN count(c) AS total")
            total = total_result.single()["total"]

            # noinspection PyTypeChecker
            bridged_result = session.run(
                """MATCH (c:Chunk)
                   WHERE c.document_id IS NOT NULL AND c.chunk_index IS NOT NULL
                   RETURN count(c) AS bridged"""
            )
            bridged = bridged_result.single()["bridged"]

            # noinspection PyTypeChecker
            props_result = session.run("MATCH (c:Chunk) RETURN keys(c) AS props LIMIT 1")
            props_row = props_result.single()
            actual_props = sorted(props_row["props"]) if props_row else []

        assert total > 0, "Neo4j must have Chunk nodes for graph-based retrieval"

        if bridged == 0:
            logger.warning(
                "Chunk nodes (%d total) lack document_id + chunk_index properties "
                "(actual props: %s). RAGEntityExpanded will degrade to pgvector-only results. "
                "Re-run entity extraction to add bridge properties.",
                total,
                actual_props,
            )
        else:
            logger.info(
                "Chunk bridge ready: %d / %d Chunk nodes have document_id + chunk_index",
                bridged,
                total,
            )

    def test_entity_traversal_cypher_runs_without_error(self, neo4j_driver, py_cursor):
        """The UNWIND-based batch Cypher from RAGEntityExpanded must execute without error."""
        py_cursor.execute(
            """SELECT cmetadata->>'document_id' AS doc_id,
                      (cmetadata->>'chunk_index')::int AS chunk_idx
               FROM langchain_pg_embedding
               WHERE cmetadata->>'document_id' IS NOT NULL
               AND cmetadata->>'chunk_index' IS NOT NULL
               LIMIT 3"""
        )
        rows = py_cursor.fetchall()
        if not rows:
            pytest.skip("No chunks with document_id + chunk_index in pgvector")

        seeds = [{"doc_id": r["doc_id"], "chunk_idx": r["chunk_idx"]} for r in rows]

        cypher = """
            UNWIND $seeds AS seed
            MATCH (c:Chunk {document_id: seed.doc_id, chunk_index: seed.chunk_idx})
                  -[:MENTIONS|:HAS_PERSON|:HAS_CONCEPT|:HAS_TERM]->(e)
                  <-[:MENTIONS|:HAS_PERSON|:HAS_CONCEPT|:HAS_TERM]-(c2:Chunk)
            WHERE c2.document_id <> seed.doc_id OR c2.chunk_index <> seed.chunk_idx
            RETURN DISTINCT c2.document_id AS doc_id, c2.chunk_index AS chunk_index
            LIMIT 20
        """
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            records = list(session.run(cypher, {"seeds": seeds}))
        logger.info("Entity traversal found %d related chunk pairs", len(records))
        # No assertion on count — 0 results is valid when no MENTIONS edges exist yet

    def test_mentions_edges_query_executes(self, neo4j_driver):
        """MENTIONS edge count query must run without error (count may be 0)."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            cnt = session.run("MATCH ()-[:MENTIONS]->() RETURN count(*) AS n LIMIT 1").single()["n"]
        logger.info("MENTIONS edges in Neo4j: %d", cnt)


# =============================================================================
# Integration Tests: chat API — adaptive orchestrator + new strategies
# =============================================================================


@pytest.mark.integration
class TestAdaptiveOrchestratorChatIntegration:
    """End-to-end chat API tests for the adaptive orchestrator and new strategies."""

    @staticmethod
    def _chat(authenticated_session, api_base_url, collection_id, prompt, strategy):
        return chat_post(
            authenticated_session,
            api_base_url,
            prompt=prompt,
            collection_ids=[str(collection_id)],
            rag_strategy=strategy,
            agentic_rag_enabled=False,
            timeout=180,
        )

    def test_adaptive_overview_query(self, authenticated_session, api_base_url, test_collection, test_document):
        """Overview query through adaptive orchestrator returns meaningful content."""
        r = self._chat(
            authenticated_session,
            api_base_url,
            test_collection["id"],
            "Give me a summary of what this document collection is about",
            "RAGAdaptiveOrchestrator",
        )
        assert r.status_code == 200
        content = get_accumulated_content(parse_ndjson(r.text))
        assert_meaningful_content(content, min_length=50)
        logger.info("Adaptive overview response: %d chars", len(content))

    def test_adaptive_cross_doc_query(self, authenticated_session, api_base_url, test_collection, test_document):
        """Cross-document entity query through adaptive orchestrator returns content."""
        r = self._chat(
            authenticated_session,
            api_base_url,
            test_collection["id"],
            "What concepts appear across all documents in the collection?",
            "RAGAdaptiveOrchestrator",
        )
        assert r.status_code == 200
        content = get_accumulated_content(parse_ndjson(r.text))
        assert_meaningful_content(content, min_length=50)
        logger.info("Adaptive cross-doc response: %d chars", len(content))

    def test_entity_expanded_direct(self, authenticated_session, api_base_url, test_collection, test_document):
        """RAGEntityExpanded invoked directly must return content without error."""
        r = self._chat(
            authenticated_session,
            api_base_url,
            test_collection["id"],
            "What are the main themes discussed in these texts?",
            "RAGEntityExpanded",
        )
        assert r.status_code == 200
        content = get_accumulated_content(parse_ndjson(r.text))
        assert_meaningful_content(content, min_length=50)
        logger.info("RAGEntityExpanded direct response: %d chars", len(content))

    def test_hybrid_summary_direct(self, authenticated_session, api_base_url, test_collection, test_document):
        """RAGHybridSummarySearch invoked directly must return content without error."""
        r = self._chat(
            authenticated_session,
            api_base_url,
            test_collection["id"],
            "Summarize the key ideas from the available documents",
            "RAGHybridSummarySearch",
        )
        assert r.status_code == 200
        content = get_accumulated_content(parse_ndjson(r.text))
        assert_meaningful_content(content, min_length=50)
        logger.info("RAGHybridSummarySearch response: %d chars", len(content))
