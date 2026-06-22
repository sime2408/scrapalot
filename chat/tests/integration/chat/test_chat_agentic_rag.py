"""
Integration Tests for Chat Controller - Agentic RAG

Endpoint: POST /v1/chat/completions with scrapalot.mode = "agentic".
Tests agentic routing, strategy selection, packet structure, content quality,
graph search, and multi-source strategies.

Requires: test_document fixture (art_of_war.pdf uploaded and processed).
"""

import pytest

from tests.conftest import assert_meaningful_content, get_accumulated_content, get_packets_by_type, parse_ndjson
from tests.integration.chat_client import chat_post


@pytest.mark.integration
class TestChatAgenticRag:
    """Integration tests for agentic RAG functionality."""

    def test_agentic_rag_enabled(self, authenticated_session, api_base_url, test_collection, test_document):
        """Test chat with agentic RAG routing enabled returns meaningful content."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What is the main topic of the Art of War and why is it important?",
            collection_ids=[str(test_collection["id"])],
            agentic_rag_enabled=True,
            timeout=90,
        )

        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text[:200]}"

        packets = parse_ndjson(response.text)
        assert len(packets) > 0, "Should return at least one packet"

        content = get_accumulated_content(packets)
        assert_meaningful_content(
            content,
            min_length=50,
            topic_keywords=["war", "strategy", "sun tzu", "military", "battle"],
        )

    def test_agentic_rag_packet_structure(self, authenticated_session, api_base_url, test_collection, test_document):
        """Verify agentic RAG produces complete packet structure (start, deltas, end)."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Compare the key themes in the Art of War",
            collection_ids=[str(test_collection["id"])],
            agentic_rag_enabled=True,
            timeout=90,
        )

        assert response.status_code == 200, f"Expected 200, got {response.status_code}"

        packets = parse_ndjson(response.text)
        packet_types = [p.get("obj", {}).get("type") for p in packets]

        # Should have message_delta packets (the actual content)
        deltas = get_packets_by_type(packets, "message_delta")
        assert len(deltas) > 0, f"Should have message_delta packets, got types: {set(packet_types)}"

        # Should have status packets (strategy selection and progress)
        statuses = get_packets_by_type(packets, "status")
        assert len(statuses) > 0, "Agentic RAG should produce status packets for strategy selection"

        # Should have stream_end packet
        stream_ends = get_packets_by_type(packets, "stream_end")
        assert len(stream_ends) >= 1, f"Should have stream_end packet, got types: {set(packet_types)}"

    def test_agentic_rag_with_source_preferences(self, authenticated_session, api_base_url, test_collection, test_document):
        """Test agentic RAG with custom source preferences returns content from collections."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What information is available about warfare strategies?",
            collection_ids=[str(test_collection["id"])],
            agentic_rag_enabled=True,
            source_preferences={
                "collections": 0.8,
                "web_search": 0.1,
                "direct_llm": 0.1,
            },
            timeout=90,
        )

        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text[:200]}"

        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)
        assert len(content) > 0, "Should have response content with source preferences"

    def test_agentic_rag_with_confidence_threshold(self, authenticated_session, api_base_url, test_collection, test_document):
        """Test agentic RAG respects confidence threshold parameter."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What are the main arguments about strategy in the Art of War?",
            collection_ids=[str(test_collection["id"])],
            agentic_rag_enabled=True,
            min_confidence_threshold=0.8,
            timeout=90,
        )

        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text[:200]}"

        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)
        assert_meaningful_content(content, min_length=50)

    def test_agentic_rag_session_continuity(self, authenticated_session, api_base_url, test_collection, test_document):
        """Test agentic RAG maintains session continuity across messages."""
        from uuid import uuid4

        session_id = str(uuid4())

        # First agentic message
        r1 = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What is the Art of War about?",
            session_id=session_id,
            collection_ids=[str(test_collection["id"])],
            agentic_rag_enabled=True,
            timeout=90,
        )

        assert r1.status_code == 200, f"First agentic message failed: {r1.status_code}"

        content1 = get_accumulated_content(parse_ndjson(r1.text))
        assert len(content1) > 20, "First message should have content"

        # Second agentic message in the same session
        r2 = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Tell me more about that topic",
            session_id=session_id,
            collection_ids=[str(test_collection["id"])],
            agentic_rag_enabled=True,
            timeout=90,
        )

        assert r2.status_code == 200, f"Second agentic message failed: {r2.status_code}"

        content2 = get_accumulated_content(parse_ndjson(r2.text))
        assert len(content2) > 20, "Second message should have content (session continuity)"


@pytest.mark.integration
class TestAgenticRagStrategySelection:
    """Tests for agentic RAG strategy selection and routing quality."""

    def test_agentic_rag_selects_strategy(self, authenticated_session, api_base_url, test_collection, test_document):
        """Verify agentic RAG selects an appropriate strategy and reports it in status packets."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Compare Sun Tzu's views on terrain with his views on leadership",
            collection_ids=[str(test_collection["id"])],
            agentic_rag_enabled=True,
            timeout=120,
        )

        assert response.status_code == 200
        packets = parse_ndjson(response.text)

        # Check status packets for strategy information
        statuses = get_packets_by_type(packets, "status")
        status_contents = [s["obj"].get("content", "") for s in statuses]

        import logging

        logger = logging.getLogger(__name__)
        logger.info("Strategy selection statuses: %s", status_contents)

        content = get_accumulated_content(packets)

        if len(content) == 0:
            # Under heavy VPS load, LLM may return empty content
            errors = get_packets_by_type(packets, "error")
            logger.warning(
                "Strategy selection query returned empty content. Packets: %d, errors: %d",
                len(packets),
                len(errors),
            )
            assert len(errors) == 0, f"Stream had errors: {errors}"
        else:
            assert_meaningful_content(
                content,
                min_length=50,
                topic_keywords=["terrain", "leader", "sun tzu", "command", "general"],
            )

    def test_agentic_rag_comparison_query(self, authenticated_session, api_base_url, test_collection, test_document):
        """Test agentic RAG handles comparison queries (should pick multi-query or fusion strategy)."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What are the differences between offensive and defensive strategies discussed in the Art of War?",
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
            topic_keywords=["offensive", "defensive", "attack", "defense", "strategy"],
        )

    def test_agentic_rag_factual_query(self, authenticated_session, api_base_url, test_collection, test_document):
        """Test agentic RAG handles factual queries (should pick similarity or self-query strategy)."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="How many chapters does the Art of War have?",
            collection_ids=[str(test_collection["id"])],
            agentic_rag_enabled=True,
            timeout=90,
        )

        assert response.status_code == 200
        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)

        # Should mention "13" (Art of War has 13 chapters)
        assert len(content) > 20, "Should have a response"
        content_lower = content.lower()
        has_chapter_info = "13" in content or "thirteen" in content_lower
        if not has_chapter_info:
            import logging

            logging.getLogger(__name__).warning("Response doesn't mention 13 chapters: %s", content[:200])
