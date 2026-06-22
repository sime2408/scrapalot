"""
Integration Tests for Sessions Controller

Endpoints: GET /sessions, POST /sessions, PUT /sessions/{id}, DELETE /sessions/{id}, etc.
Tests the full GW → Kotlin Backend session management flow.
"""

from uuid import uuid4

import pytest


@pytest.mark.integration
class TestSessions:
    """Integration tests for /sessions endpoints."""

    def test_create_session(self, authenticated_session, api_base_url):
        """Test POST /sessions creates a new session."""
        response = authenticated_session.post(
            f"{api_base_url}/sessions",
            json={
                "conversation_name": f"Test Session {uuid4().hex[:8]}",
                "last_model_used": "gpt-4o-mini",
            },
            timeout=30,
        )

        assert response.status_code in [200, 201], f"Create failed: {response.text}"
        data = response.json()
        assert "id" in data

    def test_list_sessions(self, authenticated_session, api_base_url):
        """Test GET /sessions returns paginated sessions."""
        response = authenticated_session.get(
            f"{api_base_url}/sessions",
            params={"page": 0, "pageSize": 20},
            timeout=30,
        )

        assert response.status_code == 200
        data = response.json()

        # Kotlin returns {sessions: [...], total, page, page_size, total_pages}
        assert "sessions" in data
        assert isinstance(data["sessions"], list)

    def test_get_session_by_id(self, authenticated_session, api_base_url):
        """Test GET /sessions/{id} returns session details."""
        # Create a session first
        create_response = authenticated_session.post(
            f"{api_base_url}/sessions",
            json={"conversation_name": f"Get Test {uuid4().hex[:8]}"},
            timeout=30,
        )
        assert create_response.status_code in [200, 201]
        session_id = create_response.json()["id"]

        # Get the session
        response = authenticated_session.get(f"{api_base_url}/sessions/{session_id}", timeout=30)

        assert response.status_code == 200
        data = response.json()
        assert str(data["id"]) == str(session_id)

    def test_update_session(self, authenticated_session, api_base_url):
        """Test PUT /sessions/{id} updates a session."""
        # Create a session
        create_response = authenticated_session.post(
            f"{api_base_url}/sessions",
            json={"conversation_name": f"Update Test {uuid4().hex[:8]}"},
            timeout=30,
        )
        assert create_response.status_code in [200, 201]
        session_id = create_response.json()["id"]

        # Update it
        new_name = f"Updated {uuid4().hex[:8]}"
        response = authenticated_session.put(
            f"{api_base_url}/sessions/{session_id}",
            json={"conversation_name": new_name},
            timeout=30,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["conversation_name"] == new_name

    def test_delete_session(self, authenticated_session, api_base_url):
        """Test DELETE /sessions/{id} removes a session."""
        # Create a session
        create_response = authenticated_session.post(
            f"{api_base_url}/sessions",
            json={"conversation_name": f"Delete Test {uuid4().hex[:8]}"},
            timeout=30,
        )
        assert create_response.status_code in [200, 201]
        session_id = create_response.json()["id"]

        # Delete it
        response = authenticated_session.delete(f"{api_base_url}/sessions/{session_id}", timeout=30)
        assert response.status_code in [200, 204]

        # Verify it's gone
        get_response = authenticated_session.get(f"{api_base_url}/sessions/{session_id}", timeout=30)
        assert get_response.status_code == 404

    def test_search_sessions(self, authenticated_session, api_base_url):
        """Test GET /sessions/search returns matching sessions."""
        # Create a session with a known name
        unique_name = f"Searchable {uuid4().hex[:8]}"
        authenticated_session.post(
            f"{api_base_url}/sessions",
            json={"conversation_name": unique_name},
            timeout=30,
        )

        # Search for it
        response = authenticated_session.get(
            f"{api_base_url}/sessions/search",
            params={"query": unique_name[:10]},
            timeout=30,
        )

        assert response.status_code == 200

    def test_filter_sessions_by_collection(self, authenticated_session, api_base_url, test_collection):
        """Test GET /sessions with collectionId filter."""
        response = authenticated_session.get(
            f"{api_base_url}/sessions",
            params={"collectionId": test_collection["id"]},
            timeout=30,
        )

        assert response.status_code == 200

    def test_session_persists_in_database(self, authenticated_session, api_base_url, kt_cursor):
        """Test that created sessions are persisted in the Kotlin database."""
        session_name = f"DB Verify {uuid4().hex[:8]}"
        create_response = authenticated_session.post(
            f"{api_base_url}/sessions",
            json={"conversation_name": session_name},
            timeout=30,
        )
        assert create_response.status_code in [200, 201]
        session_id = create_response.json()["id"]

        # Verify in database
        kt_cursor.execute("SELECT * FROM sessions WHERE id = %s", (session_id,))
        row = kt_cursor.fetchone()
        assert row is not None, f"Session {session_id} not found in database"

        # Cleanup
        authenticated_session.delete(f"{api_base_url}/sessions/{session_id}", timeout=30)
