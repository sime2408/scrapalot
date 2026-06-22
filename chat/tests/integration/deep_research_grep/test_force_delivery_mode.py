"""
Integration tests for the Phase 3 file-mode → deep-research integration.

Two surfaces under test:

1. ``RAGToolDependencies.force_delivery_mode`` — generic per-agent-class
   override. When set on deps, ``grep_search`` ignores the LLM's parameter
   and forces the deps-supplied delivery mode. This is the knob the
   deep-research orchestrator uses to keep synthesis context lean.

2. ``DeepResearchOrchestrator._grep_local_docs_to_artifact`` — the
   orchestrator-side helper that runs a literal-token grep pass over
   ``documents.content`` and stashes the hit set in the session-scoped
   ArtifactStore.

Run inside scrapalot-chat container:

    docker exec scrapalot-chat python -m pytest \\
        tests/integration/deep_research_grep/test_force_delivery_mode.py -v
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from src.main.service.agents.tools.artifact_store import ArtifactStore
from src.main.service.agents.tools.base import RAGToolDependencies
from src.main.service.streaming.packet_emitter import PacketEmitter

_DOC_BODY = """\
# Test Doc for Force Mode

The literal token DEEPRESEARCH_TOKEN_42 appears here.
And again: DEEPRESEARCH_TOKEN_42 right at the start of the second sentence.
Some filler about commit 7f3a9c1 for good measure.
"""


@pytest.fixture(scope="function")
def seeded_collection(py_cursor):
    collection_id = uuid4()
    doc_id = uuid4()
    chunk_id = uuid4()
    py_cursor.connection.autocommit = False
    try:
        py_cursor.execute(
            "INSERT INTO langchain_pg_collection (uuid, name) VALUES (%s, %s) ON CONFLICT (uuid) DO NOTHING",
            (str(collection_id), f"force_mode_test_{collection_id}"),
        )
        py_cursor.execute(
            """
            INSERT INTO documents (
                id, collection_id, title, filename, file_path, content,
                processing_status, processing_progress, deleted_at, file_stored
            )
            VALUES (
                %s, %s, 'Force-mode Test Doc', 'force.md',
                '/tmp/force_mode/test.md', %s,
                'completed', 1.0, NULL, true
            )
            """,
            (str(doc_id), str(collection_id), _DOC_BODY),
        )
        py_cursor.execute(
            "INSERT INTO langchain_pg_embedding (id, collection_id, document, cmetadata) VALUES (%s, %s, %s, %s::jsonb)",
            (
                str(chunk_id),
                str(collection_id),
                _DOC_BODY,
                json.dumps({"document_id": str(doc_id), "chunk_index": 0}),
            ),
        )
        py_cursor.connection.commit()
        yield {
            "collection_id": collection_id,
            "doc_id": doc_id,
        }
    finally:
        with contextlib.suppress(Exception):
            py_cursor.connection.rollback()
        py_cursor.execute(
            "DELETE FROM langchain_pg_embedding WHERE collection_id = %s",
            (str(collection_id),),
        )
        py_cursor.execute("DELETE FROM documents WHERE id = %s", (str(doc_id),))
        py_cursor.execute(
            "DELETE FROM langchain_pg_collection WHERE uuid = %s",
            (str(collection_id),),
        )
        py_cursor.connection.commit()


@pytest.fixture(autouse=True)
def fresh_store():
    """Drop the singleton between tests so artifact ids don't leak."""
    ArtifactStore.reset_for_tests()
    yield
    ArtifactStore.reset_for_tests()


def _ctx_for(deps):
    return SimpleNamespace(deps=deps)


# =============================================================================
# force_delivery_mode override on grep_search
# =============================================================================


@pytest.mark.integration
def test_force_file_mode_overrides_inline(seeded_collection):
    """LLM passes ``delivery_mode="inline"`` but deps forces ``"file"`` — the
    forced mode wins. Result is a pointer string + a tool_artifact packet."""
    from src.main.service.agents.tools.grep_tools import grep_search

    emitter = PacketEmitter(buffer_mode=True)
    deps = RAGToolDependencies(
        retriever=None,
        llm=None,
        collection_ids=[seeded_collection["collection_id"]],
        document_ids=[seeded_collection["doc_id"]],
        user_id="test-force-user",
        emitter=emitter,
        session_id="test-force-session",
        force_delivery_mode="file",
    )
    result = asyncio.run(
        grep_search(
            _ctx_for(deps),
            pattern=r"DEEPRESEARCH_TOKEN_\d+",
            delivery_mode="inline",  # LLM said inline; deps overrides
        )
    )
    assert isinstance(result, str), "force_delivery_mode='file' should yield pointer string"
    assert "artifact:" in result

    artifact_packets = [json.loads(line)["obj"] for line in (emitter.buffer or []) if json.loads(line)["obj"].get("type") == "tool_artifact"]
    assert len(artifact_packets) == 1


@pytest.mark.integration
def test_force_inline_mode_overrides_file(seeded_collection):
    """Reverse direction: LLM tries file, deps forces inline."""
    from src.main.service.agents.tools.grep_tools import grep_search

    emitter = PacketEmitter(buffer_mode=True)
    deps = RAGToolDependencies(
        retriever=None,
        llm=None,
        collection_ids=[seeded_collection["collection_id"]],
        document_ids=[seeded_collection["doc_id"]],
        user_id="test-force-user",
        emitter=emitter,
        session_id="test-force-session",
        force_delivery_mode="inline",
    )
    result = asyncio.run(
        grep_search(
            _ctx_for(deps),
            pattern=r"DEEPRESEARCH_TOKEN_\d+",
            delivery_mode="file",  # LLM said file; deps overrides
        )
    )
    # Inline mode = RetrievalResult, not a string
    assert hasattr(result, "documents")
    assert result.count == 2
    # No tool_artifact packet emitted
    artifact_packets = [json.loads(line)["obj"] for line in (emitter.buffer or []) if json.loads(line)["obj"].get("type") == "tool_artifact"]
    assert artifact_packets == []


@pytest.mark.integration
def test_no_force_lets_llm_choose(seeded_collection):
    """Default behaviour preserved: with force_delivery_mode=None, the LLM's
    parameter is honoured."""
    from src.main.service.agents.tools.grep_tools import grep_search

    emitter = PacketEmitter(buffer_mode=True)
    deps = RAGToolDependencies(
        retriever=None,
        llm=None,
        collection_ids=[seeded_collection["collection_id"]],
        document_ids=[seeded_collection["doc_id"]],
        user_id="test-force-user",
        emitter=emitter,
        session_id="test-force-session",
        # force_delivery_mode unset (default None)
    )
    result = asyncio.run(
        grep_search(
            _ctx_for(deps),
            pattern=r"DEEPRESEARCH_TOKEN_\d+",
            delivery_mode="file",
        )
    )
    assert isinstance(result, str)
    assert "artifact:" in result


# =============================================================================
# DeepResearchOrchestrator._grep_local_docs_to_artifact
# =============================================================================


@pytest.mark.integration
def test_orchestrator_helper_round_trips_through_artifact_store(seeded_collection):
    """Stand-in orchestrator that exposes only the fields the helper reads,
    so we can exercise the helper without spinning up the full deep-research
    pipeline (LLM / db / retriever_manager / etc.)."""
    from src.main.config.database import SessionLocal
    from src.main.service.agents.tools.artifact_store import ArtifactStore as _Store
    from src.main.service.deep_research.deep_research_orchestrator import (
        DeepResearchOrchestrator,
    )

    db = SessionLocal()
    try:
        emitter = PacketEmitter(buffer_mode=True)
        orch = DeepResearchOrchestrator.__new__(DeepResearchOrchestrator)
        orch.db = db
        orch.session_id = uuid4()
        orch.packet_emitter = emitter
        orch._collected_artifacts = []

        result = asyncio.run(
            orch._grep_local_docs_to_artifact(
                query="What does the doc say about DEEPRESEARCH_TOKEN_42?",
                collection_ids=[seeded_collection["collection_id"]],
            )
        )
        assert result is not None
        artifact_id, summary = result
        assert artifact_id
        assert "grep hits" in summary
        # Round-trip the artifact through the orchestrator's collected list.
        assert orch._collected_artifacts and orch._collected_artifacts[0]["artifact_id"] == artifact_id

        # The payload landed in the session-scoped store.
        store = _Store.get_instance()
        entry = store.get(str(orch.session_id), artifact_id)
        assert entry is not None
        payload = json.loads(entry.payload)
        assert payload["pattern"]
        assert len(payload["chunks"]) >= 1

        # The orchestrator emitted exactly one tool_artifact packet.
        artifact_packets = [json.loads(line)["obj"] for line in (emitter.buffer or []) if json.loads(line)["obj"].get("type") == "tool_artifact"]
        assert len(artifact_packets) == 1
        assert artifact_packets[0]["tool_name"] == "grep_search"
    finally:
        db.close()


@pytest.mark.integration
def test_orchestrator_helper_returns_none_for_synthesis_query():
    """Pure synthesis questions extract no distinctive token → helper bails
    early without touching the store."""
    from src.main.config.database import SessionLocal
    from src.main.service.deep_research.deep_research_orchestrator import (
        DeepResearchOrchestrator,
    )

    db = SessionLocal()
    try:
        emitter = PacketEmitter(buffer_mode=True)
        orch = DeepResearchOrchestrator.__new__(DeepResearchOrchestrator)
        orch.db = db
        orch.session_id = uuid4()
        orch.packet_emitter = emitter
        orch._collected_artifacts = []

        result = asyncio.run(
            orch._grep_local_docs_to_artifact(
                query="tell me about consciousness",
                collection_ids=[uuid4()],
            )
        )
        assert result is None
        # No packet either — the helper short-circuited before stashing.
        artifact_packets = [json.loads(line)["obj"] for line in (emitter.buffer or []) if json.loads(line)["obj"].get("type") == "tool_artifact"]
        assert artifact_packets == []
    finally:
        db.close()
