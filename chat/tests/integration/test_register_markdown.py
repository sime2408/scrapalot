import uuid

import pytest


@pytest.mark.integration
def test_register_document_from_markdown(authenticated_session, api_base_url, db_cursor, test_collection, sync_test_data_to_python_db):
    """RegisterDocumentFromMarkdown inserts a pending document with markdown content."""
    collection_id = str(test_collection["id"])
    filename = f"test_book_{uuid.uuid4().hex[:8]}.pdf"
    markdown = "# Chapter 1\n\nThis is test content for the batch ingest pipeline."

    response = authenticated_session.post(
        f"{api_base_url}/documents/register-markdown",
        json={
            "collectionId": collection_id,
            "filename": filename,
            "title": "Test Batch Book",
            "markdownContent": markdown,
            "metadata": {"pages": 42, "source_format": "pdf"},
        },
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["documentId"]
    document_id = body["documentId"]

    # Verify in Python DB (documents table)
    db_cursor.execute(
        "SELECT id, processing_status, content, filename FROM documents WHERE id = %s",
        (document_id,),
    )
    row = db_cursor.fetchone()
    assert row is not None, "Document not found in DB"
    assert row[1] == "pending", f"Expected status=pending, got {row[1]}"
    assert markdown in (row[2] or ""), "Markdown content not stored"
    assert row[3] == filename


@pytest.mark.integration
def test_register_markdown_no_embeddings(authenticated_session, api_base_url, db_cursor, test_collection, sync_test_data_to_python_db):
    """Registered document must NOT have any embeddings created."""
    collection_id = str(test_collection["id"])

    response = authenticated_session.post(
        f"{api_base_url}/documents/register-markdown",
        json={
            "collectionId": collection_id,
            "filename": f"no_embed_{uuid.uuid4().hex[:8]}.pdf",
            "title": "No Embed Test",
            "markdownContent": "# No Embeddings\n\nThis must not be embedded.",
            "metadata": {},
        },
    )

    assert response.status_code == 201, response.text
    document_id = response.json()["documentId"]

    # Check pgvector — no embeddings should exist for this specific document
    db_cursor.execute(
        """
        SELECT COUNT(*) FROM langchain_pg_embedding
        WHERE cmetadata::jsonb ->> 'document_id' = %s
        """,
        (document_id,),
    )
    count = db_cursor.fetchone()[0]
    assert count == 0, f"Expected 0 embeddings for document {document_id}, got {count}"
