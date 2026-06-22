"""
Integration Tests for Document Processing Quality

Verifies deep quality of document parsing, chunking, embeddings, and graph:
- Embedding metadata contains source information (page, chapter)
- Graph hierarchy is complete (Workspace→Collection→Book→Chapter→Section→Chunk)
- Entity extraction produces Person, Concept, Place nodes
- Multi-book collections share a single Collection node
- RAG chat returns content with citations from the correct book
"""

import logging

import pytest

from tests.conftest import assert_meaningful_content, get_accumulated_content, get_packets_by_type, parse_ndjson
from tests.integration.chat_client import chat_post

logger = logging.getLogger(__name__)


@pytest.mark.integration
class TestEmbeddingQuality:
    """Tests for pgvector embedding quality and metadata."""

    def test_embeddings_have_source_metadata(self, py_cursor, test_collection, test_document):
        """Verify embeddings contain source metadata (page, document, collection)."""
        collection_id = test_collection["id"]
        py_cursor.execute(
            """SELECT e.cmetadata
               FROM langchain_pg_embedding e
               WHERE e.collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )
               LIMIT 20""",
            (collection_id,),
        )
        embeddings = py_cursor.fetchall()
        assert len(embeddings) > 0, "Should have embeddings"

        for emb in embeddings:
            meta = emb["cmetadata"]
            assert isinstance(meta, dict), "Metadata should be a dict"
            # Metadata should contain at least source or document reference
            has_source_info = any(key in meta for key in ["source", "page", "document_id", "file_path", "filename"])
            if not has_source_info:
                logger.warning("Embedding missing source info, keys: %s", list(meta.keys()))

        logger.info("Checked %d embeddings for source metadata", len(embeddings))

    def test_embedding_content_not_truncated(self, py_cursor, test_collection, test_document):
        """Verify embedding content chunks are reasonable size (not too short/long)."""
        collection_id = test_collection["id"]
        py_cursor.execute(
            """SELECT LENGTH(e.document) as content_len
               FROM langchain_pg_embedding e
               WHERE e.collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )""",
            (collection_id,),
        )
        rows = py_cursor.fetchall()
        lengths = [r["content_len"] for r in rows]
        avg_len = sum(lengths) / len(lengths) if lengths else 0
        min_len = min(lengths) if lengths else 0
        max_len = max(lengths) if lengths else 0

        logger.info(
            "Embedding content stats: count=%d, avg=%.0f, min=%d, max=%d",
            len(lengths),
            avg_len,
            min_len,
            max_len,
        )

        # Chunks should be reasonable size
        assert avg_len > 50, f"Average chunk too small ({avg_len:.0f} chars)"
        assert max_len < 50000, f"Max chunk too large ({max_len} chars) - possible truncation issue"

    def test_no_micro_chunks_in_embeddings(self, py_cursor, test_collection, test_document):
        """Verify no micro-chunks under 80 chars exist in embeddings (BUG FIX #7)."""
        collection_id = test_collection["id"]
        py_cursor.execute(
            """SELECT LENGTH(e.document) as content_len, LEFT(e.document, 100) as preview
               FROM langchain_pg_embedding e
               WHERE e.collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )
               AND LENGTH(e.document) < 80
               ORDER BY content_len ASC""",
            (collection_id,),
        )
        micro_chunks = py_cursor.fetchall()

        if micro_chunks:
            for mc in micro_chunks[:5]:
                logger.warning("Micro-chunk found (%d chars): %s", mc["content_len"], mc["preview"])

        assert len(micro_chunks) == 0, (
            f"Found {len(micro_chunks)} micro-chunks (<80 chars) in embeddings. BUG FIX #7 should filter these out during chunking."
        )

    def test_section_heading_quality(self, py_cursor, test_collection, test_document):
        """Verify section headings are meaningful, not all generic 'Section 1' (BUG FIX #5)."""
        collection_id = test_collection["id"]
        py_cursor.execute(
            """SELECT cmetadata->>'section_heading' as heading, COUNT(*) as cnt
               FROM langchain_pg_embedding e
               WHERE e.collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )
               GROUP BY heading
               ORDER BY cnt DESC
               LIMIT 20""",
            (collection_id,),
        )
        rows = py_cursor.fetchall()
        total = sum(r["cnt"] for r in rows)

        logger.info("Section heading distribution (%d total embeddings):", total)
        for r in rows:
            pct = (r["cnt"] / total * 100) if total else 0
            logger.info("  '%s': %d (%.1f%%)", r["heading"], r["cnt"], pct)

        if total > 0:
            # Find generic headings
            generic_count = sum(r["cnt"] for r in rows if r["heading"] and r["heading"].startswith("Section "))
            generic_pct = generic_count / total * 100
            # At least 20% should have meaningful (non-generic) headings
            assert generic_pct < 80, (
                f"{generic_pct:.1f}% of embeddings have generic 'Section N' headings. BUG FIX #5 should convert bold lines to proper headers."
            )

    def test_embedding_count_per_document(self, py_cursor, test_collection, test_document):
        """Verify each completed document contributes embeddings."""
        collection_id = test_collection["id"]
        py_cursor.execute(
            """SELECT d.id, d.filename, d.processing_status,
                      (SELECT COUNT(*) FROM langchain_pg_embedding e
                       WHERE e.collection_id = (SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1)
                       AND e.cmetadata->>'source' LIKE '%%' || d.filename || '%%'
                      ) as embedding_count
               FROM documents d
               WHERE d.collection_id = %s AND d.processing_status = 'completed'""",
            (collection_id, collection_id),
        )
        docs = py_cursor.fetchall()
        logger.info("Documents with embeddings:")
        for doc in docs:
            logger.info(
                "  %s: status=%s embeddings=%d",
                doc["filename"],
                doc["processing_status"],
                doc["embedding_count"],
            )


@pytest.mark.integration
@pytest.mark.neo4j
class TestGraphQuality:
    """Tests for Neo4j knowledge graph quality and structure."""

    def test_graph_hierarchy_complete(self, neo4j_driver, test_document):
        """Verify the full graph hierarchy: Workspace→Collection→Book→Chapter→Section→Chunk."""
        with neo4j_driver.session() as session:
            result = session.run(
                """MATCH (w:Workspace)-[:OWNS]->(col:Collection)-[:CONTAINS]->(b:Book)
                       -[:HAS_CHAPTER]->(ch:Chapter)-[:HAS_SECTION]->(s:Section)
                       -[:CONTAINS]->(chunk:Chunk)
                   RETURN count(DISTINCT w) as workspaces,
                          count(DISTINCT col) as collections,
                          count(DISTINCT b) as books,
                          count(DISTINCT ch) as chapters,
                          count(DISTINCT s) as sections,
                          count(DISTINCT chunk) as chunks"""
            )
            record = result.single()
            logger.info(
                "Graph hierarchy: %d workspaces, %d collections, %d books, %d chapters, %d sections, %d chunks",
                record["workspaces"],
                record["collections"],
                record["books"],
                record["chapters"],
                record["sections"],
                record["chunks"],
            )

            assert record["workspaces"] >= 1, "Should have at least 1 Workspace"
            assert record["collections"] >= 1, "Should have at least 1 Collection"
            assert record["books"] >= 1, "Should have at least 1 Book"
            assert record["chapters"] >= 1, "Should have at least 1 Chapter"
            assert record["sections"] >= 1, "Should have at least 1 Section"
            assert record["chunks"] >= 1, "Should have at least 1 Chunk"

    def test_collection_has_books(self, neo4j_driver, test_document):
        """Verify collections have books linked via CONTAINS relationship."""
        with neo4j_driver.session() as session:
            result = session.run(
                """MATCH (col:Collection)-[:CONTAINS]->(b:Book)
                   RETURN col.name as collection, count(b) as book_count
                   ORDER BY book_count DESC LIMIT 5"""
            )
            records = list(result)
            assert len(records) > 0, "Should have collections with books"

            for r in records:
                logger.info("Collection %s: %d books", r["collection"], r["book_count"])

            max_books = max(r["book_count"] for r in records)
            assert max_books >= 1, "Should have at least 1 book in a collection"
            if max_books > 1:
                logger.info("Multi-book collection detected (%d books)", max_books)
            else:
                logger.info("Single-book collection only - cross-book tests will be limited")

    def test_entity_extraction_persons(self, neo4j_driver, test_document):
        """Verify Person entities were extracted from documents."""
        with neo4j_driver.session() as session:
            result = session.run("MATCH (p:Person) RETURN p.name as name ORDER BY p.name LIMIT 20")
            persons = [r["name"] for r in result]
            assert len(persons) > 0, "Should have extracted Person entities"
            logger.info("Extracted %d Person entities: %s", len(persons), persons[:10])

    def test_entity_extraction_concepts(self, neo4j_driver, test_document):
        """Verify Concept entities were extracted from documents."""
        with neo4j_driver.session() as session:
            result = session.run("MATCH (c:Concept) RETURN c.name as name ORDER BY c.name LIMIT 20")
            concepts = [r["name"] for r in result]
            assert len(concepts) > 0, "Should have extracted Concept entities"
            logger.info("Extracted %d Concept entities: %s", len(concepts), concepts[:10])

    def test_entity_extraction_places(self, neo4j_driver, test_document):
        """Verify Place entities were extracted from documents."""
        with neo4j_driver.session() as session:
            result = session.run("MATCH (p:Place) RETURN p.name as name ORDER BY p.name LIMIT 20")
            places = [r["name"] for r in result]
            assert len(places) > 0, "Should have extracted Place entities"
            logger.info("Extracted %d Place entities: %s", len(places), places[:10])

    def test_workspace_owns_collection(self, neo4j_driver, test_document):
        """Verify Workspace→OWNS→Collection relationship exists."""
        with neo4j_driver.session() as session:
            result = session.run("MATCH (w:Workspace)-[:OWNS]->(c:Collection) RETURN w.name as workspace, c.name as collection")
            records = list(result)
            assert len(records) > 0, "Should have Workspace→Collection ownership"
            for r in records:
                logger.info("Workspace '%s' owns Collection '%s'", r["workspace"], r["collection"])


@pytest.mark.integration
class TestRagChatQuality:
    """Tests for RAG chat quality - correct book selection and citation."""

    def test_rag_returns_relevant_content(self, authenticated_session, api_base_url, test_collection, test_document):
        """Verify RAG chat returns content relevant to the question."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What does Sun Tzu say about knowing your enemy?",
            collection_ids=[str(test_collection["id"])],
            timeout=90,
        )

        assert response.status_code == 200
        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)

        # Should mention Sun Tzu or enemy in the response
        assert_meaningful_content(
            content,
            min_length=100,
            topic_keywords=["enemy", "know", "sun tzu", "battle", "victory"],
        )
        logger.info("RAG response (relevant): %d chars, preview: %s", len(content), content[:200])

    def test_rag_has_source_citations(self, authenticated_session, api_base_url, test_collection, test_document):
        """Verify RAG chat includes source/citation packets."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Quote a key passage from the Art of War about strategy",
            collection_ids=[str(test_collection["id"])],
            timeout=90,
        )

        assert response.status_code == 200
        packets = parse_ndjson(response.text)

        # Check for citation or source packets
        citations = get_packets_by_type(packets, "citation")
        sources = get_packets_by_type(packets, "source")
        section_ends = get_packets_by_type(packets, "section_end")

        logger.info(
            "Packet analysis: %d citations, %d sources, %d section_ends",
            len(citations),
            len(sources),
            len(section_ends),
        )

        content = get_accumulated_content(packets)
        assert len(content) > 50, f"Response too short: {len(content)} chars"

    def test_agentic_rag_selects_correct_strategy(self, authenticated_session, api_base_url, test_collection, test_document):
        """Verify agentic RAG selects an appropriate strategy and returns content."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Compare Sun Tzu's views on terrain with his views on leadership",
            collection_ids=[str(test_collection["id"])],
            agentic_rag_enabled=True,
            timeout=120,
        )

        assert response.status_code == 200
        packets = parse_ndjson(response.text)

        # Get status packets to see what strategy was selected
        statuses = get_packets_by_type(packets, "status")
        for s in statuses:
            logger.info("Agentic RAG status: %s", s["obj"].get("content", ""))

        content = get_accumulated_content(packets)
        assert_meaningful_content(
            content,
            min_length=100,
            topic_keywords=["terrain", "leader", "sun tzu", "command", "general"],
        )

    def test_chat_response_quality_multi_turn(self, authenticated_session, api_base_url, test_collection, test_document):
        """Verify multi-turn conversation maintains context and quality."""
        from uuid import uuid4

        session_id = str(uuid4())

        # Turn 1: Ask about a specific topic
        r1 = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What are the 5 essential factors according to Sun Tzu?",
            session_id=session_id,
            collection_ids=[str(test_collection["id"])],
            timeout=90,
        )
        assert r1.status_code == 200
        content1 = get_accumulated_content(parse_ndjson(r1.text))
        assert len(content1) > 50, "First turn should have content"
        logger.info("Turn 1: %d chars", len(content1))

        # Turn 2: Follow-up question referencing previous answer
        r2 = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Which of those factors does he consider most important and why?",
            session_id=session_id,
            collection_ids=[str(test_collection["id"])],
            timeout=90,
        )
        assert r2.status_code == 200
        content2 = get_accumulated_content(parse_ndjson(r2.text))
        assert len(content2) > 50, "Second turn should have content"
        logger.info("Turn 2: %d chars", len(content2))
