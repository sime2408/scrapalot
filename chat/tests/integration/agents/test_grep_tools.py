"""
Integration tests for Phase 1 grep agent tools.

These tests cover `src.main.service.agents.tools.grep_tools`:
- `grep_search` over `documents.content`
- `cat_document` ranged reads
- Scope enforcement (collection / document)
- Activation-trigger wiring (registered in the tool-based RAG core toolset)
- Author resolution helper

Run inside the scrapalot-chat container:

    docker exec scrapalot-chat python -m pytest \\
        tests/integration/agents/test_grep_tools.py -v

The tests seed real rows into the live `documents` table using a unique
`collection_id` per test run and clean up in teardown. No mocks for DB, regex,
or the SQL engine — they exercise the real Postgres `~` / `~*` operators that
the tool relies on.
"""

from __future__ import annotations

import asyncio
import contextlib
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from src.main.service.agents.tools.base import (
    RAGToolDependencies,
    ToolExecutionError,
)

# =============================================================================
# Test fixtures — direct DB seed (no upload pipeline)
# =============================================================================


_KNOWN_CONTENT = """\
# Labyrinths

## Chapter 1 — The Garden of Forking Paths

In all fictional works, each time a man is confronted with several
alternatives, he chooses one and eliminates the others; in the fiction
of Ts'ui Pen, he chooses — simultaneously — all of them. He creates,
in this way, diverse futures, diverse times which themselves also
proliferate and fork.

Test marker: TEST_TOKEN_BORGES_42

## Chapter 2 — The Aleph

I shall not attempt to describe the Aleph; here I begin my
inexpressible vista.

Test marker: TEST_TOKEN_BORGES_99
"""


_KNOWN_AUTHOR = "Jorge Luis Borges"


@pytest.fixture(scope="function")
def seeded_collection(py_cursor) -> dict:
    """Insert a fake collection + two documents (one populated, one NULL content)."""
    collection_id = uuid4()
    populated_id = uuid4()
    empty_id = uuid4()
    py_cursor.connection.autocommit = False

    try:
        # langchain_pg_collection — required for the FK on langchain_pg_embedding
        # (only relevant if we touch chunks; safe to insert defensively)
        py_cursor.execute(
            """
            INSERT INTO langchain_pg_collection (uuid, name)
            VALUES (%s, %s)
            ON CONFLICT (uuid) DO NOTHING
            """,
            (str(collection_id), f"grep_test_{collection_id}"),
        )

        py_cursor.execute(
            """
            INSERT INTO documents (
                id, collection_id, title, filename, file_path, content,
                processing_status, processing_progress,
                extracted_metadata, deleted_at, file_stored
            )
            VALUES (
                %s, %s, %s, %s, %s, %s,
                'completed', 1.0,
                %s::jsonb, NULL, true
            )
            """,
            (
                str(populated_id),
                str(collection_id),
                "Labyrinths (test)",
                "labyrinths.md",
                f"/tmp/grep_test/{populated_id}.md",
                _KNOWN_CONTENT,
                f'{{"resolved": {{"authors": "{_KNOWN_AUTHOR}"}}}}',
            ),
        )

        # An unparsed sibling — same collection, content IS NULL.
        py_cursor.execute(
            """
            INSERT INTO documents (
                id, collection_id, title, filename, file_path, content,
                processing_status, processing_progress, deleted_at, file_stored
            )
            VALUES (
                %s, %s, %s, %s, %s, NULL,
                'pending', 0.0, NULL, true
            )
            """,
            (
                str(empty_id),
                str(collection_id),
                "Unparsed sibling",
                "pending.pdf",
                f"/tmp/grep_test/{empty_id}.pdf",
            ),
        )
        py_cursor.connection.commit()

        yield {
            "collection_id": collection_id,
            "populated_id": populated_id,
            "empty_id": empty_id,
        }
    finally:
        with contextlib.suppress(Exception):
            py_cursor.connection.rollback()
        py_cursor.execute("DELETE FROM documents WHERE collection_id = %s", (str(collection_id),))
        py_cursor.execute(
            "DELETE FROM langchain_pg_collection WHERE uuid = %s",
            (str(collection_id),),
        )
        py_cursor.connection.commit()


def _build_deps(
    *,
    user_id: str = "test-grep-user",
    collection_ids: list[UUID] | None = None,
    document_ids: list[UUID] | None = None,
) -> RAGToolDependencies:
    return RAGToolDependencies(
        retriever=None,
        llm=None,
        collection_ids=collection_ids,
        document_ids=document_ids,
        user_id=user_id,
    )


def _ctx_for(deps: RAGToolDependencies) -> SimpleNamespace:
    """Minimal Pydantic-AI RunContext stand-in: only `.deps` is read by the tools."""
    return SimpleNamespace(deps=deps)


# =============================================================================
# grep_search
# =============================================================================


@pytest.mark.integration
def test_grep_search_hits_documents_content(seeded_collection):
    """Match the canonical marker token in a populated documents.content row."""
    from src.main.service.agents.tools.grep_tools import grep_search

    deps = _build_deps(
        collection_ids=[seeded_collection["collection_id"]],
        document_ids=[seeded_collection["populated_id"]],
    )
    ctx = _ctx_for(deps)

    result = asyncio.run(grep_search(ctx, pattern=r"TEST_TOKEN_BORGES_\d+"))

    assert result.count == 2, f"expected 2 hits, got {result.count}"
    for doc in result.documents:
        assert doc.metadata["retriever"] == "grep"
        assert doc.metadata["document_id"] == str(seeded_collection["populated_id"])
        assert doc.metadata["char_offset"] >= 0
        assert "TEST_TOKEN_BORGES" in doc.page_content
    assert result.metadata["search_type"] == "grep"
    assert result.metadata["skipped_null_content"] == 0


@pytest.mark.integration
def test_grep_search_ignores_unparsed_files(seeded_collection):
    """Documents with content IS NULL must be skipped, never crash."""
    from src.main.service.agents.tools.grep_tools import grep_search

    deps = _build_deps(
        collection_ids=[seeded_collection["collection_id"]],
        document_ids=[seeded_collection["empty_id"]],
    )
    ctx = _ctx_for(deps)

    result = asyncio.run(grep_search(ctx, pattern=r"TEST_TOKEN_BORGES_\d+"))

    assert result.count == 0
    # SQL pre-filter rejects NULL content cheaply; the in-loop counter only
    # increments when SELECT returns the row. Both paths are acceptable —
    # what matters is that the tool returned cleanly with metadata explaining
    # the empty result, NOT a stack trace.
    assert result.metadata["match_count"] == 0
    assert result.metadata.get("reason") in {"no_matches", "no_scope_no_hits"}


@pytest.mark.integration
def test_grep_search_respects_user_scope(seeded_collection, py_cursor):
    """A document in a DIFFERENT collection must not appear in scoped results."""
    from src.main.service.agents.tools.grep_tools import grep_search

    # Seed a second collection + doc with the same marker.
    other_collection = uuid4()
    other_doc = uuid4()
    try:
        py_cursor.execute(
            """
            INSERT INTO langchain_pg_collection (uuid, name)
            VALUES (%s, %s) ON CONFLICT (uuid) DO NOTHING
            """,
            (str(other_collection), f"grep_test_other_{other_collection}"),
        )
        py_cursor.execute(
            """
            INSERT INTO documents (
                id, collection_id, title, filename, file_path, content,
                processing_status, processing_progress, deleted_at, file_stored
            )
            VALUES (
                %s, %s, 'other_doc', 'other.md', '/tmp/other.md',
                'TEST_TOKEN_BORGES_77', 'completed', 1.0, NULL, true
            )
            """,
            (str(other_doc), str(other_collection)),
        )
        py_cursor.connection.commit()

        # Scope only to the seeded_collection — `other_doc` must be invisible.
        deps = _build_deps(collection_ids=[seeded_collection["collection_id"]])
        result = asyncio.run(grep_search(_ctx_for(deps), pattern=r"TEST_TOKEN_BORGES_\d+"))

        doc_ids = {d.metadata["document_id"] for d in result.documents}
        assert str(other_doc) not in doc_ids
        assert str(seeded_collection["populated_id"]) in doc_ids
    finally:
        py_cursor.execute("DELETE FROM documents WHERE id = %s", (str(other_doc),))
        py_cursor.execute(
            "DELETE FROM langchain_pg_collection WHERE uuid = %s",
            (str(other_collection),),
        )
        py_cursor.connection.commit()


@pytest.mark.integration
def test_grep_search_max_matches_ceiling(seeded_collection):
    """Requesting beyond the config ceiling must clamp, not return more."""
    from src.main.service.agents.tools.grep_tools import grep_search

    deps = _build_deps(
        collection_ids=[seeded_collection["collection_id"]],
        document_ids=[seeded_collection["populated_id"]],
    )
    # The fixture only has 2 matches, so passing 999 just verifies no crash
    # and that the response respects the clamp shape (max_matches was clamped
    # internally to the ceiling, the real hit count is bounded by content).
    result = asyncio.run(grep_search(_ctx_for(deps), pattern=r"TEST_TOKEN_BORGES_\d+", max_matches=999))
    assert result.count <= 500
    assert result.count == 2  # only 2 markers in the fixture


@pytest.mark.integration
def test_grep_search_rejects_redos_pattern(seeded_collection):
    """Nested-quantifier ReDoS pattern must be rejected with a recoverable error."""
    from src.main.service.agents.tools.grep_tools import grep_search

    deps = _build_deps(
        collection_ids=[seeded_collection["collection_id"]],
        document_ids=[seeded_collection["populated_id"]],
    )
    with pytest.raises(ToolExecutionError) as exc:
        asyncio.run(grep_search(_ctx_for(deps), pattern=r"(a+)+"))
    assert exc.value.recoverable is True


# =============================================================================
# cat_document
# =============================================================================


@pytest.mark.integration
def test_cat_document_range(seeded_collection):
    """Ranged read returns the requested slice of documents.content."""
    from src.main.service.agents.tools.grep_tools import cat_document

    deps = _build_deps(
        collection_ids=[seeded_collection["collection_id"]],
        document_ids=[seeded_collection["populated_id"]],
    )
    ctx = _ctx_for(deps)

    head = asyncio.run(cat_document(ctx, document_id=str(seeded_collection["populated_id"]), char_end=20))
    assert head.startswith("# Labyrinths")
    assert len(head) == 20

    rest = asyncio.run(
        cat_document(
            ctx,
            document_id=str(seeded_collection["populated_id"]),
            char_start=20,
            char_end=200,
        )
    )
    assert head + rest == _KNOWN_CONTENT[:200]


@pytest.mark.integration
def test_cat_document_oversize_rejects(seeded_collection):
    """A slice over the per-call cap raises ToolExecutionError, not a 500."""
    from src.main.service.agents.tools.grep_tools import cat_document

    deps = _build_deps(
        collection_ids=[seeded_collection["collection_id"]],
        document_ids=[seeded_collection["populated_id"]],
    )
    ctx = _ctx_for(deps)
    with pytest.raises(ToolExecutionError):
        asyncio.run(
            cat_document(
                ctx,
                document_id=str(seeded_collection["populated_id"]),
                char_start=0,
                char_end=200_001,  # one over the default 200_000 cap
            )
        )


@pytest.mark.integration
def test_cat_document_outside_scope_rejected(seeded_collection):
    """A document_id not in deps.document_ids must be refused."""
    from src.main.service.agents.tools.grep_tools import cat_document

    deps = _build_deps(
        collection_ids=[seeded_collection["collection_id"]],
        document_ids=[seeded_collection["populated_id"]],  # ONLY this one
    )
    foreign_id = uuid4()
    with pytest.raises(ToolExecutionError):
        asyncio.run(cat_document(_ctx_for(deps), document_id=str(foreign_id)))


# =============================================================================
# Activation-trigger wiring
# =============================================================================


@pytest.mark.integration
def test_grep_tools_registered_in_core_toolset():
    """
    Regression test for the dead-code-class trap that bit the predecessor
    `PatternMatchingAgent` (since deleted — its regex SQL machinery lives in
    `grep_tools.py` now).

    `grep_search` and `cat_document` MUST be reachable from the
    `core` FunctionToolset that tool_based_rag_agent constructs — otherwise
    the LLM cannot pick them no matter how good the docstring.
    """
    from src.main.service.agents.rag_agents.tool_based_rag_agent import _build_toolsets

    toolsets = _build_toolsets()
    core = toolsets["core"]

    tool_names: set[str] = set()
    try:
        for fn in core.tools:
            tool_names.add(fn.__name__)
    except Exception:
        # FunctionToolset internal storage may not be iterable across versions;
        # fall back to scanning the toolset's tool dict if exposed.
        registry = getattr(core, "_tools", None) or getattr(core, "tools", {})
        if isinstance(registry, dict):
            tool_names = set(registry.keys())

    assert "grep_search" in tool_names, f"grep_search not registered — found: {tool_names}"
    assert "cat_document" in tool_names, f"cat_document not registered — found: {tool_names}"


@pytest.mark.integration
def test_resolve_authors_to_document_ids(seeded_collection):
    """Author resolution surfaces the seeded doc when the surname matches."""
    from src.main.service.agents.tools.grep_tools import resolve_authors_to_document_ids
    from src.main.utils.database.db_utils import get_db_session

    with get_db_session() as db:
        ids = resolve_authors_to_document_ids(
            db=db,
            user_id="test-grep-user",
            author_names=["Borges"],
            collection_ids=[seeded_collection["collection_id"]],
        )
    assert str(seeded_collection["populated_id"]) in ids


@pytest.mark.integration
def test_resolve_authors_empty_when_no_match(seeded_collection):
    """An author with no books in the collection must NOT activate grep."""
    from src.main.service.agents.tools.grep_tools import resolve_authors_to_document_ids
    from src.main.utils.database.db_utils import get_db_session

    with get_db_session() as db:
        ids = resolve_authors_to_document_ids(
            db=db,
            user_id="test-grep-user",
            author_names=["DoesNotExistAuthor_xyz"],
            collection_ids=[seeded_collection["collection_id"]],
        )
    assert ids == []
