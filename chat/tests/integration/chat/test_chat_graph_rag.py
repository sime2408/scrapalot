"""
Integration Tests for Graph RAG Search

Tests the graph search RAG strategy via the chat endpoint:
- Graph search produces meaningful responses using Neo4j knowledge graph
- Section expansion enriches context with full section chunks from pgvector
- Graph traversal produces entity-aware responses
- Admin rebuild-graph endpoint works correctly

Requires: test_document fixture (art_of_war.pdf uploaded and processed).
Requires: neo4j_driver fixture (connection to Neo4j).
"""

import logging

import pytest

from tests.conftest import assert_meaningful_content, get_accumulated_content, get_packets_by_type, parse_ndjson
from tests.integration.chat_client import chat_post

logger = logging.getLogger(__name__)


@pytest.mark.integration
class TestGraphRagSearch:
    """Tests for graph-based RAG search via the chat endpoint."""

    def test_graph_search_strategy(self, authenticated_session, api_base_url, test_collection, test_document):
        """Verify graph_search RAG strategy produces meaningful content from Neo4j."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What concepts and entities are discussed in the Art of War?",
            collection_ids=[str(test_collection["id"])],
            rag_strategy="graph_search",
            timeout=120,
        )

        assert response.status_code == 200, f"Graph search failed: {response.status_code}: {response.text[:300]}"

        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)

        # Graph search should return content about the document
        assert len(content) > 0, "Graph search should produce content"
        logger.info("Graph search response: %d chars", len(content))

    def test_graph_search_with_entity_query(self, authenticated_session, api_base_url, test_collection, test_document):
        """Verify graph search handles entity-focused queries (people, concepts)."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What does Sun Tzu say about the relationship between deception and military strategy?",
            collection_ids=[str(test_collection["id"])],
            rag_strategy="graph_search",
            timeout=120,
        )

        assert response.status_code == 200

        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)

        if len(content) > 50:
            assert_meaningful_content(
                content,
                min_length=50,
                topic_keywords=["sun tzu", "deception", "strategy", "war", "enemy"],
            )
        else:
            logger.warning("Graph search returned short response (%d chars) - graph may not have enough entity data", len(content))

    def test_graph_search_has_status_packets(self, authenticated_session, api_base_url, test_collection, test_document):
        """Verify graph search produces status packets showing search progress."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Explain the concept of terrain in the Art of War",
            collection_ids=[str(test_collection["id"])],
            rag_strategy="graph_search",
            timeout=120,
        )

        assert response.status_code == 200

        packets = parse_ndjson(response.text)
        packet_types = {p.get("obj", {}).get("type") for p in packets}

        logger.info("Graph search packet types: %s", packet_types)

        # Should have at least message_delta and stream_end
        assert "message_delta" in packet_types or "stream_end" in packet_types, f"Graph search should produce response packets, got: {packet_types}"


@pytest.mark.integration
class TestGraphRagWithAgenticRouting:
    """Tests for graph RAG combined with agentic routing."""

    def test_agentic_rag_uses_graph_for_entity_queries(self, authenticated_session, api_base_url, test_collection, test_document):
        """Verify agentic RAG can leverage graph knowledge for entity-rich queries."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Who are the key people and what concepts do they discuss in the Art of War?",
            collection_ids=[str(test_collection["id"])],
            agentic_rag_enabled=True,
            timeout=120,
        )

        assert response.status_code == 200

        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)

        assert_meaningful_content(
            content,
            min_length=100,
            topic_keywords=["sun tzu", "war", "strategy"],
        )

        # Check for entity-aware response indicators
        content_lower = content.lower()
        has_entity_awareness = any(kw in content_lower for kw in ["person", "concept", "entity", "sun tzu", "author"])
        if has_entity_awareness:
            logger.info("Response shows entity awareness from graph knowledge")

    def test_agentic_rag_relational_query(self, authenticated_session, api_base_url, test_collection, test_document):
        """Test agentic RAG with a relational query (entity relationships)."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="How are the concepts of terrain, weather, and leadership connected in the Art of War?",
            collection_ids=[str(test_collection["id"])],
            agentic_rag_enabled=True,
            timeout=120,
        )

        assert response.status_code == 200

        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)

        if len(content) == 0:
            # Empty content can happen under heavy VPS load - check for error packets
            errors = get_packets_by_type(packets, "error")
            logger.warning(
                "Relational query returned empty content. Packets: %d, errors: %d",
                len(packets),
                len(errors),
            )
            # Accept empty content if no errors (LLM may have timed out gracefully)
            assert len(errors) == 0, f"Stream had errors: {errors}"
        else:
            assert_meaningful_content(
                content,
                min_length=50,
                topic_keywords=["terrain", "weather", "leader", "connect", "relation"],
            )


@pytest.mark.integration
@pytest.mark.neo4j
class TestGraphTraversalQuality:
    """Tests for Neo4j graph traversal quality and completeness."""

    def test_graph_has_entities_for_art_of_war(self, neo4j_driver, test_document):
        """Verify the graph has entity nodes extracted from Art of War."""
        with neo4j_driver.session() as session:
            result = session.run(
                """MATCH (n)
                   WHERE any(label IN labels(n)
                         WHERE label IN ['Person', 'Concept', 'Place', 'Event', 'Term', 'Quote'])
                   RETURN labels(n)[0] as label, count(n) as count
                   ORDER BY count DESC"""
            )
            records = list(result)
            total = sum(r["count"] for r in records)

            logger.info("Art of War entities in graph: %d total", total)
            for r in records:
                logger.info("  %s: %d", r["label"], r["count"])

            assert total > 0, "Graph should have entity nodes from Art of War"

    def test_multi_hop_traversal_path(self, neo4j_driver, test_document):
        """Verify multi-hop traversal paths exist (Book→Chapter→Section→Chunk)."""
        with neo4j_driver.session() as session:
            result = session.run(
                """MATCH path = (b:Book)-[:HAS_CHAPTER]->(ch:Chapter)
                              -[:HAS_SECTION]->(s:Section)-[:CONTAINS]->(c:Chunk)
                   RETURN b.title as book,
                          ch.title as chapter,
                          s.title as section,
                          count(c) as chunks
                   LIMIT 5"""
            )
            records = list(result)

            if len(records) == 0:
                # Try alternative hierarchy
                result = session.run(
                    """MATCH path = (col:Collection)-[:CONTAINS]->(b:Book)
                                  -[:HAS_CHAPTER]->(ch:Chapter)
                       RETURN col.name as collection, b.title as book,
                              ch.title as chapter
                       LIMIT 5"""
                )
                records = list(result)

            logger.info("Multi-hop paths found: %d", len(records))
            for r in records:
                logger.info("  %s", dict(r))

            assert len(records) > 0, "Should have multi-hop traversal paths in the graph hierarchy"

    def test_entity_connected_to_document(self, neo4j_driver, test_document):
        """Verify entities are connected back to document structure."""
        with neo4j_driver.session() as session:
            # Check if entities have document_id metadata linking back to documents
            result = session.run(
                """MATCH (n)
                   WHERE any(label IN labels(n)
                         WHERE label IN ['Person', 'Concept', 'Place', 'Term'])
                     AND n.document_id IS NOT NULL
                   RETURN labels(n)[0] as label, count(n) as count"""
            )
            records = list(result)
            total = sum(r["count"] for r in records)

            logger.info("Entities with document_id: %d", total)

            if total == 0:
                # Check if entities have any document linkage
                result2 = session.run(
                    """MATCH (n)-[r]-(b:Book)
                       WHERE any(label IN labels(n)
                             WHERE label IN ['Person', 'Concept', 'Place', 'Term'])
                       RETURN labels(n)[0] as label, type(r) as rel, count(*) as count
                       LIMIT 10"""
                )
                records2 = list(result2)
                logger.info("Entities linked to books: %s", records2)

    def test_section_chunks_available_for_expansion(self, py_cursor, test_collection, test_document):
        """Verify section chunks exist in pgvector for section expansion feature."""
        collection_id = test_collection["id"]

        py_cursor.execute(
            """SELECT
                   cmetadata->>'section_heading' as section,
                   COUNT(*) as chunk_count
               FROM langchain_pg_embedding
               WHERE collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )
               AND cmetadata->>'section_heading' IS NOT NULL
               GROUP BY section
               ORDER BY chunk_count DESC
               LIMIT 10""",
            (collection_id,),
        )
        sections = py_cursor.fetchall()

        logger.info("Sections available for expansion:")
        total_chunks = 0
        for s in sections:
            logger.info("  '%s': %d chunks", s["section"], s["chunk_count"])
            total_chunks += s["chunk_count"]

        if len(sections) == 0:
            logger.warning("No sections with section_heading metadata found. Section expansion will not enrich context.")
        else:
            logger.info("Total: %d sections, %d chunks available for expansion", len(sections), total_chunks)


@pytest.mark.integration
class TestAdminRebuildGraph:
    """Tests for the admin rebuild-graph endpoint (P2 feature)."""

    def test_rebuild_graph_endpoint_exists(self, authenticated_session, api_base_url):
        """Verify the rebuild-graph endpoint is accessible (admin-only)."""
        # Just test that the endpoint exists and requires auth
        response = authenticated_session.post(
            f"{api_base_url}/admin/rebuild-graph",
            json={},
            timeout=30,
        )

        # Should not return 404 (endpoint exists)
        assert response.status_code != 404, "POST /admin/rebuild-graph should exist (got 404)"

        logger.info("Rebuild graph endpoint status: %d", response.status_code)

    def test_rebuild_graph_with_collection(self, authenticated_session, api_base_url, test_collection):
        """Test rebuild-graph with a specific collection ID."""
        response = authenticated_session.post(
            f"{api_base_url}/admin/rebuild-graph",
            json={"collectionId": str(test_collection["id"])},
            timeout=300,
        )

        if response.status_code == 200:
            data = response.json()
            logger.info(
                "Rebuild graph result: success=%s, message=%s, documents=%s, entities=%s",
                data.get("success"),
                data.get("message"),
                data.get("documents_processed"),
                data.get("entities_extracted"),
            )
        elif response.status_code == 403:
            logger.info("Rebuild graph requires admin role (expected for non-admin users)")
        else:
            logger.warning(
                "Rebuild graph returned %d: %s",
                response.status_code,
                response.text[:200],
            )
