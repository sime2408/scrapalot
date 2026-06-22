"""
Integration Tests for Notes Controller

Endpoints: GET /notes, POST /notes, PUT /notes/{id}, DELETE /notes/{id}
Tests the full GW → Kotlin Backend notes management flow.
"""

from uuid import uuid4

import pytest


@pytest.mark.integration
class TestNotes:
    """Integration tests for /notes endpoints."""

    def test_list_notes(self, authenticated_session, api_base_url, test_workspace):
        """Test GET /notes returns notes for a workspace."""
        response = authenticated_session.get(
            f"{api_base_url}/notes",
            params={"workspaceId": test_workspace["id"]},
            timeout=30,
        )

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, (list, dict))

    def test_create_and_delete_note(self, authenticated_session, api_base_url, test_workspace):
        """Test POST /notes creates a note, DELETE removes it."""
        note_title = f"Test Note {uuid4().hex[:8]}"

        # Create
        create_response = authenticated_session.post(
            f"{api_base_url}/notes",
            json={
                "title": note_title,
                "content": "This is a test note content.",
                "workspace_id": test_workspace["id"],
            },
            timeout=30,
        )

        assert create_response.status_code in [200, 201], f"Create failed: {create_response.text}"
        data = create_response.json()
        note_id = data.get("id")
        assert note_id is not None

        # Delete
        delete_response = authenticated_session.delete(
            f"{api_base_url}/notes/{note_id}",
            timeout=30,
        )
        assert delete_response.status_code in [200, 204]

    def test_get_note_by_id(self, authenticated_session, api_base_url, test_workspace):
        """Test GET /notes/{id} returns a specific note."""
        # Create a note
        create_response = authenticated_session.post(
            f"{api_base_url}/notes",
            json={
                "title": f"Get Test {uuid4().hex[:8]}",
                "content": "Test content for get by ID.",
                "workspace_id": test_workspace["id"],
            },
            timeout=30,
        )
        assert create_response.status_code in [200, 201]
        note_id = create_response.json()["id"]

        # Get it
        response = authenticated_session.get(f"{api_base_url}/notes/{note_id}", timeout=30)

        assert response.status_code == 200
        data = response.json()
        assert str(data["id"]) == str(note_id)

        # Cleanup
        authenticated_session.delete(f"{api_base_url}/notes/{note_id}", timeout=30)

    def test_update_note(self, authenticated_session, api_base_url, test_workspace):
        """Test PUT /notes/{id} updates a note."""
        # Create
        create_response = authenticated_session.post(
            f"{api_base_url}/notes",
            json={
                "title": f"Update Test {uuid4().hex[:8]}",
                "content": "Original content.",
                "workspace_id": test_workspace["id"],
            },
            timeout=30,
        )
        assert create_response.status_code in [200, 201]
        note_id = create_response.json()["id"]

        # Update
        new_title = f"Updated {uuid4().hex[:6]}"
        response = authenticated_session.put(
            f"{api_base_url}/notes/{note_id}",
            json={"title": new_title, "content": "Updated content."},
            timeout=30,
        )

        assert response.status_code == 200

        # Cleanup
        authenticated_session.delete(f"{api_base_url}/notes/{note_id}", timeout=30)

    def test_note_persists_in_database(self, authenticated_session, api_base_url, test_workspace, kt_cursor):
        """Test that created notes are persisted in the Kotlin database."""
        note_title = f"DB Verify {uuid4().hex[:8]}"
        create_response = authenticated_session.post(
            f"{api_base_url}/notes",
            json={
                "title": note_title,
                "content": "Database verification test.",
                "workspace_id": test_workspace["id"],
            },
            timeout=30,
        )
        assert create_response.status_code in [200, 201]
        note_id = create_response.json()["id"]

        # Verify in database
        kt_cursor.execute("SELECT * FROM notes WHERE id = %s", (note_id,))
        row = kt_cursor.fetchone()
        assert row is not None, f"Note {note_id} not found in database"

        # Cleanup
        authenticated_session.delete(f"{api_base_url}/notes/{note_id}", timeout=30)
