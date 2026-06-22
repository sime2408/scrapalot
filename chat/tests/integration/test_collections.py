"""
Integration Tests for Collections Controller

Endpoints: GET /collections, POST /collections, etc.
Tests the full GW → Kotlin Backend collection management flow.
"""

import uuid

import pytest


@pytest.mark.integration
class TestCollections:
    """Integration tests for /collections endpoints."""

    def test_list_collections(self, authenticated_session, api_base_url, test_workspace):
        """Test GET /collections returns collections for a workspace."""
        response = authenticated_session.get(
            f"{api_base_url}/collections",
            params={"workspaceId": test_workspace["id"]},
            timeout=30,
        )

        assert response.status_code == 200
        data = response.json()

        # Kotlin returns {collections: [...], pagination: {...}}
        collections = data.get("collections", data) if isinstance(data, dict) else data
        assert isinstance(collections, list)

    def test_get_collection_by_id(self, authenticated_session, api_base_url, test_collection):
        """Test GET /collections/{id} returns a specific collection."""
        response = authenticated_session.get(
            f"{api_base_url}/collections/{test_collection['id']}",
            timeout=30,
        )

        assert response.status_code == 200
        data = response.json()
        assert str(data["id"]) == str(test_collection["id"])

    def test_get_collections_by_workspace(self, authenticated_session, api_base_url, test_workspace):
        """Test GET /collections/workspace/{id} returns collections."""
        response = authenticated_session.get(
            f"{api_base_url}/collections/workspace/{test_workspace['id']}",
            timeout=30,
        )

        assert response.status_code == 200

    def test_create_and_delete_collection(self, authenticated_session, api_base_url, test_workspace):
        """Test POST /collections creates a collection, DELETE removes it."""
        collection_name = f"Test Collection {uuid.uuid4().hex[:8]}"

        # Create
        create_response = authenticated_session.post(
            f"{api_base_url}/collections",
            json={
                "name": collection_name,
                "workspace_id": test_workspace["id"],
                "chunking_strategy": "recursive",
            },
            timeout=30,
        )

        assert create_response.status_code in [200, 201], f"Create failed: {create_response.text}"

        data = create_response.json()
        collection_id = data.get("id")
        assert collection_id is not None

        # Delete
        delete_response = authenticated_session.delete(
            f"{api_base_url}/collections/{collection_id}",
            timeout=30,
        )

        assert delete_response.status_code in [200, 204]

    def test_get_collection_summary(self, authenticated_session, api_base_url, test_collection):
        """Test GET /collections/{id}/summary returns document summary."""
        response = authenticated_session.get(
            f"{api_base_url}/collections/{test_collection['id']}/summary",
            timeout=30,
        )

        assert response.status_code == 200
        data = response.json()
        assert "document_count" in data or "name" in data

    def test_verify_collection_has_chunks(self, py_cursor, test_collection, test_document):
        """Verify the test collection has embeddings in pgvector after document upload."""
        collection_id = test_collection["id"]

        # The embedding's collection_id references langchain_pg_collection.uuid,
        # where the collection name matches our collection UUID
        py_cursor.execute(
            """SELECT COUNT(*) as count FROM langchain_pg_embedding
               WHERE collection_id = (
                   SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
               )""",
            (collection_id,),
        )
        result = py_cursor.fetchone()
        count = result["count"] if result else 0
        assert count > 0, f"Collection {collection_id} has no embeddings in pgvector"
