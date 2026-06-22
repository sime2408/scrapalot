"""
Integration Tests for Chat Tutor + Thought Partner Modes

Endpoints under test:
- POST /api/v1/chat/completions with scrapalot.mode = "tutor" + 1 collection
  (Kotlin shim → GenerateChatTutor RPC).
- POST /api/v1/chat/completions with scrapalot.mode = "thought_partner"
  (DirectLLM, questions-only).
- GET  /api/v1/chat/tutor/progress?collection_id=<UUID>

Pipeline: Gateway → Kotlin BE (OpenAICompatibleService → ChatService routing)
→ Python AI gRPC.

The "anthropology" collection (5eeec701-511d-4f85-b8b5-6cbcd64e4467) is a
fixture seeded with 182 Leiden communities + 182 tutor lessons. Tests assume
this fixture exists; they do not rebuild it.

Rules:
- Real DB / real LLM / real gRPC — no mocks.
- All requests go through the Kotlin REST gateway, never direct gRPC.
- All chat calls use the system "Scrapalot AI" provider (gpt-4o-mini).
"""

from uuid import uuid4

import pytest

from tests.conftest import get_accumulated_content, get_packets_by_type, parse_ndjson
from tests.integration.chat_client import chat_post

ANTHROPOLOGY_COLLECTION_ID = "5eeec701-511d-4f85-b8b5-6cbcd64e4467"


@pytest.mark.integration
class TestChatTutorMode:
    """7.8 v3 — AI Tutor curriculum mode (tutor_mode=true + exactly 1 collection)."""

    def test_tutor_mode_streams_message_deltas(self, authenticated_session, api_base_url):
        """tutor_mode + 1 collection → GenerateChatTutor RPC streams a tutor turn.

        Asserts the Kotlin routing branch (ChatService.kt:203) actually reaches
        the Python GenerateChatTutor RPC and emits a non-empty assistant turn
        through the standard message_delta packet flow + a stream_end.
        """
        session_id = str(uuid4())
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Start the curriculum",
            session_id=session_id,
            tutor_mode=True,
            collection_ids=[ANTHROPOLOGY_COLLECTION_ID],
            timeout=120,
        )

        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text[:200]}"

        packets = parse_ndjson(response.text)
        assert len(packets) > 0, "Tutor turn should produce at least one packet"

        deltas = get_packets_by_type(packets, "message_delta")
        assert len(deltas) > 0, f"Tutor turn should emit message_delta packets, got types: {sorted({p.get('obj', {}).get('type') for p in packets})}"

        ends = get_packets_by_type(packets, "stream_end")
        assert len(ends) > 0, "Tutor turn must terminate with a stream_end packet"

        content = get_accumulated_content(packets)
        assert len(content) >= 20, f"Tutor reply should contain meaningful text, got: {content[:200]!r}"

    def test_tutor_progress_returns_curriculum_with_lessons(self, authenticated_session, api_base_url):
        """GET /chat/tutor/progress returns the seeded curriculum (182 lessons).

        Verifies the GetTutorProgress gRPC → Kotlin REST mapping wires through
        every field the sidebar progress badge depends on.
        """
        response = authenticated_session.get(
            f"{api_base_url}/chat/tutor/progress",
            params={"collection_id": ANTHROPOLOGY_COLLECTION_ID},
            timeout=30,
        )

        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text[:200]}"

        body = response.json()
        assert body.get("curriculum_ready") is True, f"Anthropology fixture should have curriculum_ready=True, got: {body}"
        assert body.get("curriculum_status") == "ready", f"Expected curriculum_status='ready', got {body.get('curriculum_status')!r}"
        assert body.get("lesson_count") == 182, f"Expected lesson_count=182, got {body.get('lesson_count')}"

        lessons = body.get("lessons") or []
        assert isinstance(lessons, list) and len(lessons) == 182, f"Expected 182 lessons in payload, got {len(lessons)}"

        first = lessons[0]
        for field in ("lesson_ord", "title", "summary", "level", "completed"):
            assert field in first, f"Lesson payload missing '{field}': {first}"

        assert isinstance(first["title"], str) and len(first["title"]) > 0, f"Lesson title should be a non-empty string: {first}"


@pytest.mark.integration
class TestChatThoughtPartnerMode:
    """7.7 — Thought Partner (DirectLLM, questions-only system prompt)."""

    def test_thought_partner_returns_questions(self, authenticated_session, api_base_url):
        """thought_partner_mode=true → DirectLLM probes with questions, never answers.

        The questions-only system prompt forces the LLM to emit numbered
        probing questions instead of an answer. We assert the response
        contains at least one '?' and is non-trivially long.
        """
        session_id = str(uuid4())
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Should I switch jobs to a startup?",
            session_id=session_id,
            thought_partner_mode=True,
            timeout=90,
        )

        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text[:200]}"

        packets = parse_ndjson(response.text)
        assert len(packets) > 0, "Thought partner should produce at least one packet"

        deltas = get_packets_by_type(packets, "message_delta")
        assert len(deltas) > 0, (
            f"Thought partner should emit message_delta packets, got types: {sorted({p.get('obj', {}).get('type') for p in packets})}"
        )

        content = get_accumulated_content(packets)
        assert len(content) >= 30, f"Thought partner reply too short ({len(content)} chars): {content!r}"
        assert "?" in content, f"Thought partner should ask probing questions (expected '?' in reply), got: {content[:300]!r}"
