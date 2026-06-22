"""
Integration Tests for Messages Controller

Endpoints: GET /messages, POST /messages, DELETE /messages/{id}, etc.
Tests the full GW → Kotlin Backend message management flow.
"""

from uuid import uuid4

import pytest


@pytest.mark.integration
class TestMessages:
    """Integration tests for /messages endpoints."""

    @pytest.fixture(autouse=False)
    def test_session_id(self, authenticated_session, api_base_url):
        """Create a temporary session for message tests."""
        response = authenticated_session.post(
            f"{api_base_url}/sessions",
            json={"conversation_name": f"Msg Test {uuid4().hex[:8]}"},
            timeout=30,
        )
        assert response.status_code in [200, 201]
        session_id = response.json()["id"]
        yield session_id
        # Cleanup session (cascades to messages)
        authenticated_session.delete(f"{api_base_url}/sessions/{session_id}", timeout=30)

    def test_create_message(self, authenticated_session, api_base_url, test_session_id):
        """Test POST /messages creates a message."""
        response = authenticated_session.post(
            f"{api_base_url}/messages",
            json={
                "session_id": test_session_id,
                "role": "user",
                "content": "Hello, this is a test message.",
            },
            timeout=30,
        )

        assert response.status_code in [200, 201], f"Create failed: {response.text}"
        data = response.json()
        assert "id" in data
        assert data["content"] == "Hello, this is a test message."

    def test_list_messages(self, authenticated_session, api_base_url, test_session_id):
        """Test GET /messages returns messages for a session."""
        # Create a message first
        authenticated_session.post(
            f"{api_base_url}/messages",
            json={"session_id": test_session_id, "role": "user", "content": "List test message"},
            timeout=30,
        )

        # List messages
        response = authenticated_session.get(
            f"{api_base_url}/messages",
            params={"sessionId": test_session_id},
            timeout=30,
        )

        assert response.status_code == 200
        data = response.json()

        # Kotlin returns {messages: [...], total, page, page_size, total_pages}
        messages = data.get("messages", data) if isinstance(data, dict) else data
        assert isinstance(messages, list)
        assert len(messages) > 0

    def test_get_message_by_id(self, authenticated_session, api_base_url, test_session_id):
        """Test GET /messages/{id} returns a specific message."""
        # Create a message
        create_response = authenticated_session.post(
            f"{api_base_url}/messages",
            json={"session_id": test_session_id, "role": "user", "content": "Get by ID test"},
            timeout=30,
        )
        assert create_response.status_code in [200, 201]
        message_id = create_response.json()["id"]

        # Get it
        response = authenticated_session.get(f"{api_base_url}/messages/{message_id}", timeout=30)

        assert response.status_code == 200
        data = response.json()
        assert str(data["id"]) == str(message_id)

    def test_delete_message(self, authenticated_session, api_base_url, test_session_id):
        """Test DELETE /messages/{id} removes a message."""
        # Create a message
        create_response = authenticated_session.post(
            f"{api_base_url}/messages",
            json={"session_id": test_session_id, "role": "user", "content": "Delete test"},
            timeout=30,
        )
        assert create_response.status_code in [200, 201]
        message_id = create_response.json()["id"]

        # Delete it
        response = authenticated_session.delete(f"{api_base_url}/messages/{message_id}", timeout=30)
        assert response.status_code in [200, 204]

    def test_get_latest_message(self, authenticated_session, api_base_url, test_session_id):
        """Test GET /messages/latest returns the latest message."""
        # Create messages
        authenticated_session.post(
            f"{api_base_url}/messages",
            json={"session_id": test_session_id, "role": "user", "content": "First message"},
            timeout=30,
        )
        authenticated_session.post(
            f"{api_base_url}/messages",
            json={"session_id": test_session_id, "role": "assistant", "content": "Second message"},
            timeout=30,
        )

        # Get latest
        response = authenticated_session.get(
            f"{api_base_url}/messages/latest",
            params={"sessionId": test_session_id},
            timeout=30,
        )

        assert response.status_code == 200

    def test_search_messages(self, authenticated_session, api_base_url, test_session_id):
        """Test GET /messages/search finds messages by content."""
        unique_content = f"unique_search_term_{uuid4().hex[:8]}"
        authenticated_session.post(
            f"{api_base_url}/messages",
            json={"session_id": test_session_id, "role": "user", "content": unique_content},
            timeout=30,
        )

        response = authenticated_session.get(
            f"{api_base_url}/messages/search",
            params={"sessionId": test_session_id, "query": unique_content[:20]},
            timeout=30,
        )

        assert response.status_code == 200

    def test_message_persists_in_database(self, authenticated_session, api_base_url, test_session_id, kt_cursor):
        """Test that created messages are persisted in the Kotlin database."""
        create_response = authenticated_session.post(
            f"{api_base_url}/messages",
            json={"session_id": test_session_id, "role": "user", "content": "DB verify message"},
            timeout=30,
        )
        assert create_response.status_code in [200, 201]
        message_id = create_response.json()["id"]

        # Verify in database
        kt_cursor.execute("SELECT * FROM messages WHERE id = %s", (message_id,))
        row = kt_cursor.fetchone()
        assert row is not None, f"Message {message_id} not found in database"
