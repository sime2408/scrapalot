"""
Integration tests for Phase 3 file-artifact tool delivery.

Covers:
- Inline mode is unchanged (backwards compat)
- File mode stashes the payload + emits a `tool_artifact` packet
- `read_artifact` round-trips the JSON
- Artifacts expire after TTL (clock-injected, no real sleeping)
- Oversize payloads silently fall back to inline + emit a debug status

Run inside scrapalot-chat container:

    docker exec scrapalot-chat python -m pytest \\
        tests/integration/agents/test_artifact_delivery.py -v
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

# =============================================================================
# Fixtures — same seed pattern as the Phase 1 test suite
# =============================================================================


_KNOWN_CONTENT = """\
# Phase 3 Test Doc

The literal token ARTIFACT_TOKEN_42 appears here.
And again: ARTIFACT_TOKEN_42 in the second sentence.
"""


@pytest.fixture(scope="function")
def seeded_collection(py_cursor) -> dict:
    """Insert one collection + one document with the canonical marker."""
    collection_id = uuid4()
    doc_id = uuid4()
    py_cursor.connection.autocommit = False
    try:
        py_cursor.execute(
            """
            INSERT INTO langchain_pg_collection (uuid, name)
            VALUES (%s, %s) ON CONFLICT (uuid) DO NOTHING
            """,
            (str(collection_id), f"artifact_test_{collection_id}"),
        )
        py_cursor.execute(
            """
            INSERT INTO documents (
                id, collection_id, title, filename, file_path, content,
                processing_status, processing_progress, deleted_at, file_stored
            )
            VALUES (
                %s, %s, 'Artifact Test Doc', 'artifact.md',
                '/tmp/artifact.md', %s,
                'completed', 1.0, NULL, true
            )
            """,
            (str(doc_id), str(collection_id), _KNOWN_CONTENT),
        )
        py_cursor.connection.commit()
        yield {"collection_id": collection_id, "doc_id": doc_id}
    finally:
        with contextlib.suppress(Exception):
            py_cursor.connection.rollback()
        py_cursor.execute("DELETE FROM documents WHERE id = %s", (str(doc_id),))
        py_cursor.execute(
            "DELETE FROM langchain_pg_collection WHERE uuid = %s",
            (str(collection_id),),
        )
        py_cursor.connection.commit()


@pytest.fixture(scope="function")
def fresh_store():
    """Replace the singleton with a fresh store per test so artifacts from
    other tests don't leak. Returns the store so individual tests can
    install a controllable clock."""
    ArtifactStore.reset_for_tests()
    yield ArtifactStore.get_instance()
    ArtifactStore.reset_for_tests()


def _build_deps(
    *,
    collection_id,
    doc_id,
    session_id="test-session-1",
    emitter=None,
) -> RAGToolDependencies:
    return RAGToolDependencies(
        retriever=None,
        llm=None,
        collection_ids=[collection_id],
        document_ids=[doc_id],
        user_id="test-artifact-user",
        emitter=emitter or PacketEmitter(buffer_mode=True),
        session_id=session_id,
    )


def _ctx_for(deps):
    return SimpleNamespace(deps=deps)


# =============================================================================
# Test 1 — inline mode unchanged
# =============================================================================


@pytest.mark.integration
def test_inline_mode_unchanged(seeded_collection, fresh_store):
    """Default `grep_search` call returns hits inline; no tool_artifact packet."""
    from src.main.service.agents.tools.grep_tools import grep_search

    emitter = PacketEmitter(buffer_mode=True)
    deps = _build_deps(
        collection_id=seeded_collection["collection_id"],
        doc_id=seeded_collection["doc_id"],
        emitter=emitter,
    )
    result = asyncio.run(grep_search(_ctx_for(deps), pattern=r"ARTIFACT_TOKEN_\d+"))

    # Hits arrived inline as a RetrievalResult.
    assert hasattr(result, "documents")
    assert result.count == 2
    # No artifact stored.
    stats = fresh_store.session_stats("test-session-1")
    assert stats["count"] == 0
    # No tool_artifact packet in the buffered stream.
    buffered = emitter.buffer or []
    parsed = [json.loads(line) for line in buffered]
    assert all(p.get("obj", {}).get("type") != "tool_artifact" for p in parsed)


# =============================================================================
# Test 2 — file mode emits artifact packet
# =============================================================================


@pytest.mark.integration
def test_file_mode_emits_artifact(seeded_collection, fresh_store):
    """`delivery_mode="file"` emits one tool_artifact packet and returns a stub."""
    from src.main.service.agents.tools.grep_tools import grep_search

    emitter = PacketEmitter(buffer_mode=True)
    deps = _build_deps(
        collection_id=seeded_collection["collection_id"],
        doc_id=seeded_collection["doc_id"],
        emitter=emitter,
    )
    result = asyncio.run(
        grep_search(
            _ctx_for(deps),
            pattern=r"ARTIFACT_TOKEN_\d+",
            delivery_mode="file",
        )
    )

    # Return value is a stub string the LLM can act on.
    assert isinstance(result, str)
    assert "artifact:" in result
    assert "read_artifact" in result

    # One tool_artifact packet in the stream, with the right shape.
    artifact_packets = [json.loads(line)["obj"] for line in (emitter.buffer or []) if json.loads(line)["obj"].get("type") == "tool_artifact"]
    assert len(artifact_packets) == 1
    pkt = artifact_packets[0]
    assert pkt["tool_name"] == "grep_search"
    assert "2 matches" in pkt["summary"]
    assert pkt["size_bytes"] > 0
    assert pkt["artifact_id"]

    # And the payload landed in the store under the session.
    stats = fresh_store.session_stats("test-session-1")
    assert stats["count"] == 1


# =============================================================================
# Test 3 — read_artifact round-trip
# =============================================================================


@pytest.mark.integration
def test_read_artifact_returns_json(seeded_collection, fresh_store):
    """`read_artifact(artifact_id)` returns the stored JSON payload."""
    from src.main.service.agents.tools.grep_tools import grep_search, read_artifact

    emitter = PacketEmitter(buffer_mode=True)
    deps = _build_deps(
        collection_id=seeded_collection["collection_id"],
        doc_id=seeded_collection["doc_id"],
        emitter=emitter,
    )
    asyncio.run(
        grep_search(
            _ctx_for(deps),
            pattern=r"ARTIFACT_TOKEN_\d+",
            delivery_mode="file",
        )
    )
    pkt = next(json.loads(line)["obj"] for line in (emitter.buffer or []) if json.loads(line)["obj"].get("type") == "tool_artifact")

    payload = asyncio.run(read_artifact(_ctx_for(deps), artifact_id=pkt["artifact_id"]))
    parsed = json.loads(payload)
    assert "hits" in parsed
    assert len(parsed["hits"]) == 2
    assert parsed["metadata"]["match_count"] == 2


# =============================================================================
# Test 4 — TTL expires (no real sleeping)
# =============================================================================


@pytest.mark.integration
def test_artifact_ttl_expires(fresh_store):
    """After the clock advances past expires_at the artifact is unfetchable."""
    from src.main.service.agents.tools.grep_tools import read_artifact

    # Install a controllable clock on the singleton.
    fake_time = {"t": 1000.0}
    fresh_store._now = lambda: fake_time["t"]

    artifact_id = fresh_store.put(
        session_id="ttl-session",
        payload=json.dumps({"hello": "world"}),
        tool_name="grep_search",
        summary="1 dummy match",
        ttl_seconds=10,
    )
    assert artifact_id is not None

    deps = RAGToolDependencies(retriever=None, llm=None, user_id="x", session_id="ttl-session")
    ctx = _ctx_for(deps)

    # Within TTL — round-trip works.
    inside = asyncio.run(read_artifact(ctx, artifact_id=artifact_id))
    assert json.loads(inside) == {"hello": "world"}

    # Advance past expires_at — read returns the recoverable error string.
    fake_time["t"] += 20
    expired = asyncio.run(read_artifact(ctx, artifact_id=artifact_id))
    assert expired.startswith("artifact_not_found:")
    assert artifact_id in expired


# =============================================================================
# Test 5 — oversize rejected, falls back to inline
# =============================================================================


@pytest.mark.integration
def test_artifact_oversize_rejected(seeded_collection):
    """A payload over the configured byte cap falls back to inline + status."""
    from src.main.service.agents.tools.grep_tools import grep_search

    # Force a tiny cap so even a 2-match payload tips it over.
    ArtifactStore.reset_for_tests()
    cap = 64  # well below the ~700-byte serialised payload
    ArtifactStore._instance = ArtifactStore(max_bytes=cap)

    emitter = PacketEmitter(buffer_mode=True)
    deps = _build_deps(
        collection_id=seeded_collection["collection_id"],
        doc_id=seeded_collection["doc_id"],
        emitter=emitter,
    )
    try:
        result = asyncio.run(
            grep_search(
                _ctx_for(deps),
                pattern=r"ARTIFACT_TOKEN_\d+",
                delivery_mode="file",
            )
        )

        # Inline fallback: returned a RetrievalResult, not a stub string.
        assert hasattr(result, "documents")
        assert result.count == 2
        assert result.metadata.get("artifact_fallback") == "oversize"

        # No tool_artifact packet; a status packet flagged the fallback.
        parsed = [json.loads(line)["obj"] for line in (emitter.buffer or [])]
        assert all(p.get("type") != "tool_artifact" for p in parsed)
        assert any(p.get("type") == "status" and "artifact_too_large_inline_fallback" in (p.get("content") or "") for p in parsed)
    finally:
        ArtifactStore.reset_for_tests()


# =============================================================================
# Test 6 — read_artifact paging
# =============================================================================


@pytest.mark.integration
def test_read_artifact_supports_paging(fresh_store):
    """char_start / char_end slice the payload — useful for huge artifacts."""
    from src.main.service.agents.tools.grep_tools import read_artifact

    raw = json.dumps({"data": "A" * 1000})
    artifact_id = fresh_store.put(
        session_id="page-session",
        payload=raw,
        tool_name="grep_search",
        summary="paging test",
        ttl_seconds=300,
    )
    assert artifact_id is not None

    deps = RAGToolDependencies(retriever=None, llm=None, user_id="x", session_id="page-session")
    ctx = _ctx_for(deps)

    head = asyncio.run(read_artifact(ctx, artifact_id=artifact_id, char_end=10))
    assert head == raw[:10]

    mid = asyncio.run(read_artifact(ctx, artifact_id=artifact_id, char_start=10, char_end=20))
    assert mid == raw[10:20]


# =============================================================================
# Test 7 — read_artifact across sessions is isolated
# =============================================================================


@pytest.mark.integration
def test_read_artifact_session_isolation(fresh_store):
    """Session A cannot read Session B's artifacts."""
    from src.main.service.agents.tools.grep_tools import read_artifact

    artifact_id = fresh_store.put(
        session_id="session-A",
        payload=json.dumps({"secret": "alpha"}),
        tool_name="grep_search",
        summary="session-A only",
        ttl_seconds=300,
    )
    assert artifact_id is not None

    deps_b = RAGToolDependencies(retriever=None, llm=None, user_id="x", session_id="session-B")
    result = asyncio.run(read_artifact(_ctx_for(deps_b), artifact_id=artifact_id))
    assert result.startswith("artifact_not_found:")
