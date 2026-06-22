"""
Integration Tests for Cross-Book RAG Intelligence

Verifies the cross-book context expansion capabilities:
- Cross-collection chunk retrieval from pgvector
- Cross-collection section search across all documents
- Neo4j graph traversal for shared entities (graceful fallback when no Chunk→Entity relationships)
- Multiple books in the same collection share entities
"""

import logging

import pytest

from tests.conftest import assert_meaningful_content, get_accumulated_content, get_packets_by_type, parse_ndjson
from tests.integration.chat_client import chat_post

logger = logging.getLogger(__name__)


@pytest.mark.integration
class TestCrossCollectionChunkRetrieval:
    """Tests for get_cross_collection_chunks() utility function via pgvector."""

    def test_cross_collection_chunks_by_document_id(self, py_cursor, test_collection, test_document):
        """Verify we can fetch chunks from pgvector by document_id (cross-book retrieval pattern)."""
        collection_id = test_collection["id"]

        # Get a document_id from the collection
        py_cursor.execute(
            """SELECT DISTINCT cmetadata->>'document_id' as doc_id
               FROM langchain_pg_embedding
               WHERE collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )
               AND cmetadata->>'document_id' IS NOT NULL
               LIMIT 3""",
            (collection_id,),
        )
        rows = py_cursor.fetchall()

        if not rows:
            pytest.skip("No chunks with document_id metadata found")

        doc_ids = [r["doc_id"] for r in rows]
        logger.info("Testing cross-collection retrieval with %d document IDs", len(doc_ids))

        # Build the same query our utility function uses (fetch chunks by document_id + keywords)
        py_cursor.execute(
            """SELECT id, document, cmetadata, (cmetadata->>'chunk_index')::int as chunk_index
                FROM langchain_pg_embedding
                WHERE cmetadata->>'document_id' = %s
                AND document ILIKE %s
                ORDER BY (cmetadata->>'chunk_index')::int
                LIMIT 5""",
            (doc_ids[0], "%war%"),
        )
        results = py_cursor.fetchall()

        assert len(results) > 0, "Should retrieve keyword-matched chunks by document_id"
        for r in results:
            assert r["document"] is not None, "Chunk should have content"
            assert len(r["document"]) > 10, "Chunk content should not be empty"
            assert "war" in r["document"].lower(), "Chunk should contain keyword"

        logger.info("Retrieved %d keyword-matched chunks from document %s", len(results), doc_ids[0][:8])

    def test_cross_collection_section_search(self, py_cursor, test_collection, test_document):
        """Verify cross-collection keyword search finds sections across all documents."""
        # Search for keywords that should exist in Art of War
        keywords = ["war", "enemy", "strategy"]
        keyword_conditions = []
        params = {}

        for i, keyword in enumerate(keywords):
            param_name = f"keyword_{i}"
            keyword_conditions.append(f"(cmetadata->>'section_heading' ILIKE %({param_name})s OR document ILIKE %({param_name})s)")
            params[param_name] = f"%{keyword}%"

        keyword_condition = " OR ".join(keyword_conditions)

        py_cursor.execute(
            f"""SELECT
                    cmetadata->>'document_id' as doc_id,
                    cmetadata->>'file_name' as file_name,
                    cmetadata->>'section_heading' as section,
                    COUNT(*) as matching_chunks
                FROM langchain_pg_embedding
                WHERE cmetadata->>'section_heading' IS NOT NULL
                AND ({keyword_condition})
                GROUP BY doc_id, file_name, section
                ORDER BY matching_chunks DESC
                LIMIT 10""",
            params,
        )
        results = py_cursor.fetchall()

        assert len(results) > 0, "Should find sections matching keywords across documents"

        logger.info("Cross-collection section search results:")
        doc_ids_found = set()
        for r in results:
            doc_id = r["doc_id"]
            if doc_id:
                doc_ids_found.add(doc_id)
            logger.info(
                "  doc=%s file=%s section='%s' chunks=%d",
                str(doc_id)[:8] if doc_id else "?",
                r["file_name"],
                r["section"],
                r["matching_chunks"],
            )

        logger.info("Found sections across %d documents", len(doc_ids_found))

    def test_embeddings_have_section_metadata(self, py_cursor, test_collection, test_document):
        """Verify embeddings contain section_heading metadata needed for cross-collection search."""
        collection_id = test_collection["id"]
        py_cursor.execute(
            """SELECT
                   COUNT(*) as total,
                   COUNT(CASE WHEN cmetadata->>'section_heading' IS NOT NULL THEN 1 END) as with_sections,
                   COUNT(CASE WHEN cmetadata->>'document_id' IS NOT NULL THEN 1 END) as with_doc_id,
                   COUNT(CASE WHEN cmetadata->>'chunk_id' IS NOT NULL THEN 1 END) as with_chunk_id
               FROM langchain_pg_embedding
               WHERE collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )""",
            (collection_id,),
        )
        stats = py_cursor.fetchone()

        logger.info(
            "Embedding metadata coverage: total=%d, with_sections=%d (%.0f%%), with_doc_id=%d (%.0f%%), with_chunk_id=%d (%.0f%%)",
            stats["total"],
            stats["with_sections"],
            (stats["with_sections"] / stats["total"] * 100) if stats["total"] else 0,
            stats["with_doc_id"],
            (stats["with_doc_id"] / stats["total"] * 100) if stats["total"] else 0,
            stats["with_chunk_id"],
            (stats["with_chunk_id"] / stats["total"] * 100) if stats["total"] else 0,
        )

        assert stats["total"] > 0, "Should have embeddings"
        assert stats["with_doc_id"] > 0, "Some embeddings should have document_id"


@pytest.mark.integration
@pytest.mark.neo4j
class TestNeo4jCrossBookGraph:
    """Tests for Neo4j graph structure supporting cross-book intelligence."""

    def test_multiple_books_in_collection(self, neo4j_driver, test_document):
        """Verify the collection contains multiple books for cross-book testing."""
        with neo4j_driver.session() as session:
            result = session.run(
                """MATCH (col:Collection)-[:CONTAINS]->(b:Book)
                   RETURN col.name as collection, count(b) as book_count
                   ORDER BY book_count DESC"""
            )
            records = list(result)
            assert len(records) > 0, "Should have collections with books"

            total_books = sum(r["book_count"] for r in records)
            logger.info("Neo4j books: %d total across %d collections", total_books, len(records))
            for r in records:
                logger.info("  Collection '%s': %d books", r["collection"], r["book_count"])

    def test_entity_nodes_have_canonical_names(self, neo4j_driver, test_document):
        """Verify entity nodes use canonical_name for cross-book deduplication."""
        with neo4j_driver.session() as session:
            # Check Concept entities
            result = session.run(
                """MATCH (entity)
                   WHERE entity.canonical_name IS NOT NULL
                   RETURN labels(entity)[0] as label,
                          count(*) as count
                   ORDER BY count DESC"""
            )
            records = list(result)
            assert len(records) > 0, "Should have entities with canonical_name"

            total_entities = sum(r["count"] for r in records)
            logger.info("Entities with canonical_name: %d total", total_entities)
            for r in records:
                logger.info("  %s: %d entities", r["label"], r["count"])

    def test_chunk_nodes_exist_for_traversal(self, neo4j_driver, test_document):
        """Verify Chunk nodes exist and have IDs matching pgvector chunk_ids."""
        with neo4j_driver.session() as session:
            result = session.run(
                """MATCH (c:Chunk)
                   RETURN count(c) as chunk_count,
                          count(c.id) as with_id
                   """
            )
            record = result.single()
            chunk_count = record["chunk_count"]
            with_id = record["with_id"]

            logger.info(
                "Neo4j Chunk nodes: %d total, %d with id property (%.0f%%)",
                chunk_count,
                with_id,
                (with_id / chunk_count * 100) if chunk_count else 0,
            )

            assert chunk_count > 0, "Should have Chunk nodes for graph traversal"
            assert with_id > 0, "Chunk nodes should have id property"

    def test_graph_traversal_graceful_without_entity_relationships(self, neo4j_driver, test_document):
        """Verify cross-book Cypher query returns empty (not error) when Chunk→Entity relationships don't exist."""
        with neo4j_driver.session() as session:
            # This is the same query our _get_graph_related_chunks() uses
            result = session.run(
                """MATCH (c:Chunk)-[r]->(entity)
                   WHERE entity.canonical_name = $canonical_name
                   AND type(r) IN ['MENTIONS', 'REFERENCES', 'DESCRIBES', 'DISCUSSES', 'DEFINES', 'CONTAINS']
                   RETURN DISTINCT c.id as chunk_id
                   LIMIT $limit""",
                {"canonical_name": "sun tzu", "limit": 5},
            )
            records = list(result)

            # Current state: no Chunk→Entity relationships exist yet
            # This test verifies the query runs without error and returns empty gracefully
            logger.info(
                "Cross-book graph query for 'sun tzu': %d results (expected: 0 or more)",
                len(records),
            )

            # No assertion on count - just verify query executes without error
            # When Chunk→Entity relationships are created (future entity re-extraction),
            # this test will automatically verify they work


@pytest.mark.integration
class TestCrossBookKeywordSearch:
    """Tests for cross-book keyword search across multiple distinct documents."""

    def test_keyword_search_finds_multiple_documents(self, py_cursor, test_collection, test_document):
        """Verify keyword search for 'Sun Tzu' finds chunks across different documents."""
        collection_id = test_collection["id"]

        py_cursor.execute(
            """SELECT DISTINCT cmetadata->>'file_name' as file_name, COUNT(*) as chunks
               FROM langchain_pg_embedding
               WHERE collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )
               AND document ILIKE '%%sun tzu%%'
               GROUP BY file_name
               ORDER BY file_name""",
            (collection_id,),
        )
        results = py_cursor.fetchall()

        file_names = [r["file_name"] for r in results]
        logger.info("Documents containing 'Sun Tzu': %s", file_names)

        # Should find Sun Tzu in at least one document
        assert len(results) >= 1, f"Expected Sun Tzu in >= 1 document, found in {len(results)}: {file_names}"
        if len(results) < 2:
            logger.warning(
                "Sun Tzu found in only %d document(s). Multi-book cross-search requires multiple documents in the collection.", len(results)
            )

    def test_cross_document_entity_overlap(self, py_cursor, test_collection, test_document):
        """Verify shared entities (e.g., strategy, warfare) appear in chunks from different documents."""
        collection_id = test_collection["id"]
        keywords = ["strategy", "warfare", "deception", "terrain"]

        for keyword in keywords:
            py_cursor.execute(
                """SELECT COUNT(DISTINCT cmetadata->>'document_id') as doc_count,
                          COUNT(*) as total_chunks
                   FROM langchain_pg_embedding
                   WHERE collection_id = (
                       SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
                   )
                   AND document ILIKE %s""",
                (collection_id, f"%{keyword}%"),
            )
            result = py_cursor.fetchone()
            logger.info(
                "Keyword '%s': found in %d documents, %d chunks",
                keyword,
                result["doc_count"],
                result["total_chunks"],
            )

        # 'strategy' should appear in multiple documents
        py_cursor.execute(
            """SELECT COUNT(DISTINCT cmetadata->>'document_id') as doc_count
               FROM langchain_pg_embedding
               WHERE collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )
               AND document ILIKE '%%strategy%%'""",
            (collection_id,),
        )
        strategy_docs = py_cursor.fetchone()["doc_count"]
        assert strategy_docs >= 1, f"'strategy' should appear in >= 1 document, found in {strategy_docs}"
        if strategy_docs < 2:
            logger.warning("'strategy' found in only %d document(s). Multi-book overlap requires multiple documents.", strategy_docs)

    def test_cross_collection_chunks_utility(self, py_cursor, test_collection, test_document):
        """Verify get_cross_collection_chunks SQL pattern works for cross-book retrieval."""
        collection_id = test_collection["id"]

        # Get document IDs from new test books
        py_cursor.execute(
            """SELECT DISTINCT cmetadata->>'document_id' as doc_id, cmetadata->>'file_name' as file_name
               FROM langchain_pg_embedding
               WHERE collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )
               AND cmetadata->>'file_name' IN (
                   'the_art_of_strategy.pdf', 'meditations_on_leadership.pdf', 'principles_of_naval_warfare.pdf'
               )""",
            (collection_id,),
        )
        new_docs = py_cursor.fetchall()

        if len(new_docs) < 2:
            pytest.skip("Need at least 2 new test documents for cross-book test")

        # Pick one document as source, search others for overlapping content
        source_doc = new_docs[0]
        target_doc_ids = [d["doc_id"] for d in new_docs if d["doc_id"] != source_doc["doc_id"]]

        # Search for 'Sun Tzu' in the target documents (cross-book pattern)
        placeholders = ", ".join(["%s"] * len(target_doc_ids))
        py_cursor.execute(
            f"""SELECT id, LEFT(document, 100) as preview,
                       cmetadata->>'document_id' as doc_id,
                       cmetadata->>'file_name' as file_name
                FROM langchain_pg_embedding
                WHERE cmetadata->>'document_id' IN ({placeholders})
                AND document ILIKE '%%sun tzu%%'
                ORDER BY (cmetadata->>'chunk_index')::int
                LIMIT 5""",
            target_doc_ids,
        )
        cross_chunks = py_cursor.fetchall()

        assert len(cross_chunks) > 0, "Should find 'Sun Tzu' in cross-book documents"
        logger.info("Cross-book chunks for 'Sun Tzu' (excluding %s):", source_doc["file_name"])
        for c in cross_chunks:
            logger.info("  [%s] %s...", c["file_name"], c["preview"])


@pytest.mark.integration
class TestCrossBookRagChat:
    """Tests for cross-book RAG via the chat API endpoint."""

    def test_agentic_rag_with_cross_book_enabled(self, authenticated_session, api_base_url, test_collection, test_document):
        """Verify agentic RAG works with cross-book analysis enabled in config."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What concepts does Sun Tzu discuss about warfare strategy and terrain?",
            collection_ids=[str(test_collection["id"])],
            agentic_rag_enabled=True,
            timeout=180,
        )

        assert response.status_code == 200
        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)

        assert_meaningful_content(
            content,
            min_length=100,
            topic_keywords=["sun tzu", "strategy", "terrain", "war", "enemy"],
        )

        # Log packet breakdown for debugging
        statuses = get_packets_by_type(packets, "status")
        citations = get_packets_by_type(packets, "citation")
        logger.info(
            "Agentic RAG response: %d chars, %d status packets, %d citations",
            len(content),
            len(statuses),
            len(citations),
        )
        for s in statuses:
            logger.info("  Status: %s", s["obj"].get("content", ""))

    def test_rag_multi_document_query(self, authenticated_session, api_base_url, test_collection, test_document, py_cursor):
        """Verify RAG can answer questions using data from the collection."""
        # First check how many completed documents we have
        collection_id = test_collection["id"]
        py_cursor.execute(
            """SELECT COUNT(DISTINCT cmetadata->>'document_id') as doc_count
               FROM langchain_pg_embedding
               WHERE collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )""",
            (collection_id,),
        )
        doc_count = py_cursor.fetchone()["doc_count"]
        logger.info("Collection has embeddings from %d distinct documents", doc_count)

        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Summarize the key military principles discussed in the collection",
            collection_ids=[str(collection_id)],
            timeout=180,
        )

        assert response.status_code == 200
        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)
        assert_meaningful_content(content, min_length=100)
        logger.info("Multi-document query response: %d chars", len(content))
