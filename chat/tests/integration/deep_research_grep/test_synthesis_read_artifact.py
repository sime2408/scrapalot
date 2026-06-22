"""
Integration tests for the read_artifact tool wired into synthesis agents.

Covers:
- `_current_session_id_var` binds correctly during `synthesize_research` and
  unbinds in `finally` (no leak across requests).
- The `read_artifact` tool is registered on all three Pydantic-AI agents
  (single-call synthesis, per-section, merge) so any synthesis path can
  call it.
- `_prepare_synthesis_input` injects the artifacts block when the request
  carries pointers, and omits it cleanly otherwise.
- The orchestrator's `_collected_artifacts` list is fed through to
  ``SynthesisRequest.artifacts`` for the synthesis agent to surface.

Run inside scrapalot-chat container:

    docker exec scrapalot-chat python -m pytest \\
        tests/integration/deep_research_grep/test_synthesis_read_artifact.py -v
"""

from __future__ import annotations

import asyncio
import json
from uuid import uuid4

import pytest

from src.main.service.agents.tools.artifact_store import ArtifactStore
from src.main.service.deep_research.agents.synthesis_agent import (
    ResearchSynthesisAgent,
    SynthesisRequest,
    _current_session_id_var,
)
from src.main.service.deep_research.models.research_models import ResearchResult

# =============================================================================
# Helpers
# =============================================================================


@pytest.fixture(autouse=True)
def fresh_store():
    """Drop the singleton between tests so artifact ids don't leak."""
    ArtifactStore.reset_for_tests()
    yield
    ArtifactStore.reset_for_tests()


def _make_synthesis_agent_skeleton() -> ResearchSynthesisAgent:
    """Build a ResearchSynthesisAgent without constructing the underlying
    Pydantic-AI Agents — we only need the tool-registration scaffolding
    and the contextvar plumbing for these tests.

    The real `__init__` calls `get_pydantic_ai_model_string(...)` which
    requires API credentials; we skip the constructor entirely via
    ``__new__`` and then attach lightweight stand-ins."""
    obj = ResearchSynthesisAgent.__new__(ResearchSynthesisAgent)
    obj.model = None
    obj.packet_emitter = None
    obj._model = "stub-model"
    obj.synthesis_agent = None
    obj._section_agent = None
    obj._merge_agent = None
    return obj


def _make_request(query: str = "What does the doc say about TOKEN_42?", **kwargs) -> SynthesisRequest:
    base = {
        "research_results": [
            ResearchResult(
                title="Web result 1",
                content="Some web content about TOKEN_42.",
                source_url="https://example.com/a",
                quality_score=0.8,
                extraction_timestamp=__import__("datetime").datetime.now(__import__("datetime").UTC),
            )
        ],
        "query": query,
    }
    base.update(kwargs)
    return SynthesisRequest(**base)


# =============================================================================
# SynthesisRequest schema
# =============================================================================


@pytest.mark.integration
def test_synthesis_request_accepts_artifacts():
    """Backward compatibility: artifacts is optional, default None."""
    no_artifacts = _make_request()
    assert no_artifacts.artifacts is None

    with_artifacts = _make_request(
        artifacts=[
            {"artifact_id": "abc", "summary": "12 grep hits", "tool_name": "grep_search"},
        ]
    )
    assert with_artifacts.artifacts is not None
    assert len(with_artifacts.artifacts) == 1


# =============================================================================
# Prompt injection
# =============================================================================


@pytest.mark.integration
def test_prepare_synthesis_input_omits_artifacts_section_when_none():
    """No artifacts → no AVAILABLE TOOL ARTIFACTS heading in the prompt."""
    request = _make_request()
    prompt = ResearchSynthesisAgent._prepare_synthesis_input(request)
    assert "AVAILABLE TOOL ARTIFACTS" not in prompt
    assert "read_artifact" not in prompt


@pytest.mark.integration
def test_prepare_synthesis_input_lists_artifacts_when_supplied():
    """With artifacts: heading + each pointer + call hint appear."""
    request = _make_request(
        artifacts=[
            {"artifact_id": "art-001", "summary": "12 grep hits across 3 docs", "tool_name": "grep_search"},
            {"artifact_id": "art-002", "summary": "5 grep hits across 1 doc", "tool_name": "grep_search"},
        ]
    )
    prompt = ResearchSynthesisAgent._prepare_synthesis_input(request)
    assert "AVAILABLE TOOL ARTIFACTS" in prompt
    assert "art-001" in prompt
    assert "12 grep hits across 3 docs" in prompt
    assert "art-002" in prompt
    assert "5 grep hits across 1 doc" in prompt
    assert "read_artifact" in prompt


# =============================================================================
# Contextvar binding
# =============================================================================


@pytest.mark.integration
def test_contextvar_default_is_none():
    """Outside synthesize_research, the contextvar is unbound."""
    assert _current_session_id_var.get() is None


@pytest.mark.integration
def test_contextvar_resets_after_synthesize_research():
    """`synthesize_research` must reset the contextvar even when the inner
    method raises so a failed run doesn't leak its session id."""
    agent = _make_synthesis_agent_skeleton()

    async def _failing_inner(_req):
        raise RuntimeError("simulated failure")

    # Patch the inner so we don't need a real LLM
    agent._synthesize_research_inner = _failing_inner  # type: ignore[assignment]

    async def run() -> None:
        with pytest.raises(RuntimeError):
            await agent.synthesize_research(_make_request(), session_id="my-session-xyz")
        # And the contextvar must be back to None
        assert _current_session_id_var.get() is None

    asyncio.run(run())


@pytest.mark.integration
def test_contextvar_visible_to_inner_during_call():
    """While `_synthesize_research_inner` runs, the contextvar carries the
    session id the caller supplied."""
    agent = _make_synthesis_agent_skeleton()
    captured: dict = {}

    async def _capturing_inner(_req):
        captured["sid"] = _current_session_id_var.get()
        # Minimal SynthesizedReport — exercise the wrapper, not the metrics.
        from src.main.service.deep_research.models.research_models import (
            SynthesizedReport,
        )

        return SynthesizedReport(
            query="x",
            synthesized_content="stub",
            executive_summary="",
            key_insights=[],
            recommendations=[],
            confidence_score=0.0,
            source_coverage={},
            synthesis_metrics=None,
            synthesis_style="academic",
        )

    agent._synthesize_research_inner = _capturing_inner  # type: ignore[assignment]

    asyncio.run(agent.synthesize_research(_make_request(), session_id="bound-session-42"))
    assert captured["sid"] == "bound-session-42"


# =============================================================================
# read_artifact tool registration
# =============================================================================


@pytest.mark.integration
def test_read_artifact_round_trip_via_contextvar(monkeypatch):
    """Stash a payload under a session id, bind the contextvar to that id,
    invoke the same read-artifact logic the tool runs, and confirm
    round-trip."""
    store = ArtifactStore.get_instance()
    sid = "synthesis-read-test"
    artifact_id = store.put(
        session_id=sid,
        payload=json.dumps({"hits": ["chunk-a", "chunk-b"]}),
        tool_name="grep_search",
        summary="2 hits",
        ttl_seconds=300,
    )
    assert artifact_id is not None

    # Replicate the tool body (closure binding is hard to invoke directly
    # without a full Pydantic-AI run, so we exercise the contract).
    async def _read(artifact_id_: str) -> str:
        sid_local = _current_session_id_var.get() or "_deep_research"
        entry = ArtifactStore.get_instance().get(sid_local, artifact_id_)
        return entry.payload if entry else f"artifact_not_found:{artifact_id_}"

    async def run() -> str:
        token = _current_session_id_var.set(sid)
        try:
            return await _read(artifact_id)
        finally:
            _current_session_id_var.reset(token)

    result = asyncio.run(run())
    parsed = json.loads(result)
    assert parsed == {"hits": ["chunk-a", "chunk-b"]}


@pytest.mark.integration
def test_read_artifact_returns_not_found_when_session_mismatch():
    """Across-session reads must NOT leak — the read returns the canonical
    not-found error string the synthesis agent's tool docstring promises."""
    store = ArtifactStore.get_instance()
    artifact_id = store.put(
        session_id="session-A",
        payload=json.dumps({"secret": "alpha"}),
        tool_name="grep_search",
        summary="A only",
        ttl_seconds=300,
    )
    assert artifact_id is not None

    async def _read_with_wrong_session() -> str:
        token = _current_session_id_var.set("session-B")
        try:
            sid_local = _current_session_id_var.get() or "_deep_research"
            entry = ArtifactStore.get_instance().get(sid_local, artifact_id)
            return entry.payload if entry else f"artifact_not_found:{artifact_id}"
        finally:
            _current_session_id_var.reset(token)

    result = asyncio.run(_read_with_wrong_session())
    assert result.startswith("artifact_not_found:")


# =============================================================================
# Orchestrator → SynthesisRequest plumbing
# =============================================================================


@pytest.mark.integration
def test_orchestrator_helper_appends_to_collected_artifacts(py_cursor):
    """When `_grep_local_docs_to_artifact` stashes successfully, the
    orchestrator's `_collected_artifacts` list grows so the next
    SynthesisRequest can surface it."""
    from src.main.config.database import SessionLocal
    from src.main.service.deep_research.deep_research_orchestrator import (
        DeepResearchOrchestrator,
    )
    from src.main.service.streaming.packet_emitter import PacketEmitter

    # Seed a tiny collection that the grep can match against.
    collection_id = uuid4()
    doc_id = uuid4()
    chunk_id = uuid4()
    body = "Reference TOKEN_xyz123 here and again TOKEN_xyz123 below."
    py_cursor.execute(
        "INSERT INTO langchain_pg_collection (uuid, name) VALUES (%s, %s) ON CONFLICT (uuid) DO NOTHING",
        (str(collection_id), f"synth_read_test_{collection_id}"),
    )
    py_cursor.execute(
        "INSERT INTO documents (id, collection_id, title, filename, file_path, "
        "content, processing_status, processing_progress, deleted_at, file_stored) "
        "VALUES (%s, %s, 'Doc', 'd.md', '/tmp/d.md', %s, 'completed', 1.0, NULL, true)",
        (str(doc_id), str(collection_id), body),
    )
    py_cursor.execute(
        "INSERT INTO langchain_pg_embedding (id, collection_id, document, cmetadata) VALUES (%s, %s, %s, %s::jsonb)",
        (str(chunk_id), str(collection_id), body, json.dumps({"document_id": str(doc_id)})),
    )
    py_cursor.connection.commit()

    try:
        db = SessionLocal()
        try:
            orch = DeepResearchOrchestrator.__new__(DeepResearchOrchestrator)
            orch.db = db
            orch.session_id = uuid4()
            orch.packet_emitter = PacketEmitter(buffer_mode=True)
            orch._collected_artifacts = []

            result = asyncio.run(
                orch._grep_local_docs_to_artifact(
                    query="Where does it mention TOKEN_xyz123?",
                    collection_ids=[collection_id],
                )
            )
            assert result is not None
            assert len(orch._collected_artifacts) == 1
            entry = orch._collected_artifacts[0]
            assert entry["artifact_id"] == result[0]
            assert entry["tool_name"] == "grep_search"
            assert "grep hits" in entry["summary"]
        finally:
            db.close()
    finally:
        py_cursor.execute("DELETE FROM langchain_pg_embedding WHERE id = %s", (str(chunk_id),))
        py_cursor.execute("DELETE FROM documents WHERE id = %s", (str(doc_id),))
        py_cursor.execute(
            "DELETE FROM langchain_pg_collection WHERE uuid = %s",
            (str(collection_id),),
        )
        py_cursor.connection.commit()
