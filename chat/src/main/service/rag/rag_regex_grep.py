"""
RAGRegexGrep — raw regex retrieval over `documents.content`.

A first-class RAG strategy peer to RAGSimilaritySearch / RAGSparseSearch /
RAGGraphSearch. Where sparse search is BM25 over dense candidates (tokenised,
stemmed) and graph search traverses Neo4j, this strategy runs PostgreSQL
regex against the canonical `documents.content` markdown column and hydrates
the matching chunks for synthesis.

When this strategy wins:
- Literal error codes / version strings / SHAs / DOIs the user wants to find
  verbatim and BM25 mistokenises ("ISO-9001:2015", "v1.2.3", "10.1145/...")
- Quoted-phrase queries where the user explicitly demanded exact match
- Author-scoped queries combined with a distinctive token to locate

When NOT to use:
- Synthesis / "summarise" queries — there is no token to grep for
- Wide collection scans with no rare token in the query — falls back to empty
  results because no extractable pattern was usable. The strategy router
  should then drop to RAGSimilaritySearch (the existing routing fallback).

The implementation reuses the same `documents.content` corpus the
agent tool (`grep_tools.grep_search`) reads, then hydrates the chunks of
matching docs via `langchain_pg_embedding` so the synthesis layer can cite
them like any other strategy. Citations therefore flow through the standard
`StreamingCitationProcessor` — no special-cased citation format.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
import re
import time
from typing import Any
from uuid import UUID

from langchain_core.documents import Document
from sqlalchemy import text

from src.main.service.rag.rag_strategy import RAGStrategy
from src.main.service.retriever.retriever import Retriever
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger
from src.main.utils.database.db_utils import get_db_session

logger = get_logger(__name__)


# Sentinel set of generic English words we don't promote to grep tokens even
# when they happen to be capitalised in the query (e.g. start of a sentence).
_STOPWORDS = {
    "what",
    "when",
    "where",
    "which",
    "who",
    "whom",
    "why",
    "how",
    "the",
    "this",
    "that",
    "those",
    "these",
    "with",
    "from",
    "have",
    "been",
    "does",
    "did",
    "was",
    "were",
    "are",
    "and",
    "but",
    "for",
    "into",
    "onto",
    "about",
    "after",
    "before",
    "below",
    "above",
    "between",
    "during",
    "such",
    "some",
    "many",
    "much",
    "more",
    "most",
    "less",
    "least",
    "every",
    "each",
    "very",
    "show",
    "tell",
    "give",
    "make",
    "find",
    "explain",
    "describe",
    "summarize",
    "summary",
}


# Characters Postgres POSIX regex treats as special outside a bracket
# expression. `re.escape` over-escapes (e.g. `-`, `:`, `/`) and Postgres then
# rejects the unknown escape; this minimal-escape function produces a pattern
# that works for both Python `re.compile` and Postgres `~*` without surprises.
_POSIX_SPECIAL = set(".*+?()|[]{}^$\\")


def _posix_escape(s: str) -> str:
    return "".join("\\" + c if c in _POSIX_SPECIAL else c for c in s)


def _looks_distinctive(token: str) -> bool:
    """Heuristic: a token worth grep-routing.

    - Length >= 4
    - Not a common English stopword
    - And one of:
        - Mixed letters+digits (catches SHAs, semver, ticket IDs, model names)
        - Pure ALL-CAPS of length >= 3 (acronyms)
        - CamelCase / MixedCase (proper-noun-like)
        - Pure-digit ID >= 8 chars (long numeric identifiers like a
          de-hyphenated ISBN ``9781616209476``)
        - Hyphen/dot-separated digit groups, total digits >= 8 (ISBN
          ``978-1-61620-947-6``, phone numbers, structured numeric IDs)
    """
    if len(token) < 4:
        return False
    if token.lower() in _STOPWORDS:
        return False
    has_letter = bool(re.search(r"[A-Za-z]", token))
    has_digit = bool(re.search(r"\d", token))
    if has_letter and has_digit:
        return True
    if token.isupper() and has_letter:
        return True
    if not has_letter and has_digit:
        digit_count = sum(c.isdigit() for c in token)
        if digit_count >= 8 and all(c.isdigit() or c in "-." for c in token):
            return True
    # CamelCase / MixedCase
    return bool(token[0].isupper()) and any(c.islower() for c in token[1:])


def _extract_grep_pattern(query: str, query_hints: dict | None) -> str | None:
    """
    Build a regex pattern from query analysis, returning None when nothing
    distinctive is found. Order of preference:

    1. ``query_hints["regex_pattern"]`` — Tier-1 router supplied an exact
       pattern; trust it verbatim.
    2. ``query_hints["rare_terms"]`` — domain-rare terms detected upstream.
    3. Quoted spans in the query (single or double quotes).
    4. Distinctive identifiers (digits / ALL-CAPS / CamelCase) extracted from
       the prose itself.

    The returned pattern is always wrapped in ``\\b`` word boundaries (except
    for verbatim hint patterns which we don't second-guess).
    """
    if query_hints and isinstance(query_hints, dict):
        hint = query_hints.get("regex_pattern")
        if isinstance(hint, str) and hint.strip():
            return hint.strip()

        rare = query_hints.get("rare_terms") or []
        clean_rare = [t for t in rare if isinstance(t, str) and t.strip()]
        if clean_rare:
            escaped = [_posix_escape(t) for t in clean_rare]
            return r"\b(?:" + "|".join(escaped) + r")\b"

    quoted = re.findall(r'"([^"]{2,})"', query) + re.findall(r"'([^']{2,})'", query)
    if quoted:
        return r"(?:" + "|".join(_posix_escape(q) for q in quoted) + r")"

    # Token regex accepts digit-leading tokens (Git SHAs like `7f3a9c1` would
    # be missed by a letter-only anchor) and stops on common punctuation that
    # would otherwise mangle the surrounding word.
    candidates: set[str] = set()
    for match in re.finditer(r"[A-Za-z0-9][\w.\-:/]*[A-Za-z0-9]", query):
        token = match.group(0)
        if _looks_distinctive(token):
            candidates.add(token)

    if candidates:
        escaped = [_posix_escape(t) for t in sorted(candidates)]
        return r"\b(?:" + "|".join(escaped) + r")\b"

    return None


def _score_chunk_against_pattern(
    chunk_text: str,
    compiled_pattern: re.Pattern[str],
    proximity_window: int,
) -> tuple[int, float]:
    """Score a chunk by (a) total regex matches and (b) proximity boost when
    multiple matches cluster within a window.

    Returns ``(match_count, score)`` where score is match_count plus 0.5 per
    extra-match-inside-window pair. The boost rewards chunks where the
    pattern lands repeatedly (typical for an exact identifier in its own
    section) over chunks with a single accidental hit.
    """
    matches = list(compiled_pattern.finditer(chunk_text))
    n = len(matches)
    if n == 0:
        return 0, 0.0
    if n == 1:
        return 1, 1.0

    proximity_boost = 0.0
    for i in range(1, n):
        if matches[i].start() - matches[i - 1].end() <= proximity_window:
            proximity_boost += 0.5

    return n, float(n) + proximity_boost


class RAGRegexGrep(RAGStrategy):
    """
    Raw regex retrieval over `documents.content`.

    Pipeline:
    1. Build the regex pattern from the query (or query_hints) — return empty
       when nothing extractable, so the router can fall through.
    2. SQL pre-filter on `documents.content` with the case-insensitive `~*`
       operator, scoped by collection_ids / document_ids.
    3. For each matching document, fetch chunks via `langchain_pg_embedding`,
       score each chunk by per-chunk match count plus proximity boost.
    4. Top-k chunks become `self.retrieved_documents` with metadata that
       carries `retrieval_method="regex_grep"` and the standard
       `chunk_id` / `document_id` / `title` keys the citation processor
       expects.

    No bridging with dense / BM25 here — the strategy is intentionally pure.
    Hybrid grep+dense lives in a future harness, not in v1.
    """

    def __init__(self, retriever: Retriever, llm, packet_emitter=None):
        super().__init__(llm, retriever=retriever, packet_emitter=packet_emitter)
        cfg = resolved_config.get("rag", {})
        strategy_cfg = cfg.get("strategies", {}).get("regex_grep", {})
        self.top_k = int(strategy_cfg.get("top_k", 8))
        self.max_matches_per_query = int(strategy_cfg.get("max_matches_per_query", 200))
        self.proximity_window_chars = int(strategy_cfg.get("proximity_window_chars", 200))
        self.candidate_chunk_limit = int(strategy_cfg.get("candidate_chunk_limit", 200))

    async def execute(
        self,
        query: str,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
        top_k: int | None = None,
        similarity_threshold: float | None = None,
    ) -> AsyncGenerator[str]:
        """Execute regex retrieval over documents.content, hydrate chunks."""
        _ = similarity_threshold  # not used; grep does not have a continuous score
        _pending_packets: list[str] = []
        for packet in _pending_packets:
            yield packet

        effective_top_k = top_k or self.top_k

        pattern = _extract_grep_pattern(query, self.query_hints)
        if not pattern:
            logger.info(
                "RAGRegexGrep: no extractable pattern from query=%r and hints=%s — returning empty",
                query[:80],
                bool(self.query_hints),
            )
            self.retrieved_documents = []
            return

        try:
            compiled = re.compile(pattern, re.IGNORECASE)
        except re.error as exc:
            logger.warning("RAGRegexGrep: invalid pattern %r — %s", pattern, exc)
            self.retrieved_documents = []
            return

        logger.info(
            "RAGRegexGrep: pattern=%r scope_collections=%s scope_docs=%s top_k=%d",
            pattern,
            collection_ids,
            document_ids,
            effective_top_k,
        )

        _start = time.monotonic()
        try:
            chunks = await self._sql_retrieve(
                pattern=pattern,
                collection_ids=collection_ids,
                document_ids=document_ids,
            )
        except Exception as exc:
            logger.exception("RAGRegexGrep SQL retrieval failed: %s", exc)
            self.retrieved_documents = []
            return

        if not chunks:
            logger.info(
                "RAGRegexGrep: 0 chunks matched in %.1fms — falling through",
                (time.monotonic() - _start) * 1000,
            )
            self.retrieved_documents = []
            return

        # Score per chunk and pick top-k.
        scored: list[tuple[float, int, Document]] = []
        for row in chunks:
            chunk_text = row["chunk_text"] or ""
            match_count, score = _score_chunk_against_pattern(chunk_text, compiled, self.proximity_window_chars)
            if match_count == 0:
                # SQL ~ matched the chunk, but Python re did not — shouldn't
                # happen for sane patterns, but bail safely if it does.
                continue
            metadata = dict(row.get("chunk_meta") or {})
            metadata.update(
                {
                    "chunk_id": row["chunk_id"],
                    "document_id": row["doc_id"],
                    "title": row["doc_title"] or metadata.get("title"),
                    "source": row["doc_title"] or metadata.get("source") or row["doc_id"],
                    "retrieval_method": "regex_grep",
                    "score": float(score),
                    "regex_match_count": int(match_count),
                    "retriever": "grep",
                }
            )
            doc = Document(page_content=chunk_text, metadata=metadata)
            scored.append((score, match_count, doc))

        scored.sort(key=lambda triple: (triple[0], triple[1]), reverse=True)
        final = [triple[2] for triple in scored[:effective_top_k]]

        elapsed_ms = (time.monotonic() - _start) * 1000
        logger.info(
            "RAGRegexGrep: %d candidate chunks → top %d in %.1fms",
            len(scored),
            len(final),
            elapsed_ms,
        )
        self.retrieved_documents = final
        return

    async def _sql_retrieve(
        self,
        pattern: str,
        collection_ids: list[UUID] | None,
        document_ids: list[UUID] | None,
    ) -> list[dict[str, Any]]:
        """Run the two-stage SQL: pre-filter on documents.content, hydrate
        chunks whose own text matches the pattern.

        Returns a list of dicts with keys chunk_id, chunk_text, chunk_meta,
        doc_id, doc_title. SQL uses POSIX `~*` (case-insensitive). Python
        regex flags in the pattern (e.g. `(?i)`) are also honoured by
        Postgres, so callers can mix-and-match.
        """
        # Postgres ARE regex uses `\y` for word boundaries; `\b` is recognised
        # inside bracket expressions only (= backspace). Python `re` uses `\b`.
        # Build a SQL-flavoured pattern by swapping the boundary marker while
        # keeping the Python pattern intact for the in-process scoring pass.
        sql_pattern = pattern.replace(r"\b", r"\y")
        params: dict[str, Any] = {
            "pattern": sql_pattern,
            "candidate_limit": int(self.candidate_chunk_limit),
        }
        where_doc = [
            "d.content IS NOT NULL",
            "d.content ~* :pattern",
            "d.deleted_at IS NULL",
        ]
        if document_ids:
            where_doc.append("d.id = ANY(CAST(:doc_ids AS uuid[]))")
            params["doc_ids"] = [str(d) for d in document_ids]
        elif collection_ids:
            where_doc.append("d.collection_id = ANY(CAST(:collection_ids AS uuid[]))")
            params["collection_ids"] = [str(c) for c in collection_ids]

        sql = f"""
            SELECT
                e.id           AS chunk_id,
                e.document     AS chunk_text,
                e.cmetadata    AS chunk_meta,
                d.id           AS doc_id,
                d.title        AS doc_title
            FROM documents d
            JOIN langchain_pg_embedding e
                ON (e.cmetadata->>'document_id')::uuid = d.id
            WHERE {" AND ".join(where_doc)}
              AND e.document ~* :pattern
            ORDER BY d.title, e.id
            LIMIT :candidate_limit
        """

        with get_db_session() as db:
            rows = db.execute(text(sql), params).fetchall()

        # SQLAlchemy Row → dict for clean downstream access.
        result: list[dict[str, Any]] = []
        for row in rows:
            result.append(
                {
                    "chunk_id": str(row.chunk_id),
                    "chunk_text": row.chunk_text,
                    "chunk_meta": row.chunk_meta,
                    "doc_id": str(row.doc_id),
                    "doc_title": row.doc_title,
                }
            )
        return result
