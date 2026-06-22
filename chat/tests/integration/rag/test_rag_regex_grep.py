"""
Integration tests for Phase 2 RAGRegexGrep strategy.

Covers the new retrieval strategy:
- Pattern extraction from query / query_hints
- SQL pre-filter on documents.content + chunk hydration
- Scope enforcement (collection_ids / document_ids)
- Returns empty when no pattern is extractable (router fall-through path)
- Citation-compatible Document.metadata shape
- Tier-1 router rule routes verbatim identifiers to RAGRegexGrep

Run inside scrapalot-chat container:

    docker exec scrapalot-chat python -m pytest \\
        tests/integration/rag/test_rag_regex_grep.py -v
"""

from __future__ import annotations

import asyncio
import contextlib
from uuid import uuid4

import pytest

_DOC_BODY = """\
# Project Phoenix

## Chapter 1 — Setup

To deploy the service, pull the image tagged v2.4.1-beta and apply the
migration in commit 7f3a9c1. The configuration file references model
gpt-4o-mini for chat completions.

The compliance review covered ISO-9001:2015 and 15 CFR 744.21.

## Chapter 2 — Operations

When you see PROJ-5821 in the ticket tracker, route it to the platform team.
The full CVE-2024-1234 advisory is attached to the security folder.

Test marker: REGEXGREP_TOKEN_PHOENIX
"""

_CHUNKS = [
    # (text, cmetadata extras)
    (
        "## Chapter 1 — Setup\n\nTo deploy the service, pull the image tagged "
        "v2.4.1-beta and apply the migration in commit 7f3a9c1. The "
        "configuration file references model gpt-4o-mini for chat "
        "completions.\n\nThe compliance review covered ISO-9001:2015 and "
        "15 CFR 744.21.\n\nTest marker: REGEXGREP_TOKEN_PHOENIX",
        {"chunk_index": 0, "section_heading": "Chapter 1 — Setup"},
    ),
    (
        "## Chapter 2 — Operations\n\nWhen you see PROJ-5821 in the ticket "
        "tracker, route it to the platform team. The full CVE-2024-1234 "
        "advisory is attached to the security folder.",
        {"chunk_index": 1, "section_heading": "Chapter 2 — Operations"},
    ),
    (
        "Filler chunk with no distinctive tokens — just generic prose about deployment, observability, and incident response.",
        {"chunk_index": 2, "section_heading": "Chapter 3 — Filler"},
    ),
]


@pytest.fixture(scope="function")
def seeded_regex_grep_corpus(py_cursor) -> dict:
    """Seed a collection with one document, three chunks; two contain the
    distinctive tokens this Phase 2 tests against."""
    collection_id = uuid4()
    doc_id = uuid4()
    chunk_ids: list = []
    py_cursor.connection.autocommit = False

    try:
        py_cursor.execute(
            """
            INSERT INTO langchain_pg_collection (uuid, name)
            VALUES (%s, %s)
            ON CONFLICT (uuid) DO NOTHING
            """,
            (str(collection_id), f"regex_grep_test_{collection_id}"),
        )
        py_cursor.execute(
            """
            INSERT INTO documents (
                id, collection_id, title, filename, file_path, content,
                processing_status, processing_progress, deleted_at, file_stored
            )
            VALUES (
                %s, %s, 'Project Phoenix (test)', 'phoenix.md',
                '/tmp/regex_grep/phoenix.md', %s,
                'completed', 1.0, NULL, true
            )
            """,
            (str(doc_id), str(collection_id), _DOC_BODY),
        )
        for chunk_text, meta_extras in _CHUNKS:
            chunk_id = uuid4()
            chunk_ids.append(chunk_id)
            meta = {"document_id": str(doc_id), **meta_extras}
            py_cursor.execute(
                """
                INSERT INTO langchain_pg_embedding (
                    id, collection_id, document, cmetadata
                )
                VALUES (%s, %s, %s, %s::jsonb)
                """,
                (
                    str(chunk_id),
                    str(collection_id),
                    chunk_text,
                    _json_dumps(meta),
                ),
            )
        py_cursor.connection.commit()

        yield {
            "collection_id": collection_id,
            "doc_id": doc_id,
            "chunk_ids": chunk_ids,
        }
    finally:
        with contextlib.suppress(Exception):
            py_cursor.connection.rollback()
        py_cursor.execute(
            "DELETE FROM langchain_pg_embedding WHERE collection_id = %s",
            (str(collection_id),),
        )
        py_cursor.execute(
            "DELETE FROM documents WHERE id = %s",
            (str(doc_id),),
        )
        py_cursor.execute(
            "DELETE FROM langchain_pg_collection WHERE uuid = %s",
            (str(collection_id),),
        )
        py_cursor.connection.commit()


def _json_dumps(meta: dict) -> str:
    import json as _json

    return _json.dumps(meta)


def _make_strategy():
    """Build an RAGRegexGrep with no retriever / llm dependencies — the
    strategy only needs SQL access for retrieval. process_chat_request is
    not exercised here; we test execute() in isolation."""
    from src.main.service.rag.rag_regex_grep import RAGRegexGrep

    # retriever / llm not used by execute(); pass placeholders.
    strategy = RAGRegexGrep(retriever=None, llm=None)
    return strategy


# =============================================================================
# Test 1 — finds the exact token
# =============================================================================


@pytest.mark.integration
def test_regex_grep_finds_exact_token(seeded_regex_grep_corpus):
    """A SHA-like token in the query lands on the chunk that contains it."""
    strategy = _make_strategy()

    async def run() -> None:
        async for _ in strategy.execute(
            query="Where does the doc mention commit 7f3a9c1?",
            collection_ids=[seeded_regex_grep_corpus["collection_id"]],
        ):
            pass

    asyncio.run(run())

    assert strategy.retrieved_documents, "expected at least one chunk"
    top = strategy.retrieved_documents[0]
    assert "7f3a9c1" in top.page_content
    assert top.metadata["retrieval_method"] == "regex_grep"
    assert top.metadata["document_id"] == str(seeded_regex_grep_corpus["doc_id"])


# =============================================================================
# Test 2 — empty result when no pattern extractable
# =============================================================================


@pytest.mark.integration
def test_regex_grep_returns_empty_when_no_pattern(seeded_regex_grep_corpus):
    """Pure synthesis query with no distinctive tokens must yield no docs.

    This is the explicit fall-through signal Phase 5 will rely on — the
    strategy router can detect zero hits and re-route to RAGSimilaritySearch.
    """
    strategy = _make_strategy()

    async def run() -> None:
        async for _ in strategy.execute(
            query="tell me about consciousness",
            collection_ids=[seeded_regex_grep_corpus["collection_id"]],
        ):
            pass

    asyncio.run(run())
    assert strategy.retrieved_documents == []


# =============================================================================
# Test 3 — collection scope is honoured
# =============================================================================


@pytest.mark.integration
def test_regex_grep_respects_collection_scope(seeded_regex_grep_corpus, py_cursor):
    """A chunk seeded into a DIFFERENT collection must not surface."""
    other_collection = uuid4()
    other_doc = uuid4()
    other_chunk = uuid4()
    try:
        py_cursor.execute(
            """
            INSERT INTO langchain_pg_collection (uuid, name)
            VALUES (%s, %s) ON CONFLICT (uuid) DO NOTHING
            """,
            (str(other_collection), f"regex_grep_other_{other_collection}"),
        )
        py_cursor.execute(
            """
            INSERT INTO documents (
                id, collection_id, title, filename, file_path, content,
                processing_status, processing_progress, deleted_at, file_stored
            )
            VALUES (
                %s, %s, 'other', 'other.md', '/tmp/other.md',
                'Mentions commit 7f3a9c1 in another collection.',
                'completed', 1.0, NULL, true
            )
            """,
            (str(other_doc), str(other_collection)),
        )
        py_cursor.execute(
            """
            INSERT INTO langchain_pg_embedding (id, collection_id, document, cmetadata)
            VALUES (%s, %s, %s, %s::jsonb)
            """,
            (
                str(other_chunk),
                str(other_collection),
                "Mentions commit 7f3a9c1 in another collection.",
                _json_dumps({"document_id": str(other_doc)}),
            ),
        )
        py_cursor.connection.commit()

        strategy = _make_strategy()

        async def run() -> None:
            async for _ in strategy.execute(
                query="Where does the doc mention commit 7f3a9c1?",
                collection_ids=[seeded_regex_grep_corpus["collection_id"]],
            ):
                pass

        asyncio.run(run())

        doc_ids = {d.metadata["document_id"] for d in strategy.retrieved_documents}
        assert str(other_doc) not in doc_ids
        assert str(seeded_regex_grep_corpus["doc_id"]) in doc_ids
    finally:
        py_cursor.execute(
            "DELETE FROM langchain_pg_embedding WHERE id = %s",
            (str(other_chunk),),
        )
        py_cursor.execute("DELETE FROM documents WHERE id = %s", (str(other_doc),))
        py_cursor.execute(
            "DELETE FROM langchain_pg_collection WHERE uuid = %s",
            (str(other_collection),),
        )
        py_cursor.connection.commit()


# =============================================================================
# Test 4 — citation-compatible Document.metadata
# =============================================================================


@pytest.mark.integration
def test_regex_grep_citation_metadata_shape(seeded_regex_grep_corpus):
    """Every returned Document must carry the keys the citation processor reads.

    StreamingCitationProcessor looks for `document_id`, `title`/`source`,
    `chunk_id` (so it can map [n] back to the source). Strategy-specific
    extras (`retrieval_method`, `regex_match_count`) are additive and must
    not break the shape contract.
    """
    strategy = _make_strategy()

    async def run() -> None:
        async for _ in strategy.execute(
            query="What does the doc say about ISO-9001:2015?",
            collection_ids=[seeded_regex_grep_corpus["collection_id"]],
        ):
            pass

    asyncio.run(run())
    assert strategy.retrieved_documents
    for doc in strategy.retrieved_documents:
        assert "document_id" in doc.metadata
        assert "chunk_id" in doc.metadata
        assert "source" in doc.metadata or "title" in doc.metadata
        assert doc.metadata.get("retrieval_method") == "regex_grep"
        # Score must be a number so downstream sorting / fusion doesn't crash.
        assert isinstance(doc.metadata.get("score"), (int, float))
        assert doc.metadata.get("regex_match_count", 0) >= 1


# =============================================================================
# Test 5 — Tier-1 router routes verbatim identifiers to RAGRegexGrep
# =============================================================================


@pytest.mark.integration
def test_tiered_router_routes_identifier_to_regex_grep():
    """Verbatim-identifier queries trigger Rule 0 → RAGRegexGrep."""
    from src.main.service.rag.tiered_router import RuleBasedRouter

    router = RuleBasedRouter()

    cases = [
        "Where does the doc mention commit 7f3a9c1?",
        "Find references to ISO-9001:2015 in the corpus",
        "What does the text say about DOI 10.1145/3461702.3462624?",
        "Look up CVE-2024-1234 in the security folder",
        'Find the passage that quotes "the only way out is through"',
    ]
    for query in cases:
        result = router.route(query)
        assert result is not None, f"router missed: {query!r}"
        assert result.strategy_name == "RAGRegexGrep", (
            f"query {query!r} routed to {result.strategy_name!r}, expected RAGRegexGrep (rule={result.rule_id})"
        )
        assert result.rule_id == "regex_grep_identifiers"


# =============================================================================
# Test 6 — registered in the strategy registry
# =============================================================================


@pytest.mark.integration
def test_regex_grep_in_strategy_registry():
    """RAGRegexGrep must appear in the canonical registries so the router
    can validate / instantiate it."""
    from src.main.utils.rag.strategies import (
        RAG_INDIVIDUAL_STRATEGIES,
        RAG_INDIVIDUAL_STRATEGY_CLASSES,
        RAG_STRATEGY_CLASSES,
    )

    names = {s["value"] for s in RAG_INDIVIDUAL_STRATEGIES}
    assert "RAGRegexGrep" in names
    assert "RAGRegexGrep" in RAG_INDIVIDUAL_STRATEGY_CLASSES
    assert "RAGRegexGrep" in RAG_STRATEGY_CLASSES
