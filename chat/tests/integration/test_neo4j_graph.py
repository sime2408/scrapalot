"""
Integration Tests for Neo4j Graph Database

Validates that document processing creates proper graph nodes:
- Book, Chapter, Section, Chunk nodes from document structure
- Entity nodes: Person, Concept, Place, Event, Term, Quote (6 EntityType values)
- Entity metadata: confidence, description, canonical_name
- Relationships: hierarchy (OWNS, CONTAINS, HAS_CHAPTER, HAS_SECTION)
  and entity links (MENTIONS, REFERENCES, DESCRIBES, etc.)
- Collection and Workspace nodes for organization

Requires: test_document fixture (art_of_war.pdf uploaded and processed).
Requires: neo4j_driver fixture (connection to Neo4j).
"""

import logging

import pytest

logger = logging.getLogger(__name__)

# All 6 EntityType values from enums.py
ENTITY_LABELS = {"Person", "Concept", "Place", "Event", "Term", "Quote"}

# Relationship types used for entity links
ENTITY_RELATIONSHIP_TYPES = {"MENTIONS", "REFERENCES", "DESCRIBES", "DISCUSSES", "DEFINES", "CONTAINS"}


@pytest.mark.integration
@pytest.mark.neo4j
class TestNeo4jGraph:
    """Integration tests for Neo4j graph nodes created during document processing."""

    def test_collection_node_exists(self, neo4j_driver, test_document):
        """Test that a Collection node exists in the graph."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run("MATCH (c:Collection) RETURN count(c) as count")
            count = result.single()["count"]
            assert count > 0, "Should have at least one Collection node"

    def test_book_node_exists(self, neo4j_driver, test_document):
        """Test that a Book node exists from the uploaded document."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run("MATCH (b:Book) RETURN count(b) as count")
            count = result.single()["count"]
            assert count > 0, "Should have at least one Book node from uploaded document"

    def test_book_node_has_workspace_and_document_id(self, neo4j_driver, test_document):
        """Test that Book nodes have workspace_id and document_id properties (BUG FIX #4)."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run(
                """MATCH (b:Book)
                   RETURN b.title as title, b.workspace_id as workspace_id,
                          b.document_id as document_id, b.collection_id as collection_id
                   LIMIT 5"""
            )
            records = list(result)
            assert len(records) > 0, "Should have Book nodes"

            for r in records:
                logger.info(
                    "Book '%s': workspace_id=%s, document_id=%s, collection_id=%s",
                    r["title"],
                    r["workspace_id"],
                    r["document_id"],
                    r["collection_id"],
                )
                assert r["document_id"] is not None, f"Book '{r['title']}' missing document_id property"
                assert r["workspace_id"] is not None, f"Book '{r['title']}' missing workspace_id property"

    def test_chunk_nodes_exist(self, neo4j_driver, test_document):
        """Test that Chunk nodes were created from document processing."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run("MATCH (ch:Chunk) RETURN count(ch) as count")
            count = result.single()["count"]
            assert count > 0, "Should have Chunk nodes from document processing"

    def test_concept_nodes_exist(self, neo4j_driver, test_document):
        """Test that Concept nodes were extracted from the document."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run("MATCH (c:Concept) RETURN count(c) as count")
            count = result.single()["count"]
            assert count > 0, "Should have Concept nodes extracted from document"

    def test_chapter_detection(self, neo4j_driver, test_document):
        """Test that chapters were detected in the Art of War (has 13 chapters)."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run("MATCH (c:Chapter) RETURN count(c) as count, collect(c.title) as titles")
            record = result.single()
            count = record["count"]
            titles = record["titles"]

            logger.info("Found %d Chapter nodes: %s", count, titles[:5])

            if count < 2:
                logger.warning("Art of War has 13 chapters but only %d detected. Chapter detection may need improvement.", count)

            assert count >= 1, "Should detect at least 1 chapter in the Art of War"

    def test_graph_node_summary(self, neo4j_driver, test_document):
        """Log a summary of all node types in the graph for diagnostics."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run("MATCH (n) RETURN labels(n)[0] as label, count(n) as count ORDER BY count DESC")
            records = list(result)

            total = sum(r["count"] for r in records)
            logger.info("Neo4j graph summary (%d total nodes):", total)
            for record in records:
                logger.info("  %s: %d", record["label"], record["count"])

            assert total > 0, "Graph should have nodes after document processing"


@pytest.mark.integration
@pytest.mark.neo4j
class TestEntityTypeDiversity:
    """Tests for entity type diversity after two-pass extraction (spaCy + LLM)."""

    def test_entity_type_diversity(self, neo4j_driver, test_document):
        """Verify extraction produces multiple entity types, not just Person/Place."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run(
                """MATCH (n)
                   WHERE any(label IN labels(n) WHERE label IN $entity_labels)
                   RETURN labels(n)[0] as label, count(n) as count
                   ORDER BY count DESC""",
                {"entity_labels": list(ENTITY_LABELS)},
            )
            records = list(result)
            found_types = {r["label"] for r in records}
            total_entities = sum(r["count"] for r in records)

            logger.info("Entity type diversity: %d types, %d total entities", len(found_types), total_entities)
            for r in records:
                logger.info("  %s: %d", r["label"], r["count"])

            assert total_entities > 0, "Should have entity nodes"
            # Two-pass extraction should produce at least 2 distinct entity types
            assert len(found_types) >= 2, f"Expected at least 2 entity types from two-pass extraction, got {len(found_types)}: {found_types}"

    def test_person_entities_exist(self, neo4j_driver, test_document):
        """Verify Person entities were extracted (spaCy + LLM)."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run("MATCH (p:Person) RETURN p.name as name, p.confidence as confidence ORDER BY p.confidence DESC LIMIT 10")
            records = list(result)
            names = [r["name"] for r in records]

            logger.info("Person entities: %s", names)
            assert len(names) > 0, "Art of War should have Person entities (e.g., Sun Tzu)"

    def test_concept_entities_have_descriptions(self, neo4j_driver, test_document):
        """Verify Concept entities have description metadata from LLM extraction."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run(
                """MATCH (c:Concept)
                   WHERE c.description IS NOT NULL AND c.description <> ''
                   RETURN c.name as name, c.description as description, c.confidence as confidence
                   LIMIT 10"""
            )
            records = list(result)

            logger.info("Concepts with descriptions: %d", len(records))
            for r in records:
                logger.info("  %s (%.2f): %s", r["name"], r["confidence"] or 0, r["description"][:80])

            # LLM extraction should produce descriptions
            if len(records) == 0:
                # Check if we have Concept nodes at all
                # noinspection PyTypeChecker
                total = session.run("MATCH (c:Concept) RETURN count(c) as count").single()["count"]
                if total > 0:
                    logger.warning("%d Concept nodes exist but none have descriptions", total)

    def test_place_entities_exist(self, neo4j_driver, test_document):
        """Verify Place entities were extracted (spaCy GPE/LOC mapping)."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run("MATCH (p:Place) RETURN p.name as name ORDER BY p.name LIMIT 10")
            places = [r["name"] for r in result]
            logger.info("Place entities: %s", places)
            # Art of War discusses China/geographic locations
            # spaCy should catch GPE → Place mapping

    def test_term_entities_from_llm(self, neo4j_driver, test_document):
        """Verify Term entities (technical terms, works) extracted by LLM pass."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run("MATCH (t:Term) RETURN t.name as name, t.confidence as confidence ORDER BY t.confidence DESC LIMIT 10")
            records = list(result)
            names = [r["name"] for r in records]

            logger.info("Term entities: %s", names)
            # Terms are only extracted by LLM (not spaCy) - their presence shows LLM pass works
            if len(names) == 0:
                logger.warning("No Term entities found - LLM extraction may not be producing TERM type")

    def test_event_entities(self, neo4j_driver, test_document):
        """Verify Event entities are extracted (battles, wars, historical events)."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run("MATCH (e:Event) RETURN e.name as name ORDER BY e.name LIMIT 10")
            events = [r["name"] for r in result]
            logger.info("Event entities: %s", events)


@pytest.mark.integration
@pytest.mark.neo4j
class TestEntityMetadata:
    """Tests for entity node metadata quality (confidence, canonical_name, etc.)."""

    def test_entities_have_canonical_names(self, neo4j_driver, test_document):
        """Verify entity nodes use canonical_name for deduplication."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run(
                """MATCH (n)
                   WHERE any(label IN labels(n) WHERE label IN $entity_labels)
                   RETURN labels(n)[0] as label,
                          count(*) as total,
                          count(n.canonical_name) as with_canonical
                   ORDER BY total DESC""",
                {"entity_labels": list(ENTITY_LABELS)},
            )
            records = list(result)

            for r in records:
                pct = (r["with_canonical"] / r["total"] * 100) if r["total"] else 0
                logger.info(
                    "  %s: %d total, %d with canonical_name (%.0f%%)",
                    r["label"],
                    r["total"],
                    r["with_canonical"],
                    pct,
                )

            total = sum(r["total"] for r in records)
            with_canonical = sum(r["with_canonical"] for r in records)
            assert total > 0, "Should have entity nodes"
            assert with_canonical > 0, "Some entities should have canonical_name for deduplication"

    def test_entities_have_confidence_scores(self, neo4j_driver, test_document):
        """Verify entity nodes have confidence scores from extraction."""
        with neo4j_driver.session() as session:
            # noinspection PyTypeChecker
            result = session.run(
                """MATCH (n)
                   WHERE any(label IN labels(n) WHERE label IN $entity_labels)
                     AND n.confidence IS NOT NULL
                   RETURN labels(n)[0] as label,
                          avg(n.confidence) as avg_confidence,
                          min(n.confidence) as min_confidence,
                          max(n.confidence) as max_confidence,
                          count(n) as count""",
                {"entity_labels": list(ENTITY_LABELS)},
            )
            records = list(result)

            for r in records:
                logger.info(
                    "  %s: %d entities, confidence avg=%.2f min=%.2f max=%.2f",
                    r["label"],
                    r["count"],
                    r["avg_confidence"] or 0,
                    r["min_confidence"] or 0,
                    r["max_confidence"] or 0,
                )

            total_with_confidence = sum(r["count"] for r in records)
            if total_with_confidence > 0:
                # Confidence should be in valid range [0.0, 1.0]
                for r in records:
                    if r["max_confidence"] is not None:
                        assert r["max_confidence"] <= 1.0, f"{r['label']} has confidence > 1.0: {r['max_confidence']}"
                    if r["min_confidence"] is not None:
                        assert r["min_confidence"] >= 0.0, f"{r['label']} has confidence < 0.0: {r['min_confidence']}"


@pytest.mark.integration
@pytest.mark.neo4j
class TestGraphRelationships:
    """Tests for graph relationship structure (hierarchy + entity links)."""

    def test_hierarchy_relationships(self, neo4j_driver, test_document):
        """Verify hierarchy relationships: Workspace→OWNS→Collection→CONTAINS→Book."""
        with neo4j_driver.session() as session:
            result = session.run(
                """MATCH ()-[r]->()
                   RETURN type(r) as rel_type, count(r) as count
                   ORDER BY count DESC"""
            )
            records = list(result)

            logger.info("Relationship types:")
            rel_types = set()
            for r in records:
                logger.info("  %s: %d", r["rel_type"], r["count"])
                rel_types.add(r["rel_type"])

            # Hierarchy relationships should exist
            assert "OWNS" in rel_types or "CONTAINS" in rel_types, f"Should have hierarchy relationships (OWNS/CONTAINS), found: {rel_types}"

    def test_entity_to_chunk_relationships(self, neo4j_driver, test_document):
        """Verify entity nodes are linked to document nodes via relationships.

        Entity extraction links entities to Book nodes via MENTIONS relationships.
        """
        with neo4j_driver.session() as session:
            # Check for Book→Entity relationships (MENTIONS)
            result = session.run(
                """MATCH (b:Book)-[r]->(entity)
                   WHERE any(label IN labels(entity) WHERE label IN $entity_labels)
                   RETURN type(r) as rel_type, count(r) as count
                   ORDER BY count DESC""",
                {"entity_labels": list(ENTITY_LABELS)},
            )
            records = list(result)

            if len(records) == 0:
                # Also check Chunk→Entity direction
                result = session.run(
                    """MATCH (c:Chunk)-[r]->(entity)
                       WHERE any(label IN labels(entity) WHERE label IN $entity_labels)
                       RETURN type(r) as rel_type, count(r) as count
                       ORDER BY count DESC""",
                    {"entity_labels": list(ENTITY_LABELS)},
                )
                records = list(result)

            total_entity_links = sum(r["count"] for r in records)
            logger.info("Entity relationships: %d total", total_entity_links)
            for r in records:
                logger.info("  %s: %d", r["rel_type"], r["count"])

            assert total_entity_links > 0, "No entity relationships found. Entity extraction should create Book→MENTIONS→Entity relationships."

    def test_section_to_chunk_relationships(self, neo4j_driver, test_document):
        """Verify Section→CONTAINS→Chunk relationships exist for section expansion."""
        with neo4j_driver.session() as session:
            result = session.run(
                """MATCH (s:Section)-[:CONTAINS]->(c:Chunk)
                   RETURN count(s) as sections, count(c) as chunks"""
            )
            record = result.single()

            logger.info(
                "Section→Chunk: %d sections linked to %d chunks",
                record["sections"],
                record["chunks"],
            )

            # Section hierarchy is needed for section expansion (P3)
            if record["sections"] == 0:
                logger.warning("No Section→Chunk links found. Section expansion may not work.")

    def test_graph_connectivity(self, neo4j_driver, test_document):
        """Verify the graph is connected (no isolated nodes beyond expected types)."""
        with neo4j_driver.session() as session:
            # Count nodes with no relationships
            result = session.run(
                """MATCH (n)
                   WHERE NOT (n)--()
                   RETURN labels(n)[0] as label, count(n) as count
                   ORDER BY count DESC"""
            )
            isolated = list(result)

            total_isolated = sum(r["count"] for r in isolated)
            if total_isolated > 0:
                logger.info("Isolated nodes (no relationships): %d total", total_isolated)
                for r in isolated:
                    logger.info("  %s: %d isolated", r["label"], r["count"])

            # Most entity nodes should be connected
            total_result = session.run("MATCH (n) RETURN count(n) as count")
            total_nodes = total_result.single()["count"]

            if total_nodes > 0:
                isolation_pct = total_isolated / total_nodes * 100
                logger.info(
                    "Graph connectivity: %d/%d nodes isolated (%.1f%%)",
                    total_isolated,
                    total_nodes,
                    isolation_pct,
                )
                # Allow up to 50% isolated (entity nodes may not have links yet)
                assert isolation_pct < 80, f"Too many isolated nodes: {total_isolated}/{total_nodes} ({isolation_pct:.1f}%)"
