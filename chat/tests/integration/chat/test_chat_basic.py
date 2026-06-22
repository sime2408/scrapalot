"""
Integration Tests for Chat Controller - Basic Functionality

Endpoint: POST /v1/chat/completions (the OpenAI-compatible shim)
Tests basic chat requests, session handling, and response format.
Full flow: Gateway -> Kotlin -> Python (via gRPC).

Requires: test_document fixture (art_of_war.pdf uploaded and processed).
"""

from uuid import uuid4

import pytest

from tests.conftest import assert_meaningful_content, get_accumulated_content, parse_ndjson
from tests.integration.chat_client import chat_post


@pytest.mark.integration
class TestChatBasic:
    """Integration tests for /v1/chat/completions - basic functionality."""

    def test_chat_generate_basic(self, authenticated_session, api_base_url, test_collection, test_document):
        """Test basic chat generation with RAG against uploaded document."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What are the main themes of the Art of War?",
            collection_ids=[str(test_collection["id"])],
            timeout=60,
        )

        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text[:200]}"

        packets = parse_ndjson(response.text)
        assert len(packets) > 0, "Should receive at least one packet"

        content = get_accumulated_content(packets)
        assert_meaningful_content(
            content,
            min_length=50,
            topic_keywords=["war", "strategy", "sun tzu", "enemy", "battle", "military", "army"],
        )

    def test_chat_generate_without_collections(self, authenticated_session, api_base_url):
        """Test chat generation without collections (direct LLM)."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What is 2 + 2? Answer with just the number.",
            collection_ids=[],
            timeout=60,
        )

        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text[:200]}"

        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)
        assert "4" in content, f"Expected '4' in response, got: {content[:200]}"

    def test_chat_with_session_continuation(self, authenticated_session, api_base_url, test_collection, test_document):
        """Test chat with session_id for conversation continuation."""
        session_id = str(uuid4())

        # First message
        response1 = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What is the main topic of the Art of War?",
            session_id=session_id,
            collection_ids=[str(test_collection["id"])],
            timeout=60,
        )

        assert response1.status_code == 200, f"First message failed: {response1.status_code}"

        # Second message in the same session
        response2 = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Can you elaborate on that?",
            session_id=session_id,
            collection_ids=[str(test_collection["id"])],
            timeout=60,
        )

        assert response2.status_code == 200, f"Second message failed: {response2.status_code}"

    def test_chat_creates_session_in_database(self, authenticated_session, api_base_url, test_collection, test_document, kt_cursor):
        """Test that chat creates a session record in the Kotlin database."""
        session_id = str(uuid4())

        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Brief summary of the Art of War",
            session_id=session_id,
            collection_ids=[str(test_collection["id"])],
            timeout=60,
        )

        assert response.status_code == 200, f"Chat failed: {response.status_code}"

        # Verify session exists in database
        kt_cursor.execute("SELECT * FROM scrapalot.sessions WHERE id = %s", (session_id,))
        session = kt_cursor.fetchone()
        assert session is not None, f"Session {session_id} not found in database"

    def test_chat_with_web_search(self, authenticated_session, api_base_url, test_collection, test_document):
        """Test chat with web search enabled."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What are the latest developments in AI?",
            collection_ids=[str(test_collection["id"])],
            web_search_enabled=True,
            timeout=90,
        )

        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text[:200]}"

        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)
        assert len(content) > 100, f"Web search response too short: {len(content)} chars"

    def test_chat_response_not_empty(self, authenticated_session, api_base_url, test_collection, test_document):
        """Test that a successful chat response contains actual content."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Summarize the key points of the Art of War in one sentence",
            collection_ids=[str(test_collection["id"])],
            timeout=60,
        )

        assert response.status_code == 200, f"Expected 200, got {response.status_code}"

        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)
        assert len(content) > 0, "Chat response should contain actual text content"
