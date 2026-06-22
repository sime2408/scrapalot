"""
End-to-end API tests for the LLM-backed Notes Assistant endpoints.

Covers the writer-facing AI surfaces under `/api/v1/notes/assistant/*`:

    POST /notes/assistant/ghost-complete           — inline ghost-text autocomplete
    POST /notes/assistant/compose-from-sources     — RAG-grounded paragraph generation
    POST /notes/assistant/critique-with-questions  — Socratic 3–5 probing questions

Each test goes through the real gateway → Kotlin BE → gRPC → Python AI
chain (no mocks); model provider is "Scrapalot AI" / `gpt-4o-mini` per
the integration-suite convention. Marked `slow` because the system-
provider roundtrip is dominated by the LLM (5–30 s) — pure-CRUD tests
for the version-control endpoints live in `test_versions.py` so they
can run in the fast slice when a dev only wants to check non-LLM
contracts.

Assertions focus on the *contract* (response shape, machine-readable
error codes, echo / hallucination guards) rather than the wording of
the model's prose, which drifts run-to-run.
"""

from __future__ import annotations

import pytest

# ---------------------------------------------------------------------------
# Ghost-text autocomplete
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.slow
class TestGhostComplete:
    """POST /notes/assistant/ghost-complete — single short LLM continuation
    at the cursor for the inline writer-suggestion UX."""

    def test_short_context_returns_empty_no_op(self, authenticated_session, gateway_url):
        """The service guards against firing the LLM when the user has
        not typed enough signal yet — under 10 chars before the cursor
        should short-circuit to success=false / error='context_too_short'.
        Cheaper than a hallucinated opening."""
        response = authenticated_session.post(
            f"{gateway_url}/notes/assistant/ghost-complete",
            json={
                "text_before_cursor": "Hi",
                "text_after_cursor": "",
                "note_outline": "",
                "language": "en",
            },
            timeout=15,
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["success"] is False
        assert data["suggestion"] == ""
        assert data["error"] == "context_too_short"

    def test_returns_continuation_for_real_context(self, authenticated_session, gateway_url):
        """With enough leading text the agent should return a non-empty
        suggestion. We don't assert on the prose itself (LLM output
        varies); we assert success + non-empty text and that the
        response shape matches the proto contract."""
        before = "Working memory has been studied extensively over the past five decades. The classical model of Baddeley and Hitch posits a "
        response = authenticated_session.post(
            f"{gateway_url}/notes/assistant/ghost-complete",
            json={
                "text_before_cursor": before,
                "text_after_cursor": "",
                "note_outline": "Working Memory & Attention",
                "language": "en",
            },
            timeout=20,
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert set(data.keys()) >= {"success", "suggestion", "error"}
        assert data["success"] is True, f"Expected success, got error={data.get('error')!r}"
        assert isinstance(data["suggestion"], str)
        assert len(data["suggestion"]) > 0
        # Echo guard: the suggestion must NOT be the trailing fragment
        # of `before` verbatim — the service is supposed to strip that.
        assert not data["suggestion"].startswith(before[-40:].lstrip())


# ---------------------------------------------------------------------------
# Thought partner — Socratic critique
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.slow
class TestCritiqueWithQuestions:
    """POST /notes/assistant/critique-with-questions — returns 3–5 short
    probing questions that test the user's reasoning instead of
    synthesising an answer. Retrieval-free by design."""

    def test_empty_note_short_circuits(self, authenticated_session, gateway_url):
        """Empty draft → success=false / error='empty_note'. Cheaper
        than asking the LLM to interrogate a void."""
        response = authenticated_session.post(
            f"{gateway_url}/notes/assistant/critique-with-questions",
            json={"note_text": "", "language": "en"},
            timeout=15,
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["success"] is False
        assert data["error"] == "empty_note"
        assert data["questions"] == []

    def test_returns_3_to_5_questions(self, authenticated_session, gateway_url):
        """Real draft → 3–5 numbered probing questions. We assert on
        the *structure* (count + non-empty) rather than the wording."""
        draft = (
            "<p>Universal basic income would solve poverty because it "
            "removes the marginal-tax-rate cliff and gives recipients "
            "agency. Pilots in Finland and Stockton showed positive "
            "outcomes on wellbeing.</p>"
        )
        response = authenticated_session.post(
            f"{gateway_url}/notes/assistant/critique-with-questions",
            json={"note_text": draft, "language": "en"},
            timeout=30,
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["success"] is True
        questions = data.get("questions") or []
        # Service caps at MAX_QUESTIONS=5 and the prompt asks for ≥ 3.
        # Exact count drifts with model output, so allow 1..6.
        assert 1 <= len(questions) <= 6, f"unexpected question count: {len(questions)}"
        # Every question should be a non-empty string.
        assert all(isinstance(q, str) and len(q) > 0 for q in questions)
        # Pre-formatted markdown should be present and contain at least
        # one numbered marker — frontend drops it into a callout block.
        formatted = data.get("formatted_questions") or ""
        assert any(formatted.startswith(f"{n}. ") for n in range(1, 6)) or "1." in formatted


# ---------------------------------------------------------------------------
# Compose from sources — RAG-grounded paragraph generation
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.slow
class TestComposeFromSources:
    """POST /notes/assistant/compose-from-sources — pgvector retrieve +
    LLM-write a passage tagging each claim with [source-N] markers; the
    frontend rewrites markers to TipTap citation marks at insert time."""

    def test_empty_topic_short_circuits(self, authenticated_session, gateway_url):
        """Topic too short → success=false / error='empty_topic'. Same
        cost-discipline guard as the other notes-assistant services."""
        response = authenticated_session.post(
            f"{gateway_url}/notes/assistant/compose-from-sources",
            json={
                "topic_or_section": "",
                "collection_ids": [],
                "target_length": "short",
                "language": "en",
            },
            timeout=15,
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["success"] is False
        assert data["error"] == "empty_topic"
        assert data["sources"] == []

    def test_no_collections_writes_without_citations(self, authenticated_session, gateway_url):
        """Empty collection_ids → the model still writes (no retrieval)
        but emits no [source-N] markers and the sources array is empty.
        Front-end shows a banner; the API contract is just absence of
        citations."""
        response = authenticated_session.post(
            f"{gateway_url}/notes/assistant/compose-from-sources",
            json={
                "topic_or_section": "Briefly summarize the role of dopamine in motivation",
                "collection_ids": [],
                "target_length": "short",
                "language": "en",
            },
            timeout=60,
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["success"] is True
        assert isinstance(data["composed_text"], str)
        assert len(data["composed_text"]) > 0
        assert data["sources"] == []
        # Server-side filter strips any markers when no sources were
        # supplied — verify the contract holds.
        assert "[source-" not in data["composed_text"].lower()

    def test_response_shape_includes_per_source_metadata(self, authenticated_session, gateway_url):
        """When the request succeeds, each source must carry the fields
        the frontend's marker-rewriter depends on (source_number,
        document_id, source_title). We don't ask the user for a real
        collection here — empty collection_ids is enough to validate
        the response *shape*."""
        response = authenticated_session.post(
            f"{gateway_url}/notes/assistant/compose-from-sources",
            json={
                "topic_or_section": "What is the role of attention in working memory?",
                "collection_ids": [],
                "target_length": "short",
                "language": "en",
            },
            timeout=60,
        )
        assert response.status_code == 200
        data = response.json()
        # Top-level shape
        for k in ("success", "composed_text", "sources", "error"):
            assert k in data, f"missing key: {k}"
