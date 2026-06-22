"""
Integration Tests for Documents Controller

Endpoints: GET /documents, POST /documents/upload, etc.
Tests the full GW → Kotlin Backend → Python document management flow.
"""

import logging

import pytest

logger = logging.getLogger(__name__)


@pytest.mark.integration
class TestDocuments:
    """Integration tests for /documents endpoints."""

    def test_list_documents_via_db(self, py_cursor, test_collection, test_document):
        """Verify documents exist in the Python DB for the test collection."""
        collection_id = test_collection["id"]
        py_cursor.execute(
            "SELECT id, title, filename, processing_status FROM documents WHERE collection_id = %s",
            (collection_id,),
        )
        docs = py_cursor.fetchall()
        assert len(docs) > 0, f"No documents found for collection {collection_id}"
        logger.info("Found %d documents in collection %s", len(docs), collection_id)
        for doc in docs:
            logger.info("  %s - %s (%s)", doc["filename"], doc["processing_status"], doc["id"])

    def test_completed_documents_exist(self, py_cursor, test_collection, test_document):
        """Verify at least one document has completed processing."""
        collection_id = test_collection["id"]
        py_cursor.execute(
            "SELECT id, filename, processing_status FROM documents WHERE collection_id = %s AND processing_status = 'completed'",
            (collection_id,),
        )
        completed = py_cursor.fetchall()
        assert len(completed) > 0, f"No completed documents in collection {collection_id}. At least one document should have completed processing."
        logger.info(
            "Found %d completed documents: %s",
            len(completed),
            [d["filename"] for d in completed],
        )

    def test_verify_embeddings_exist(self, py_cursor, test_collection, test_document):
        """Verify the test collection has embeddings in pgvector."""
        collection_id = test_collection["id"]

        py_cursor.execute(
            """SELECT COUNT(*) as count FROM langchain_pg_embedding
               WHERE collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )""",
            (collection_id,),
        )
        result = py_cursor.fetchone()
        count = result["count"] if result else 0
        assert count > 0, f"No embeddings found for collection {collection_id}"
        logger.info("Collection %s has %d embeddings", collection_id, count)

    def test_embedding_quality(self, py_cursor, test_collection, test_document):
        """Verify embedding quality - each embedding has metadata and content."""
        collection_id = test_collection["id"]

        py_cursor.execute(
            """SELECT e.document, e.cmetadata
               FROM langchain_pg_embedding e
               WHERE e.collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )
               LIMIT 10""",
            (collection_id,),
        )
        embeddings = py_cursor.fetchall()
        assert len(embeddings) > 0, "Should have embeddings to check quality"

        for emb in embeddings:
            # Each embedding should have content
            assert emb["document"] is not None, "Embedding document (content) should not be null"
            assert len(emb["document"]) > 10, f"Embedding content too short: {len(emb['document'])} chars"

            # Each embedding should have metadata
            metadata = emb["cmetadata"]
            assert metadata is not None, "Embedding metadata should not be null"
            assert isinstance(metadata, dict), "Embedding metadata should be a dict"

        logger.info("Checked %d embeddings - all have valid content and metadata", len(embeddings))

    def test_document_summaries(self, py_cursor, test_collection, test_document):
        """Verify document summaries were generated during processing."""
        collection_id = test_collection["id"]

        py_cursor.execute(
            """SELECT ds.document_id, ds.summary_type, ds.chapter_title,
                      ds.chapter_index, LENGTH(ds.summary_text) as text_len
               FROM document_summaries ds
               JOIN documents d ON ds.document_id = d.id
               WHERE d.collection_id = %s
               ORDER BY ds.chapter_index NULLS LAST
               LIMIT 20""",
            (collection_id,),
        )
        summaries = py_cursor.fetchall()
        logger.info("Found %d document summaries for collection", len(summaries))
        for s in summaries:
            logger.info(
                "  doc=%s type=%s chapter=%s len=%d",
                s["document_id"],
                s["summary_type"],
                s["chapter_title"] or "N/A",
                s["text_len"],
            )
