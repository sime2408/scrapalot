"""
Integration Tests for Chat Controller - Streaming Packet Validation

Endpoint: POST /v1/chat/completions (the OpenAI-compatible shim)
Validates the NDJSON-shaped packet stream the chat_post helper
unwraps from chat.completion.chunk events. Packet structure, ordering,
and types are checked against the same {ind, obj} envelope the UI sees.

Requires: test_document fixture (art_of_war.pdf uploaded and processed).
"""

import json

import pytest

from tests.conftest import assert_meaningful_content, get_accumulated_content, get_packets_by_type, parse_ndjson
from tests.integration.chat_client import chat_post


@pytest.mark.integration
class TestChatStreaming:
    """Integration tests for streaming packet validation."""

    @pytest.fixture
    def chat_response(self, authenticated_session, api_base_url, test_collection, test_document):
        """Make a chat request and return the response for multiple tests."""
        return chat_post(
            authenticated_session,
            api_base_url,
            prompt="Explain the content of the Art of War briefly in 2-3 sentences",
            collection_ids=[str(test_collection["id"])],
            timeout=60,
        )

    def test_response_is_ndjson(self, chat_response):
        """Test that the response is valid NDJSON (each line is valid JSON)."""
        assert chat_response.status_code == 200, f"Chat returned {chat_response.status_code}"

        lines = [line for line in chat_response.text.strip().split("\n") if line.strip()]
        assert len(lines) > 0, "Response should have at least one line"

        for i, line in enumerate(lines):
            try:
                json.loads(line)
            except json.JSONDecodeError:
                pytest.fail(f"Line {i} is not valid JSON: {line[:100]}")

    def test_packet_structure(self, chat_response):
        """Test each packet has 'ind' (int) and 'obj' (dict with 'type')."""
        assert chat_response.status_code == 200, f"Chat returned {chat_response.status_code}"

        packets = parse_ndjson(chat_response.text)
        assert len(packets) > 0

        for packet in packets:
            assert "ind" in packet, f"Packet missing 'ind': {packet}"
            assert isinstance(packet["ind"], int), f"'ind' should be int: {packet['ind']}"
            assert "obj" in packet, f"Packet missing 'obj': {packet}"
            assert isinstance(packet["obj"], dict), "'obj' should be dict"

    def test_packet_index_order(self, chat_response):
        """Test that packet indices are sequential (0, 1, 2, ...)."""
        assert chat_response.status_code == 200, f"Chat returned {chat_response.status_code}"

        packets = parse_ndjson(chat_response.text)
        indices = [p["ind"] for p in packets]

        for i, idx in enumerate(indices):
            assert idx == i, f"Expected index {i}, got {idx}"

    def test_has_message_start(self, chat_response):
        """Test that streaming includes a message_start packet."""
        assert chat_response.status_code == 200, f"Chat returned {chat_response.status_code}"

        packets = parse_ndjson(chat_response.text)
        starts = get_packets_by_type(packets, "message_start")
        assert len(starts) > 0, "Should have at least one message_start packet"

    def test_has_message_delta(self, chat_response):
        """Test that streaming includes message_delta packets with content."""
        assert chat_response.status_code == 200, f"Chat returned {chat_response.status_code}"

        packets = parse_ndjson(chat_response.text)
        deltas = get_packets_by_type(packets, "message_delta")
        assert len(deltas) > 0, "Should have message_delta packets"

    def test_has_stream_end(self, chat_response):
        """Test that streaming ends with a stream_end packet."""
        assert chat_response.status_code == 200, f"Chat returned {chat_response.status_code}"

        packets = parse_ndjson(chat_response.text)
        ends = get_packets_by_type(packets, "stream_end")
        assert len(ends) > 0, "Should have a stream_end packet"

        # stream_end should have a reason
        end_packet = ends[-1]
        assert "reason" in end_packet["obj"] or "content" in end_packet["obj"]

    def test_has_status_packets(self, chat_response):
        """Test that streaming includes status packets."""
        assert chat_response.status_code == 200, f"Chat returned {chat_response.status_code}"

        packets = parse_ndjson(chat_response.text)
        statuses = get_packets_by_type(packets, "status")
        assert len(statuses) > 0, "Should have status packets"

    def test_content_accumulation(self, chat_response):
        """Test that message_delta packets accumulate into meaningful Art of War content."""
        assert chat_response.status_code == 200, f"Chat returned {chat_response.status_code}"

        packets = parse_ndjson(chat_response.text)
        content = get_accumulated_content(packets)
        assert_meaningful_content(
            content,
            min_length=30,
            topic_keywords=["war", "strategy", "sun tzu", "military", "battle", "enemy", "army"],
        )

    def test_all_packets_have_type(self, chat_response):
        """Test that all packets in obj have a type field."""
        assert chat_response.status_code == 200, f"Chat returned {chat_response.status_code}"

        packets = parse_ndjson(chat_response.text)
        for packet in packets:
            obj = packet.get("obj", {})
            assert "type" in obj, f"Packet obj missing 'type': {obj}"
