"""
Integration Tests for Chat Controller - Deep Research

Endpoint: POST /v1/chat/completions with scrapalot.mode = "deep_research".
Tests the v1 deep research flow which gates synthesis behind a plan
preview — the first call returns a `plan_preview` packet; the caller
must then resubmit with `approved_plan_id` to drive the synthesis phase.
Verifies research_plans table is populated after the planning phase.

Requires: test_document fixture (art_of_war.pdf uploaded and processed).
"""

import pytest

from tests.conftest import get_accumulated_content, get_packets_by_type, parse_ndjson
from tests.integration.chat_client import chat_post


def _post_research(authenticated_session, api_base_url, prompt, **extras):
    """POST a deep-research chat through the OpenAI-compat shim."""
    return chat_post(
        authenticated_session,
        api_base_url,
        prompt=prompt,
        deep_research_enabled=True,
        research_breadth=extras.pop("research_breadth", 2),
        research_depth=extras.pop("research_depth", 1),
        timeout=300,
        **extras,
    )


@pytest.mark.integration
@pytest.mark.slow
class TestChatDeepResearch:
    """Integration tests for the deep research v1 plan-preview flow."""

    def test_deep_research_emits_plan_preview(self, authenticated_session, api_base_url, test_collection, test_document):
        """Phase-1 call must end with a plan_preview packet carrying a plan id
        and structured sections. The orchestrator stops here until the user
        resubmits with approved_plan_id (covered by test_deep_research_synthesis_after_approval)."""
        response = _post_research(
            authenticated_session,
            api_base_url,
            "Research the key themes of the Art of War and provide a comprehensive analysis",
            collection_ids=[str(test_collection["id"])],
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text[:200]}"

        packets = parse_ndjson(response.text)
        previews = get_packets_by_type(packets, "plan_preview")
        assert previews, f"Expected one plan_preview packet, got types: {sorted({p['obj'].get('type') for p in packets})}"

        plan = previews[-1]["obj"]
        assert plan.get("plan_id"), f"plan_preview missing plan_id: {plan}"
        sections = plan.get("sections") or []
        assert len(sections) >= 2, f"Plan must include >=2 sections, got: {sections}"
        for sec in sections:
            assert sec.get("title"), f"Section missing title: {sec}"

    def test_deep_research_has_research_packets(self, authenticated_session, api_base_url, test_collection, test_document):
        """Phase-1 stream must include status updates for the planner stages
        and at least one structural packet (plan_preview / planning_progress)."""
        response = _post_research(
            authenticated_session,
            api_base_url,
            "Analyze the structure and key arguments of the Art of War",
            collection_ids=[str(test_collection["id"])],
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"

        packets = parse_ndjson(response.text)
        types_found = {p["obj"].get("type") for p in packets}

        structural_types = {
            "plan_preview",
            "planning_progress",
            "research_plan",
            "research_section",
            "research_start",
            "research_query",
        }
        assert types_found & structural_types, f"Expected one of {structural_types} in stream, got types: {sorted(types_found)}"

    def test_deep_research_planner_runs_without_collections(self, authenticated_session, api_base_url):
        """Deep research must accept an empty collections list and still
        emit a plan_preview (the planner consults web sources by default)."""
        response = _post_research(
            authenticated_session,
            api_base_url,
            "Research the historical origins of arithmetic as a discipline",
            collection_ids=[],
            research_breadth=2,
            research_depth=1,
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text[:200]}"

        packets = parse_ndjson(response.text)
        previews = get_packets_by_type(packets, "plan_preview")
        assert previews, f"Expected plan_preview without collections, got types: {sorted({p['obj'].get('type') for p in packets})}"

    @pytest.mark.xfail(
        reason=(
            "v1 plan-preview design: Phase 1 marks the plan as 'failed' (orphaned) "
            "the moment the stream ends without an in-stream approval, so a fresh "
            "Phase 2 call with approved_plan_id finds a dead row. Real synthesis "
            "happens via the UI's interactive approve-button flow which holds the "
            "stream open. Re-enable once the orchestrator gains an approve API "
            "(separate from the chat stream) or the orphan-on-stream-end behaviour "
            "is loosened to a longer grace window."
        ),
        strict=False,
    )
    def test_deep_research_synthesis_after_approval(self, authenticated_session, api_base_url, test_collection, test_document):
        """End-to-end flow: phase 1 produces a plan, phase 2 resubmits with
        approved_plan_id and must stream message_delta tokens (synthesis)."""
        phase1 = _post_research(
            authenticated_session,
            api_base_url,
            "Summarize the Art of War comprehensively",
            collection_ids=[str(test_collection["id"])],
        )
        assert phase1.status_code == 200, phase1.text[:200]
        previews = get_packets_by_type(parse_ndjson(phase1.text), "plan_preview")
        assert previews, "Phase 1 must end with a plan_preview"
        plan_id = previews[-1]["obj"].get("plan_id")
        assert plan_id, "plan_preview missing plan_id"

        phase2 = _post_research(
            authenticated_session,
            api_base_url,
            "Summarize the Art of War comprehensively",
            collection_ids=[str(test_collection["id"])],
            approved_plan_id=plan_id,
        )
        assert phase2.status_code == 200, phase2.text[:200]
        packets = parse_ndjson(phase2.text)
        content = get_accumulated_content(packets)
        assert len(content) >= 50, (
            f"Phase 2 synthesis content too short ({len(content)} chars): {content[:120]!r}; "
            f"types seen: {sorted({p['obj'].get('type') for p in packets})}"
        )

    def test_deep_research_creates_research_plan(self, authenticated_session, api_base_url, test_collection, test_document, py_cursor):
        """The planning phase persists a row in research_plans with the
        plan_id the client receives in the plan_preview packet. (research_tasks
        rows are created later, during the synthesis phase that follows
        plan approval — see the xfail-marked synthesis test for context.)"""
        response = _post_research(
            authenticated_session,
            api_base_url,
            "Research the principles of warfare in the Art of War",
            collection_ids=[str(test_collection["id"])],
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"

        previews = get_packets_by_type(parse_ndjson(response.text), "plan_preview")
        assert previews, "Plan-preview required to extract plan_id"
        plan_id = previews[-1]["obj"].get("plan_id")
        assert plan_id, "plan_preview missing plan_id"

        py_cursor.execute("SELECT id, status FROM research_plans WHERE id = %s", (plan_id,))
        plan = py_cursor.fetchone()
        assert plan is not None, f"Research plan {plan_id} not found in database after phase 1"
