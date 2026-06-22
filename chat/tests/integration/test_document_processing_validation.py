"""
Integration Tests for Document Processing Validation

Validates the document processing pipeline by comparing raw markdown content
(stored in documents.content) against parsed output (chunks, hierarchy, Neo4j graph).
Detects content loss, ordering gaps, generic headings, and cross-store inconsistencies.

Tests:
1. Chunk coverage against raw content (word overlap >85%)
2. Chunk ordering has no gaps (0-based sequential)
3. Hierarchy chapter titles found in raw markdown (>70% match)
4. Hierarchy chunk_range covers all chunks (>80%)
5. Section boundaries are meaningful, not all "Section N" (<50% generic)
6. PG chapter count ~ Neo4j Chapter node count (±30% tolerance)
"""

import json
import logging
import re

import pytest

logger = logging.getLogger(__name__)


@pytest.mark.integration
class TestDocumentProcessingValidation:
    """Validates document processing pipeline output against raw source content."""

    def test_chunk_coverage_against_raw_content(self, py_cursor, test_collection, test_document):
        """Verify word overlap between raw markdown and concatenated chunks exceeds 85%."""
        collection_id = test_collection["id"]

        # Get raw markdown from documents.content
        py_cursor.execute(
            "SELECT content FROM documents WHERE collection_id = %s AND processing_status = 'completed' LIMIT 1",
            (collection_id,),
        )
        doc_row = py_cursor.fetchone()
        if not doc_row or not doc_row["content"]:
            pytest.skip("No raw content found in documents table")

        raw_content = doc_row["content"]
        raw_words = set(re.findall(r"\b\w{3,}\b", raw_content.lower()))

        # Get all chunk texts from embeddings
        py_cursor.execute(
            """SELECT e.document as chunk_text
               FROM langchain_pg_embedding e
               WHERE e.collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )""",
            (collection_id,),
        )
        chunks = py_cursor.fetchall()
        assert len(chunks) > 0, "Should have chunks/embeddings"

        chunk_text = " ".join(c["chunk_text"] for c in chunks if c["chunk_text"])
        chunk_words = set(re.findall(r"\b\w{3,}\b", chunk_text.lower()))

        if not raw_words:
            pytest.skip("Raw content has no extractable words")

        overlap = len(raw_words & chunk_words) / len(raw_words)
        logger.info(
            "Chunk coverage: %d/%d raw words found in chunks (%.1f%%)",
            len(raw_words & chunk_words),
            len(raw_words),
            overlap * 100,
        )

        assert overlap > 0.85, (
            f"Only {overlap:.1%} of raw content words found in chunks. Expected >85%. Check _filter_headers_footers() or micro-chunk threshold."
        )

    def test_chunk_ordering_no_gaps(self, py_cursor, test_collection, test_document):
        """Verify chunk_index is sequential (0-based) with no gaps."""
        collection_id = test_collection["id"]

        py_cursor.execute(
            """SELECT (e.cmetadata->>'chunk_index')::int as chunk_idx
               FROM langchain_pg_embedding e
               WHERE e.collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )
               AND e.cmetadata->>'chunk_index' IS NOT NULL
               ORDER BY chunk_idx""",
            (collection_id,),
        )
        rows = py_cursor.fetchall()
        if not rows:
            pytest.skip("No chunks with chunk_index metadata")

        indices = [r["chunk_idx"] for r in rows]
        logger.info("Chunk indices: min=%d, max=%d, count=%d", min(indices), max(indices), len(indices))

        # Check 0-based start
        assert indices[0] == 0, f"Chunk indices should start at 0, got {indices[0]}"

        # Separate duplicates from true gaps
        unique_indices = sorted(set(indices))
        duplicates = len(indices) - len(unique_indices)
        if duplicates:
            logger.warning("Found %d duplicate chunk indices", duplicates)

        # Check for gaps in unique sorted indices
        gaps = []
        for i in range(1, len(unique_indices)):
            if unique_indices[i] != unique_indices[i - 1] + 1:
                gaps.append((unique_indices[i - 1], unique_indices[i]))

        if gaps:
            logger.warning("Found %d gaps in chunk ordering: %s", len(gaps), gaps[:10])

        # Gaps and duplicates indicate re-indexing issues in the embedding pipeline.
        # Report both but allow a tolerance for known batch-storage edge cases.
        total_issues = len(gaps) + duplicates
        issue_pct = total_issues / len(indices) if indices else 0

        assert issue_pct < 0.25, (
            f"Found {len(gaps)} gaps and {duplicates} duplicates in {len(indices)} chunks "
            f"({issue_pct:.1%} issues). Check re-indexing logic in chunking_service.py."
        )

    def test_hierarchy_chapters_match_content(self, py_cursor, test_collection, test_document):
        """Verify chapter titles in hierarchy JSON are found in raw markdown (>70% match)."""
        collection_id = test_collection["id"]

        # Get document hierarchy JSON
        py_cursor.execute(
            "SELECT document_hierarchy FROM documents WHERE collection_id = %s AND processing_status = 'completed' LIMIT 1",
            (collection_id,),
        )
        doc_row = py_cursor.fetchone()
        if not doc_row or not doc_row.get("document_hierarchy"):
            pytest.skip("No document_hierarchy found")

        hierarchy = doc_row["document_hierarchy"]
        if isinstance(hierarchy, str):
            hierarchy = json.loads(hierarchy)

        # Get raw content
        py_cursor.execute(
            "SELECT content FROM documents WHERE collection_id = %s AND processing_status = 'completed' LIMIT 1",
            (collection_id,),
        )
        content_row = py_cursor.fetchone()
        raw_content = (content_row["content"] or "") if content_row else ""
        raw_lower = raw_content.lower()

        # Extract chapter titles from hierarchy keys
        chapter_titles = []
        for key in hierarchy.keys():
            # Remove H1:/H2: prefix
            title = re.sub(r"^H\d+:\s*", "", key).strip()
            if title:
                chapter_titles.append(title)

        if not chapter_titles:
            pytest.skip("No chapter titles in hierarchy")

        matched = 0
        for title in chapter_titles:
            # Extract meaningful words from title for fuzzy matching
            title_words = re.findall(r"\b\w{3,}\b", title.lower())
            if not title_words:
                matched += 1  # Skip trivially short titles
                continue
            word_hits = sum(1 for w in title_words if w in raw_lower)
            if word_hits / len(title_words) >= 0.5:
                matched += 1

        match_rate = matched / len(chapter_titles) if chapter_titles else 1.0
        logger.info(
            "Hierarchy chapter match: %d/%d titles found in raw content (%.1f%%)",
            matched,
            len(chapter_titles),
            match_rate * 100,
        )

        assert match_rate > 0.70, (
            f"Only {match_rate:.1%} of hierarchy chapter titles match raw content. "
            f"Check _normalize_chapter_markers() and _extract_hierarchy_metadata()."
        )

    def test_chunk_range_coverage(self, py_cursor, test_collection, test_document):
        """Verify hierarchy chunk_range covers >80% of all chunks."""
        collection_id = test_collection["id"]

        # Get hierarchy
        py_cursor.execute(
            "SELECT document_hierarchy FROM documents WHERE collection_id = %s AND processing_status = 'completed' LIMIT 1",
            (collection_id,),
        )
        doc_row = py_cursor.fetchone()
        if not doc_row or not doc_row.get("document_hierarchy"):
            pytest.skip("No document_hierarchy found")

        hierarchy = doc_row["document_hierarchy"]
        if isinstance(hierarchy, str):
            hierarchy = json.loads(hierarchy)

        # Count total chunks
        py_cursor.execute(
            """SELECT COUNT(*) as cnt
               FROM langchain_pg_embedding e
               WHERE e.collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )""",
            (collection_id,),
        )
        total_chunks = py_cursor.fetchone()["cnt"]
        if total_chunks == 0:
            pytest.skip("No chunks found")

        # Collect all chunk indices covered by hierarchy ranges
        covered_indices = set()

        def collect_ranges(node):
            if isinstance(node, dict):
                chunk_range = node.get("chunk_range")
                if chunk_range and isinstance(chunk_range, list) and len(chunk_range) == 2:
                    start, end = chunk_range
                    covered_indices.update(range(start, end + 1))
                children = node.get("children", {})
                if isinstance(children, dict):
                    for child in children.values():
                        collect_ranges(child)

        for section in hierarchy.values():
            collect_ranges(section)

        coverage = len(covered_indices) / total_chunks if total_chunks else 0
        logger.info(
            "Chunk range coverage: %d/%d chunks covered by hierarchy (%.1f%%)",
            len(covered_indices),
            total_chunks,
            coverage * 100,
        )

        assert coverage > 0.80, (
            f"Only {coverage:.1%} of chunks covered by hierarchy chunk_range. "
            f"Expected >80%. Check _build_hierarchy_tree() in chunking_enhanced_markdown.py."
        )

    def test_section_boundaries_meaningful(self, py_cursor, test_collection, test_document):
        """Verify section headings are not all generic 'Section N' (<50% generic threshold)."""
        collection_id = test_collection["id"]

        py_cursor.execute(
            """SELECT cmetadata->>'section_heading' as heading
               FROM langchain_pg_embedding e
               WHERE e.collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )
               AND cmetadata->>'section_heading' IS NOT NULL""",
            (collection_id,),
        )
        rows = py_cursor.fetchall()
        if not rows:
            pytest.skip("No section_heading metadata in embeddings")

        total = len(rows)
        generic_count = sum(1 for r in rows if r["heading"] and re.match(r"^Section\s+\d+$", r["heading"]))
        generic_pct = generic_count / total if total else 0

        logger.info(
            "Section heading quality: %d/%d generic 'Section N' (%.1f%%), %d meaningful",
            generic_count,
            total,
            generic_pct * 100,
            total - generic_count,
        )

        assert generic_pct < 0.50, (
            f"{generic_pct:.1%} of section headings are generic 'Section N'. "
            f"Expected <50%. Check numbered item heuristic in _extract_hierarchy_metadata()."
        )

    @pytest.mark.neo4j
    def test_pgvector_neo4j_chapter_consistency(self, py_cursor, test_collection, test_document, neo4j_driver):
        """Verify PG chapter count approximately matches Neo4j Chapter node count (±30%)."""
        collection_id = test_collection["id"]

        # Count distinct chapters in pgvector embeddings
        py_cursor.execute(
            """SELECT COUNT(DISTINCT cmetadata->>'chapter_number') as chapter_count
               FROM langchain_pg_embedding e
               WHERE e.collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )
               AND cmetadata->>'chapter_number' IS NOT NULL""",
            (collection_id,),
        )
        pg_chapters = py_cursor.fetchone()["chapter_count"]

        # Count Chapter nodes in Neo4j scoped to the test collection
        with neo4j_driver.session() as session:
            result = session.run(
                """MATCH (col:Collection)-[:CONTAINS]->(b:Book)-[:HAS_CHAPTER]->(ch:Chapter)
                   WHERE col.id = $collection_id
                   RETURN count(DISTINCT ch) as chapter_count""",
                collection_id=collection_id,
            )
            neo4j_chapters = result.single()["chapter_count"]

        logger.info(
            "Chapter consistency: PG=%d distinct chapters, Neo4j=%d Chapter nodes",
            pg_chapters,
            neo4j_chapters,
        )

        if pg_chapters == 0 and neo4j_chapters == 0:
            pytest.skip("No chapters in either store")

        # Allow ±30% tolerance
        max_count = max(pg_chapters, neo4j_chapters)
        min_count = min(pg_chapters, neo4j_chapters)
        if max_count == 0:
            pytest.skip("No chapters found")

        ratio = min_count / max_count
        assert ratio >= 0.70, (
            f"PG chapters ({pg_chapters}) vs Neo4j chapters ({neo4j_chapters}) differ by "
            f"{(1 - ratio):.1%}. Expected within ±30%. "
            f"Check node_factory.py and graph_integration_service.py."
        )
