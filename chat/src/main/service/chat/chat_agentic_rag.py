"""
Agentic RAG Chat Handler

Extracted from chat.py to handle agentic RAG requests.
This module processes chat requests with agentic_rag_enabled=True.
"""

import asyncio
from collections.abc import AsyncGenerator
import re
import time
from typing import Any
import uuid
from uuid import UUID

from sqlmodel import Session as SQLModelSession

from src.main.constants.error_codes import ErrorCode
from src.main.constants.status_codes import StatusCode, StructuredStatusCode
from src.main.dto.chat import ChatRequest
from src.main.main import Main
from src.main.service.streaming.packet_emitter import PacketEmitter
from src.main.utils.auth.jwt import User
from src.main.utils.core.logger import get_logger
from src.main.utils.text.language import language_directive as _language_directive

logger = get_logger(__name__)


def _read_general_setting(db: SQLModelSession, user_id: str, key: str) -> str | None:
    """Read a single string field from the user's settings_general blob.

    The settings JSON is synced from the Kotlin backend via Redis Streams, so
    reading from user_settings here sees fresh values without a gRPC round-trip.
    Returns None when the row is missing, not a dict, or the field is absent.
    """
    try:
        from sqlalchemy import and_

        from src.main.models.sqlmodel_models import UserSetting

        row = (
            db.query(UserSetting)
            .filter(
                and_(
                    UserSetting.user_id == user_id,
                    UserSetting.setting_key == "settings_general",
                )
            )
            .first()
        )
        if not row or not isinstance(row.setting_value, dict):
            return None
        value = row.setting_value.get(key)
        return value if isinstance(value, str) else None
    except Exception as e:
        logger.debug("Could not read %s for user %s: %s", key, user_id, e)
        return None


def _read_response_length(db: SQLModelSession, user_id: str) -> str:
    """Returns the user's preferred answer length, defaulting to "long".

    Empty / unset / "medium" all collapse to "long" — the previous default
    ("medium" by way of None) produced terse 100-200-word answers when the
    user actually wanted a deep descriptive read with context and counter-
    points. "long" pulls the 500+-word snippet from
    tool_based_rag_agent._RESPONSE_LENGTH_SNIPPETS into the system prompt.
    Users who actively prefer short answers keep that choice — only the
    silent default changes.
    """
    value = _read_general_setting(db, user_id, "response_length")
    return value if value in ("short", "medium", "long") else "long"


def _read_rag_augmentation(db: SQLModelSession, user_id: str) -> str:
    """Returns the user's preferred RAG augmentation mode, defaulting to "augmented".

    Empty / unset previously produced "strict" behaviour (citations only,
    no LLM-knowledge complement). "augmented" turns on the PART 1 / PART 2
    template that places the cited document content first, then a separated
    LLM-knowledge "feedback" section at the end — exactly the layered shape
    the user asked for. Active "strict" / "auto" choices are preserved.
    """
    value = _read_general_setting(db, user_id, "rag_augmentation")
    return value if value in ("strict", "augmented", "auto") else "augmented"


def _narrate(emitter: "PacketEmitter", language: str | None, hr: str, en: str) -> str:
    """Emit a one-sentence reasoning_delta packet — the "thinking stream"
    the UI renders as Claude-like fading lines while the agent works.

    Each call is the equivalent of the agent narrating one step out loud so
    the user sees progress instead of staring at a spinner. Sentences must
    be specific (real numbers/names from the current context), conversational,
    and short — one line max.

    `language` defaults to `hr` when None or empty so we don't accidentally
    leak English into the Croatian UX. Anything other than "hr" gets the
    English variant.
    """
    text = hr if (not language or language.startswith("hr")) else en
    return emitter.emit_reasoning_delta(text)


# When the collection selector narrows to nothing, fall back to searching ALL
# accessible collections — but only when the workspace is small enough that a
# full scan stays within the retrieval semaphore budget. On larger workspaces a
# blind scan risks pgvector pool exhaustion, so we keep the empty scope there.
_FALLBACK_SCAN_CAP = 8


def _all_accessible_scope(accessible_collections: list[dict]) -> list[uuid.UUID]:
    """Return UUIDs for ALL accessible collections when the workspace is small
    (<= _FALLBACK_SCAN_CAP), else an empty list (protect the connection pool).

    This is the fallback for "the selector couldn't pick a collection": searching
    everything is far better than answering from general knowledge when the
    library plausibly holds the answer, as long as the scan stays bounded.
    """
    if not accessible_collections or len(accessible_collections) > _FALLBACK_SCAN_CAP:
        return []
    ids: list[uuid.UUID] = []
    for c in accessible_collections:
        raw = c.get("id")
        if not raw:
            continue
        try:
            ids.append(uuid.UUID(str(raw)))
        except (ValueError, TypeError):
            continue
    return ids


async def _chunk_probe_select_scope(
    db: SQLModelSession,
    query: str,
    accessible_collections: list[dict],
    language: str | None = None,
    top_k: int = 30,
    max_collections: int = 4,
) -> tuple[list[uuid.UUID], list[str]]:
    """Content-similarity collection auto-selector that scales past name-only scoring.

    Embeds the query and runs ONE pgvector top-K search over the actual chunk
    embeddings, scoped to the accessible collections. The collections that own the
    nearest chunks ARE the relevant collections — this uses real content similarity
    instead of the LLM scoring collection names (which degrades badly past ~20
    collections and was leaving large workspaces with an empty scope → no
    documents) or the blurry per-collection centroid (which ranked the wrong ones).

    One short read query, released immediately, so it is pool-safe even on large
    workspaces. Returns ``(collection_uuids, human_names)``; empty when nothing
    matches (caller keeps its general-knowledge fallback).
    """
    if not accessible_collections:
        return [], []

    # all-MiniLM is English-only: a raw Croatian query embeds poorly and selects the
    # wrong collection (verified: "zelena gnojidba" matched psychology, not
    # agriculture). Translate first, exactly like the retriever does.
    probe_query = query
    try:
        from src.main.service.rag.cross_language import translate_query_if_needed

        _orig, translated = await translate_query_if_needed(query)
        if translated:
            probe_query = translated
    except Exception as e:  # translation is best-effort
        logger.debug("Chunk-probe translation skipped: %s", e)

    id_to_name = {str(c["id"]): c.get("name", str(c["id"])) for c in accessible_collections if c.get("id")}
    accessible_id_strs = list(id_to_name.keys())
    if not accessible_id_strs:
        return [], []

    def _probe() -> list[tuple[str, int, float]]:
        from sqlalchemy import text as sa_text

        from src.main.service.llm.llm_embedding_factory import get_embedding_function

        emb = get_embedding_function(provider="local")
        qvec = str(emb.embed_query(probe_query))
        # langchain_pg_collection.name stores the scrapalot collection_id; .uuid is
        # the internal id referenced by langchain_pg_embedding.collection_id.
        rows = db.execute(
            sa_text(
                """
                WITH acc AS (
                    SELECT lpc.uuid AS lc_uuid, lpc.name AS scrapalot_id
                    FROM langchain_pg_collection lpc
                    WHERE lpc.name = ANY(:acc_ids)
                ),
                top AS (
                    SELECT e.collection_id, e.embedding <=> CAST(:q AS vector) AS dist
                    FROM langchain_pg_embedding e
                    WHERE e.collection_id IN (SELECT lc_uuid FROM acc)
                    ORDER BY e.embedding <=> CAST(:q AS vector)
                    LIMIT :k
                )
                SELECT acc.scrapalot_id, count(*) AS hits, max(1 - top.dist) AS best_sim
                FROM top JOIN acc ON acc.lc_uuid = top.collection_id
                GROUP BY acc.scrapalot_id
                ORDER BY hits DESC
                """
            ),
            {"q": qvec, "acc_ids": accessible_id_strs, "k": top_k},
        ).fetchall()
        return [(str(r[0]), int(r[1]), float(r[2])) for r in rows]

    try:
        hits = await asyncio.to_thread(_probe)
    except Exception as e:  # probe is an optimization, never fatal
        logger.warning("Chunk-probe collection selection failed, falling back: %s", e)
        return [], []

    if not hits:
        return [], []

    # Dominance gate: only rescue when ONE collection clearly owns the query. A
    # flat distribution means the topic is not really in the library — the nearest
    # chunks are scattered noise (verified: "Sun Tzu deception in war" → 11/10/9
    # across agriculture/spirituality/self_help, no war collection exists). Forcing
    # retrieval on noise wastes CPU and surfaces irrelevant citations, so we leave
    # the scope empty and let the caller answer from general knowledge instead.
    top_hits = hits[0][1]
    top_best_sim = hits[0][2]
    second_hits = hits[1][1] if len(hits) > 1 else 0
    dominant = top_hits >= 1.5 * max(1, second_hits) or top_hits >= 0.45 * top_k
    if not dominant:
        logger.info(
            "Chunk-probe distribution too flat (top=%d, second=%d of %d) — no clear collection, deferring to general knowledge",
            top_hits,
            second_hits,
            top_k,
        )
        return [], []

    # Absolute similarity floor: a gibberish or out-of-domain query embeds to noise
    # that still has a "winner" by count but with weak cosine similarity (verified:
    # "asdfqwer zxcv nonsense" → ufo at best-sim 0.37, vs real queries at 0.69-0.73).
    # all-MiniLM scores cluster high, so 0.45 cleanly separates noise from content.
    if top_best_sim < 0.45:
        logger.info(
            "Chunk-probe top collection similarity too weak (best_sim=%.3f) — treating as out-of-domain, deferring to general knowledge",
            top_best_sim,
        )
        return [], []

    # Keep collections whose hit-share is meaningful relative to the winner; this
    # drops the long tail of 1-2 incidental hits while still admitting a genuine
    # 2-3 collection spread on cross-topic queries. Cap for pool safety.
    threshold = max(2.0, top_hits * 0.2)
    selected_uuids: list[uuid.UUID] = []
    selected_names: list[str] = []
    for cid, h, _sim in hits:
        if h < threshold:
            continue
        try:
            selected_uuids.append(uuid.UUID(cid))
        except (ValueError, TypeError):
            continue
        selected_names.append(id_to_name.get(cid, cid))
        if len(selected_uuids) >= max_collections:
            break

    return selected_uuids, selected_names


def _resolve_explicit_collection_scope(request: ChatRequest, db, accessible_collections: list[dict]) -> list[uuid.UUID]:
    """Explicit user scope that OVERRIDES agentic auto-discovery.

    Collections the user pinned (``request.collection_ids``) plus the collections
    of any documents/books the user @-tagged (``request.document_ids``). Validated
    against the user's accessible collections so a stale or foreign id can't widen
    scope. Returns [] when the user gave NO explicit scope — only then does the
    caller fall back to the LLM collection selector. An explicit tag must win over
    the agent's guess, never the other way around.
    """
    accessible_ids = {str(c["id"]) for c in accessible_collections}
    out: list[uuid.UUID] = []
    seen: set[str] = set()

    def _add(raw) -> None:
        try:
            cid = uuid.UUID(str(raw))
        except (ValueError, TypeError, AttributeError):
            return
        key = str(cid)
        if key in seen or key not in accessible_ids:
            return
        seen.add(key)
        out.append(cid)

    for cid in getattr(request, "collection_ids", None) or []:
        _add(cid)

    doc_ids = getattr(request, "document_ids", None) or []
    if doc_ids:
        from sqlalchemy import text as sa_text

        for doc_id in doc_ids:
            # noinspection PyTypeChecker,PyDeprecation
            row = db.execute(sa_text("SELECT collection_id FROM documents WHERE id = :doc_id"), {"doc_id": str(doc_id)}).fetchone()
            if row:
                _add(row[0])
    return out


def _build_conversation_prefix(request: ChatRequest) -> str:
    """Format prior-conversation context (summary + recent turns) for the agentic
    generation prompt.

    The agentic path otherwise never reads conversation_history, so a follow-up
    like "continue on this topic" loses all prior context and the model says it
    has none. Reuse the same DatabaseOnlyMemory + summary the standard chat path
    uses (so summarization also finally runs for agentic conversations). The
    current user turn is dropped from the recent exchange — Kotlin appends it as
    the last item in conversation_history and it is already the prompt we send,
    so including it would duplicate the question.
    """
    try:
        from langchain_core.messages import AIMessage, HumanMessage

        from src.main.service.rag.rag_utils import build_conversation_memory

        memory = build_conversation_memory(request)
        if memory is None:
            return ""

        ctx = memory.get_context_for_llm()
        summary = ctx.get("summary", "") if ctx.get("has_summary") else ""
        recent = ctx.get("last_exchange") or ctx.get("full_messages", []) or []

        # Drop the trailing current-user turn (Kotlin includes it in history).
        if recent and getattr(recent[-1], "content", "") == request.prompt:
            recent = recent[:-1]

        parts: list[str] = []
        if summary and summary.strip():
            parts.append(f"### Previous Conversation Summary:\n{summary.strip()}")
        if recent:
            turns: list[str] = []
            for m in recent:
                role = "User" if isinstance(m, HumanMessage) else "Assistant" if isinstance(m, AIMessage) else "System"
                content = getattr(m, "content", "")
                if content and content.strip():
                    turns.append(f"{role}: {content.strip()}")
            if turns:
                parts.append("### Recent Conversation:\n" + "\n".join(turns))

        prefix = "\n\n".join(parts)
        if prefix:
            logger.info("Agentic chat: injected conversation context (summary=%s, recent_turns=%d)", bool(summary), len(recent))
        return prefix
    except Exception as e:
        logger.warning("Failed to build conversation prefix for agentic chat: %s", str(e))
        return ""


class AgenticRAGResult:
    """Result container for agentic RAG processing."""

    def __init__(self):
        self.orchestration_result = None
        self.agentic_strategy_info = None
        self.was_cancelled = False
        self.full_response = ""
        self.received_stream_end = False


async def process_agentic_rag(
    request: ChatRequest,
    emitter: PacketEmitter,
    main_instance: Main,
    subscription_tier: str,
    db: SQLModelSession,
    user_id: str,
    current_user: User,
    assistant_message_id: UUID | None,
) -> AsyncGenerator[str, None]:
    """
    Process an agentic RAG chat request.

    This function handles multi-source orchestration:
    1. Collection discovery and selection
    2. Query analysis and intent detection
    3. Source selection (documents, web, LLM)
    4. Strategy routing
    5. Tool-based RAG agent execution

    Args:
        request: The chat request with agentic_rag_enabled=True
        emitter: PacketEmitter for streaming responses
        main_instance: Main application instance for LLM access
        subscription_tier: User's subscription tier
        db: Database session
        user_id: User ID
        current_user: Current user object
        assistant_message_id: Assistant message ID for tracking

    Yields:
        JSON packet strings for streaming response
    """
    from src.main.utils.workspaces.access import get_user_accessible_collections

    # Community Edition: the multi-agent orchestrator, tiered router, collection
    # selector, strategy presets, MCP toolsets and chart agent are hosted-only and
    # were stripped from this build. The CE flow keeps collection scoping (explicit
    # pins, content chunk-probe, small-workspace fan-out) and answers with basic
    # similarity-search retrieval + LLM synthesis, falling back to direct chat when
    # nothing in the library is relevant.
    logger.info("Starting agentic RAG (Community Edition basic retrieval) for query: %s", request.prompt[:100])

    result = AgenticRAGResult()

    try:
        # Triage gate #0: before ANY retrieval, ask one cheap LLM call whether
        # this turn actually needs retrieval. Greetings, acknowledgements, small
        # talk and pure meta/formatting instructions ("say only 'hello'") are
        # answered directly and we return — skipping collection resolution, the
        # orchestrator (query analysis + source selection + strategy routing),
        # retrieval, and the reflection layer. An explicitly pinned collection must
        # NOT force the whole pipeline for a query that is not about its content, so
        # this runs ahead of explicit-scope resolution. Fails open: any error or
        # ambiguity routes to the full pipeline below.
        from src.main.service.chat.query_triage import triage_query

        triage = await triage_query(
            query=request.prompt,
            conversation=_build_conversation_prefix(request),
            language=request.language,
        )
        if not triage.needs_pipeline:
            logger.info("Triage: trivial turn, answering directly and skipping orchestration")
            yield emitter.emit_message_start()
            yield emitter.emit_message_delta(triage.direct_answer)
            result.full_response = triage.direct_answer
            result.received_stream_end = True
            yield emitter.emit_stream_end(reason="completed")
            return

        # Narrator beat #1: acknowledge the question is in flight. Without
        # this the UI sits on a spinner for ~30-60s before the first packet
        # carrying anything human-readable arrives.
        yield _narrate(
            emitter,
            request.language,
            "Razumijem upit. Pripremam pretragu kroz tvoje kolekcije.",
            "Got your question. Preparing to search across your collections.",
        )

        # In agentic mode, discover relevant collections automatically
        # (UI disables manual collection selection when agentic mode is enabled)
        # If workspace_id not provided but document_ids are, infer workspace from document
        effective_workspace_id = request.workspace_id
        if not effective_workspace_id and request.document_ids:
            # Look up workspace from first document's collection
            from sqlalchemy import text

            doc_id = request.document_ids[0]
            # noinspection PyTypeChecker,PyDeprecation
            result_row = db.execute(
                text("""
                    SELECT cwm.workspace_id
                    FROM documents d
                    JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id
                    WHERE d.id = :doc_id
                    LIMIT 1
                """),
                {"doc_id": str(doc_id)},
            ).fetchone()
            if result_row:
                effective_workspace_id = str(result_row[0])
                logger.info("Inferred workspace_id %s from document_id %s", effective_workspace_id, doc_id)

        if not effective_workspace_id:
            logger.warning("Agentic RAG requires workspace_id, falling back to direct LLM")
            yield emitter.emit_error("workspace_id required for agentic RAG", error_code="MISSING_WORKSPACE")
            yield emitter.emit_stream_end(reason="error")
            return

        accessible_collections = get_user_accessible_collections(db, str(user_id), str(effective_workspace_id))
        effective_collection_ids = []

        # Explicit scope ALWAYS wins over auto-discovery: if the user pinned a
        # collection (collection_ids) or @-tagged documents/books (document_ids),
        # honor exactly that scope and SKIP the LLM collection selector. The
        # explicit tag is the priority; the agent's guess must never override it.
        explicit_collection_ids = _resolve_explicit_collection_scope(request, db, accessible_collections)
        if explicit_collection_ids:
            effective_collection_ids = explicit_collection_ids
            _explicit_set = {str(x) for x in explicit_collection_ids}
            pinned_names = [c["name"] for c in accessible_collections if str(c["id"]) in _explicit_set]
            logger.info(
                "Explicit collection scope provided (%d) — honoring it, skipping auto-selector: %s",
                len(effective_collection_ids),
                pinned_names,
            )
            yield emitter.emit_status(
                StructuredStatusCode.selected_collections(len(effective_collection_ids)),
                stage=StatusCode.COLLECTION_DISCOVERY.value,
            )
            hr_label = ", ".join(f"'{n}'" for n in pinned_names[:3]) or "odabranu kolekciju"
            en_label = ", ".join(f"'{n}'" for n in pinned_names[:3]) or "the selected collection"
            yield _narrate(
                emitter,
                request.language,
                f"Koristim kolekciju koju si zakačio: {hr_label} (preskačem automatski odabir).",
                f"Using the collection(s) you pinned: {en_label} (skipping auto-selection).",
            )
        elif accessible_collections:
            logger.info(
                "Agentic mode (CE): scoping from %d accessible collections",
                len(accessible_collections),
            )
            yield emitter.emit_status(
                StructuredStatusCode.analyzing_collections(len(accessible_collections)),
                stage=StatusCode.COLLECTION_DISCOVERY.value,
            )

            # Community Edition has no LLM collection selector. On a SMALL workspace
            # fan out across all accessible collections (the retrieval semaphore
            # bounds concurrency, so a handful is safe). On a LARGE workspace leave
            # the scope empty so the content chunk-probe below can pick by content —
            # which scales far better than scanning everything and protects the
            # pgvector connection pool.
            fallback_ids = _all_accessible_scope(accessible_collections)
            if fallback_ids:
                effective_collection_ids = fallback_ids
                logger.info(
                    "Small workspace (%d collections) → searching all accessible",
                    len(accessible_collections),
                )
                yield _narrate(
                    emitter,
                    request.language,
                    "Pretražit ću sve tvoje kolekcije.",
                    "I'll search across all your collections.",
                )
            else:
                effective_collection_ids = []
                logger.info("Large workspace → will pick collections by content chunk-probe")

        # Content chunk-probe rescue: a large workspace was left with no scope.
        # Before answering from general knowledge, probe the actual chunk
        # embeddings — this scales to any number of collections and one pgvector
        # query is pool-safe. Skipped when an explicit pin already set the scope or
        # a small workspace already fell back to scanning all accessible collections.
        if accessible_collections and not effective_collection_ids:
            probe_uuids, probe_names = await _chunk_probe_select_scope(db, request.prompt, accessible_collections, request.language)
            if probe_uuids:
                effective_collection_ids = probe_uuids
                logger.info(
                    "Chunk-probe rescued empty scope -> %d collections: %s",
                    len(probe_uuids),
                    probe_names,
                )
                yield emitter.emit_status(
                    StructuredStatusCode.selected_collections(len(probe_uuids)),
                    stage=StatusCode.COLLECTION_DISCOVERY.value,
                )
                names_label = ", ".join(f"'{n}'" for n in probe_names[:3])
                yield _narrate(
                    emitter,
                    request.language,
                    f"Po sadržaju izdvajam: {names_label}.",
                    f"By content I narrowed to: {names_label}.",
                )
            else:
                # No collection is *topically* relevant, but the user does have a
                # library. Route to the library-aware direct chat so the LLM can
                # still answer inventory/meta questions ("what collections / books
                # do I have?") by calling list_collections / list_documents — or
                # search on demand — instead of flatly deferring to general
                # knowledge (which never reaches those tools). Falls back to a
                # plain answer if there is genuinely nothing to search.
                logger.info("Chunk-probe found nothing relevant; routing to library-aware direct chat")
                from src.main.service.rag.rag_utils import (
                    _NoLibraryTools,
                    _process_direct_llm_with_library_tools,
                    process_direct_llm_chat,
                )

                try:
                    async for packet in _process_direct_llm_with_library_tools(
                        request,
                        str(current_user.id),
                        emitter,
                        str(effective_workspace_id) if effective_workspace_id else "",
                    ):
                        yield packet
                except _NoLibraryTools:
                    async for packet in process_direct_llm_chat(request, current_user.id, emitter):
                        yield packet
                return

        # If the user explicitly @-tagged documents, go straight to the
        # summary-first tagged-document flow (does NOT depend on any deleted
        # agent). Ensure we have collection_ids for the tagged documents.
        if request.document_ids:
            logger.info(
                "Explicit document_ids provided (%d docs), routing to tagged-document RAG",
                len(request.document_ids),
            )

            if not effective_collection_ids:
                from sqlalchemy import text as sa_text

                doc_collection_ids = set()
                for doc_id in request.document_ids:
                    # noinspection PyTypeChecker,PyDeprecation
                    row = db.execute(
                        sa_text("SELECT collection_id FROM documents WHERE id = :doc_id"),
                        {"doc_id": str(doc_id)},
                    ).fetchone()
                    if row:
                        doc_collection_ids.add(uuid.UUID(str(row[0])))
                effective_collection_ids = list(doc_collection_ids)
                logger.info("Inferred %d collection_ids from document_ids", len(effective_collection_ids))

            async for packet in _process_tagged_document(
                request=request,
                emitter=emitter,
                main_instance=main_instance,
                subscription_tier=subscription_tier,
                db=db,
                user_id=user_id,
                assistant_message_id=assistant_message_id,
                effective_collection_ids=effective_collection_ids,
            ):
                yield packet
            return

        # Community Edition: no multi-agent orchestrator / tiered router. When we
        # have a document scope, run basic similarity-search retrieval + synthesis.
        # Otherwise fall back to direct LLM chat.
        if effective_collection_ids:
            yield _narrate(
                emitter,
                request.language,
                "Pokrećem pretragu kroz tvoje dokumente.",
                "Running a search across your documents.",
            )
            async for packet in _process_document_rag(
                request=request,
                emitter=emitter,
                main_instance=main_instance,
                subscription_tier=subscription_tier,
                db=db,
                user_id=user_id,
                assistant_message_id=assistant_message_id,
                effective_collection_ids=effective_collection_ids,
            ):
                yield packet
        else:
            from src.main.service.rag.rag_utils import process_direct_llm_chat

            logger.info("No document scope in CE agentic RAG; routing to direct LLM chat")
            async for packet in process_direct_llm_chat(request, current_user.id, emitter):
                yield packet

    except Exception as agentic_rag_error:
        logger.exception("Error in agentic RAG processing: %s", str(agentic_rag_error))

        # User-friendly error message for the UI
        error_message = "Intelligent document search encountered an error and could not complete. Please try again or use regular document search."

        yield emitter.emit_error(
            error_message,
            error_code=ErrorCode.PROCESS_FAILED.value,
        )
        yield emitter.emit_stream_end(reason="error")
        result.was_cancelled = True


async def _process_tagged_document(
    request: ChatRequest,
    emitter: PacketEmitter,
    main_instance: Main,
    subscription_tier: str,
    db: SQLModelSession,
    user_id: str,
    assistant_message_id: UUID | None,
    effective_collection_ids: list[UUID],
) -> AsyncGenerator[str, None]:
    """Process explicitly @-tagged documents using summary-first strategy.

    Strategy:
    1. Detect intent (whole book, specific chapter, or specific topic)
    2. Try document_summaries table first (fast, cheap)
    3. Fallback to documents.content markdown (extract relevant section, summarize with LLM)
    4. Last resort: fall through to tool-based RAG agent
    5. Async backfill missing summaries
    """
    from sqlmodel import select

    from src.main.models.sqlmodel_models import Document, DocumentSummary

    _start = time.monotonic()
    doc_ids = [uuid.UUID(str(d)) for d in request.document_ids]
    prompt_lower = request.prompt.lower().strip()

    # --- Step 1: Intent detection ---
    intent = _detect_document_intent(prompt_lower)
    logger.info("Tagged document intent: %s for query: %s", intent["type"], request.prompt[:80])

    # --- Step 2: Load document info ---
    doc = db.get(Document, doc_ids[0]) if doc_ids else None
    if not doc:
        logger.warning("Tagged document not found: %s", doc_ids[0] if doc_ids else "none")
        # Fall through to standard RAG
        async for packet in _process_document_rag(
            request=request,
            emitter=emitter,
            main_instance=main_instance,
            subscription_tier=subscription_tier,
            db=db,
            user_id=user_id,
            assistant_message_id=assistant_message_id,
            effective_collection_ids=effective_collection_ids,
        ):
            yield packet
        return

    # noinspection PyUnresolvedReferences
    doc_title = doc.title or doc.filename
    yield emitter.emit_status(f"analyzing_{doc_title[:40]}", stage="tagged_document")

    # --- Smart routing for tagged-document chat
    #
    # The right design: when the user @-mentions documents,
    # delegate to the tool-based RAG agent that owns `grep_search`,
    # `cat_document`, and `dense_search` and let the agent pick. The agent
    # path also pulls in book/chapter summaries via `_process_document_rag`,
    # so we don't need to hand-roll a hybrid context here.
    #
    # We keep two fast-paths for the cases where the agent loop would be
    # pure overhead:
    #   1. `book_overview` + book/chapter summaries exist → answer from
    #      summaries directly (no tool calls needed).
    #   2. `chapter_query` + matching chapter summary exists → same.
    # Everything else (specific_topic, multi-doc compare, verbatim
    # lookups, long descriptive prose) goes through `_process_document_rag`
    # so grep_search / cat_document / dense_search are all on the table.
    context_text = None
    summaries_exist = False

    if intent["type"] == "book_overview":
        book_summary_row = db.exec(
            select(DocumentSummary).where(DocumentSummary.document_id == doc_ids[0]).where(DocumentSummary.summary_type == "book")
        ).first()
        if book_summary_row:
            summaries_exist = True
            chapter_rows = db.exec(
                select(DocumentSummary)
                .where(DocumentSummary.document_id == doc_ids[0])
                .where(DocumentSummary.summary_type == "chapter")
                .order_by(DocumentSummary.chapter_index)
            ).all()
            chapters_text = ""
            if chapter_rows:
                chapters_text = "\n\nChapter Summaries:\n" + "\n\n".join(f"Chapter: {cs.chapter_title}\n{cs.summary_text}" for cs in chapter_rows)
            context_text = f"Book: {doc_title}\n\nBook Summary:\n{book_summary_row.summary_text}{chapters_text}"

    elif intent["type"] == "chapter_query":
        chapter_rows = db.exec(
            select(DocumentSummary)
            .where(DocumentSummary.document_id == doc_ids[0])
            .where(DocumentSummary.summary_type == "chapter")
            .order_by(DocumentSummary.chapter_index)
        ).all()
        if chapter_rows:
            summaries_exist = True
            matched = _find_matching_chapter(intent.get("chapter", ""), chapter_rows)
            if matched:
                context_text = f"Book: {doc_title}\n\nChapter: {matched.chapter_title}\n{matched.summary_text}"

    # If we don't have a summary fast-path hit, delegate to the tool-based
    # agent which can call grep_search / cat_document / dense_search.
    if context_text is None:
        logger.info(
            "Tagged-document intent=%s — delegating to tool-based RAG agent (grep+cat+dense)",
            intent["type"],
        )
        async for packet in _process_document_rag(
            request=request,
            emitter=emitter,
            main_instance=main_instance,
            subscription_tier=subscription_tier,
            db=db,
            user_id=user_id,
            assistant_message_id=assistant_message_id,
            effective_collection_ids=effective_collection_ids,
        ):
            yield packet
        return

    # --- Step 5: If we have context, use LLM to answer directly ---
    if context_text:
        logger.info("Answering tagged document query directly (context: %d chars)", len(context_text))
        yield emitter.emit_status("generating_answer", stage="tagged_document")

        orchestrator_llm = await main_instance.llm_manager.get_llm(
            model_name=request.model_name,
            provider_type=request.provider_type,
            enable_metrics=True,
            subscription_tier=subscription_tier,
            db=db,
            user_id=str(user_id),
            message_id=str(assistant_message_id),
        )
        if orchestrator_llm:
            # Truncate context to fit in LLM context window (keep ~12K chars)
            if len(context_text) > 12000:
                context_text = context_text[:12000] + "\n\n[Content truncated...]"

            llm_prompt = (
                f"Based on the following document content, answer the user's question.\n"
                f"Provide a thorough, well-structured answer.\n"
                f"{_language_directive(request.language, prompt=request.prompt)}\n\n"
                f"---\n{context_text}\n---\n\n"
                f"User question: {request.prompt}"
            )

            try:
                response = await orchestrator_llm.ainvoke(llm_prompt)
                answer = response.content if hasattr(response, "content") else str(response)
                # Stream the answer in chunks for smoother UI
                chunk_size = 50
                for i in range(0, len(answer), chunk_size):
                    yield emitter.emit_message_delta(answer[i : i + chunk_size])

                duration_ms = int((time.monotonic() - _start) * 1000)
                from src.main.service.llm.token_metrics_callback import extract_token_metrics_from_llm

                token_metrics = extract_token_metrics_from_llm(orchestrator_llm)
                yield emitter.emit_stream_end(reason="completed", duration_ms=duration_ms, **token_metrics)
                logger.info("Tagged document direct answer completed in %dms", duration_ms)

                # --- Step 6: Async backfill missing summaries ---
                if not summaries_exist:
                    _schedule_summary_backfill(doc_ids[0], user_id)

                return
            except Exception as llm_err:
                logger.warning("Direct LLM answer failed, falling through to RAG: %s", str(llm_err))

    # --- Fallback: standard tool-based RAG ---
    logger.info("Falling through to standard tool-based RAG for tagged document")
    async for packet in _process_document_rag(
        request=request,
        emitter=emitter,
        main_instance=main_instance,
        subscription_tier=subscription_tier,
        db=db,
        user_id=user_id,
        assistant_message_id=assistant_message_id,
        effective_collection_ids=effective_collection_ids,
    ):
        yield packet

    # Backfill if needed even on RAG path
    if not summaries_exist and doc_ids:
        _schedule_summary_backfill(doc_ids[0], user_id)


def _detect_document_intent(prompt_lower: str) -> dict:
    """Detect what the user is asking about a tagged document.

    Returns dict with 'type' key: 'book_overview', 'chapter_query', or 'specific_topic'
    """
    # Book overview patterns (multiple languages)
    book_patterns = [
        r"what is this book about",
        r"what's this book about",
        r"summarize this book",
        r"summary of this book",
        r"tell me about this book",
        r"o (čemu|cemu) (se radi|je|govori)",
        r"sažmi (ovu |)(knjigu|knjižicu|dokument)",
        r"sumiraj",
        r"about what",
        r"give me (an? |)overview",
        r"main (themes|topics|ideas|points)",
        r"what does this (book|document) (cover|discuss|talk about)",
    ]
    for pattern in book_patterns:
        if re.search(pattern, prompt_lower):
            return {"type": "book_overview"}

    # Chapter-specific patterns
    chapter_patterns = [
        r"chapter\s+(\d+|[ivxlc]+|\"[^\"]+\"|'[^']+')",
        r"poglavl[juea]\s+(\d+|[ivxlc]+|\"[^\"]+\"|'[^']+')",
        r"(first|second|third|last|opening|closing|final)\s+chapter",
        r"(prvo|drugo|treće|zadnje|posljednje)\s+poglavlje",
    ]
    for pattern in chapter_patterns:
        match = re.search(pattern, prompt_lower)
        if match:
            return {"type": "chapter_query", "chapter": match.group(1) if match.lastindex else ""}

    # Default: specific topic query (will use all available context)
    return {"type": "specific_topic"}


def _find_matching_chapter(query: str, chapters: list) -> Any:
    """Find best matching chapter summary by name or index."""
    query_lower = query.lower().strip().strip("\"'")

    # Try numeric match
    num_match = re.match(r"(\d+)", query_lower)
    if num_match:
        idx = int(num_match.group(1)) - 1  # 1-based to 0-based
        for ch in chapters:
            if ch.chapter_index == idx:
                return ch

    # Try roman numeral match
    roman_map = {"i": 0, "ii": 1, "iii": 2, "iv": 3, "v": 4, "vi": 5, "vii": 6, "viii": 7, "ix": 8, "x": 9}
    if query_lower in roman_map:
        idx = roman_map[query_lower]
        for ch in chapters:
            if ch.chapter_index == idx:
                return ch

    # Try title substring match
    for ch in chapters:
        if ch.chapter_title and query_lower in ch.chapter_title.lower():
            return ch

    return None


def _extract_content_around_distinctive_tokens(content: str, prompt: str, window: int = 500, max_chars: int = 12000) -> str | None:
    """Grep-first helper for tagged-document chat.

    When the prompt carries a verbatim identifier (ISBN, DOI, git SHA,
    semver, long quoted phrase, …), pull out a ``±window`` character
    surrounding context for each match in the document body. Returns
    ``None`` when no distinctive token is detected in the prompt or no
    match lands in the content — caller then falls back to the existing
    intent-based extractor.

    Reuses the same pattern extractor as ``RAGRegexGrep`` so behaviour
    stays consistent between the cross-collection grep route and the
    @mention-scoped chat route. Uses Python ``re.IGNORECASE`` so the
    POSIX/ARE ``\\y`` translation (needed only for SQL ``~*``) is not
    relevant here.
    """
    if not content or not prompt:
        return None

    from src.main.service.rag.rag_regex_grep import _extract_grep_pattern

    pattern_str = _extract_grep_pattern(prompt, query_hints=None)
    if not pattern_str:
        return None

    try:
        compiled = re.compile(pattern_str, re.IGNORECASE)
    except re.error:
        return None

    spans: list[tuple[int, int]] = []
    for m in compiled.finditer(content):
        spans.append((max(0, m.start() - window), min(len(content), m.end() + window)))
        if len(spans) >= 20:  # enough surrounding windows to fill max_chars
            break

    if not spans:
        return None

    # Merge overlapping windows so we don't re-quote the same region twice.
    spans.sort()
    merged: list[tuple[int, int]] = [spans[0]]
    for s, e in spans[1:]:
        last_s, last_e = merged[-1]
        if s <= last_e:
            merged[-1] = (last_s, max(last_e, e))
        else:
            merged.append((s, e))

    parts: list[str] = []
    total = 0
    for s, e in merged:
        snippet = content[s:e]
        if total + len(snippet) > max_chars:
            snippet = snippet[: max_chars - total]
        parts.append(f"[…{s}–{s + len(snippet)}…]\n{snippet}")
        total += len(snippet)
        if total >= max_chars:
            break

    return "\n\n".join(parts)


def _extract_relevant_content(content: str, hierarchy: dict, intent: dict, max_chars: int = 12000) -> str:
    """Extract relevant portion of document markdown based on intent.

    For book_overview: extract intro + first section of each chapter
    For chapter_query: extract the specific chapter section
    For specific_topic: extract intro + table of contents
    """
    if not content:
        return ""

    if intent["type"] == "book_overview":
        # Get intro (first ~3000 chars) + chapter headings with first paragraphs
        lines = content.split("\n")
        result_lines = []
        chars = 0
        in_chapter_start = False
        chapter_count = 0

        for line in lines:
            # Detect chapter headings (markdown ## or ###)
            if line.startswith("# ") or line.startswith("## "):
                chapter_count += 1
                in_chapter_start = True
                result_lines.append(line)
                chars += len(line) + 1
                continue

            if in_chapter_start:
                # Grab first ~500 chars of each chapter
                result_lines.append(line)
                chars += len(line) + 1
                if chars > 500 * chapter_count:
                    in_chapter_start = False
                    result_lines.append("...")
            elif chars < 3000:
                # Grab intro
                result_lines.append(line)
                chars += len(line) + 1

            if chars >= max_chars:
                break

        return "\n".join(result_lines)

    elif intent["type"] == "chapter_query" and hierarchy:
        chapter_name = intent.get("chapter", "")
        # Find chapter in hierarchy
        for key, val in hierarchy.items():
            if chapter_name.lower() in key.lower() or (
                val.get("heading_level") == 1 and chapter_name.isdigit() and list(hierarchy.keys()).index(key) == int(chapter_name) - 1
            ):
                chunk_range = val.get("chunk_range", [])
                if chunk_range:
                    # Extract by finding the chapter heading in content
                    return _extract_section_by_heading(content, key, max_chars)

        # Couldn't find specific chapter, return beginning
        return content[:max_chars]

    else:
        # Specific topic: return beginning + any headings for orientation
        return content[:max_chars]


def _extract_section_by_heading(content: str, heading: str, max_chars: int) -> str:
    """Extract a section of markdown by its heading."""
    # Find the heading in content
    pattern = re.compile(r"^#{1,3}\s*" + re.escape(heading), re.MULTILINE | re.IGNORECASE)
    match = pattern.search(content)
    if not match:
        # Try fuzzy: first few words
        words = heading.split()[:3]
        if words:
            fuzzy_pattern = re.compile(r"^#{1,3}\s*.*" + r".*".join(re.escape(w) for w in words), re.MULTILINE | re.IGNORECASE)
            match = fuzzy_pattern.search(content)

    if match:
        start = match.start()
        return content[start : start + max_chars]

    return content[:max_chars]


def _schedule_summary_backfill(document_id: UUID, user_id: str) -> None:
    """Schedule async backfill of document summaries (non-blocking)."""
    try:
        asyncio.create_task(_backfill_summaries(document_id, user_id))
        logger.info("Scheduled async summary backfill for document %s", document_id)
    except Exception as e:
        logger.debug("Could not schedule summary backfill: %s", str(e))


async def _backfill_summaries(document_id: UUID, user_id: str) -> None:
    """Generate missing document summaries in the background."""
    try:
        from src.main.config.database import get_db
        from src.main.service.document.document_summary_service import DocumentSummaryService

        # noinspection PyTypeChecker
        db_session = next(get_db())
        try:
            # noinspection PyTypeChecker
            service = DocumentSummaryService(db=db_session)
            async with asyncio.timeout(120):
                await service.generate_document_summaries(
                    document_id=document_id,
                    user_id=UUID(user_id),
                )
        finally:
            db_session.close()
        logger.info("Background summary backfill completed for document %s", document_id)
    except Exception as e:
        logger.warning("Background summary backfill failed for %s: %s", document_id, str(e))



async def _process_document_rag(
    request: ChatRequest,
    emitter: PacketEmitter,
    main_instance: Main,
    subscription_tier: str,
    db: SQLModelSession,
    user_id: str,
    assistant_message_id: UUID | None,
    effective_collection_ids: list[UUID],
    author_names: list[str] | None = None,
    selected_strategy: str | None = None,
    query_intent: str | None = None,
) -> AsyncGenerator[str, None]:
    """Community Edition document RAG: basic similarity-search retrieval + synthesis.

    The hosted edition runs a multi-agent tool loop (grep/cat/dense tools, MCP
    toolsets, strategy presets, cross-book comparison, charts). Those are removed
    in the Community Edition. Here we run a single pgvector similarity search over
    the selected collections (and any @-tagged documents), then synthesize a cited
    answer with the user's chat model. ``author_names`` / ``selected_strategy`` /
    ``query_intent`` are accepted for call-site compatibility but ignored — there is
    no router or grep activation in CE.
    """
    from src.main.service.retriever.retriever_manager import retriever_manager
    from src.main.service.streaming.citation_processor import StreamingCitationProcessor

    _doc_rag_start = time.monotonic()

    # Fetch book-level summaries for the documents in scope — cheap context that
    # helps the model frame the answer. Does not depend on any deleted module.
    document_summaries: dict[str, dict] = {}
    try:
        from sqlmodel import select

        from src.main.models.sqlmodel_models import Document, DocumentSummary

        if request.document_ids:
            doc_ids_to_summarize = [uuid.UUID(str(doc_id)) for doc_id in request.document_ids]
        else:
            # noinspection PyUnresolvedReferences
            docs_query = select(Document.id).where(Document.collection_id.in_(effective_collection_ids))
            doc_ids_to_summarize = list(db.exec(docs_query).all())

        if doc_ids_to_summarize:
            summaries_query = (
                select(DocumentSummary)
                # noinspection PyUnresolvedReferences
                .where(DocumentSummary.document_id.in_(doc_ids_to_summarize))
                .where(DocumentSummary.summary_type == "book")
            )
            for summary in db.exec(summaries_query).all():
                doc = db.get(Document, summary.document_id)
                if doc:
                    document_summaries[str(summary.document_id)] = {
                        "title": doc.title or doc.filename,
                        "summary": summary.summary_text,
                    }
            if document_summaries:
                logger.info("Retrieved %d document summaries for context enhancement", len(document_summaries))
                yield emitter.emit_status(
                    StructuredStatusCode.context_enhancement(f"loaded_{len(document_summaries)}_summaries"),
                    stage=StatusCode.PREPARATION.value,
                )
    except Exception as e:
        logger.warning("Could not fetch document summaries: %s", str(e))

    # Acquire the user's chat model for synthesis.
    orchestrator_llm = await main_instance.llm_manager.get_llm(
        model_name=request.model_name,
        provider_type=request.provider_type,
        enable_metrics=True,
        subscription_tier=subscription_tier,
        db=db,
        user_id=str(user_id),
        message_id=str(assistant_message_id),
    )
    if not orchestrator_llm:
        logger.error(
            "Failed to get LLM for document RAG: %s (Provider: %s)",
            request.model_name,
            request.provider_type,
        )
        yield emitter.emit_error(
            f"Failed to initialize LLM for document search: {request.model_name}",
            error_code=ErrorCode.SERVICE_UNAVAILABLE.value,
        )
        duration_ms = int((time.monotonic() - _doc_rag_start) * 1000)
        yield emitter.emit_stream_end(reason="error", duration_ms=duration_ms)
        return

    # Basic pgvector similarity search over the selected scope.
    retriever = await retriever_manager.get_retriever(user_id=str(user_id), retriever_type="pgvector")
    if retriever is None:
        logger.error("pgvector retriever unavailable for document RAG")
        yield emitter.emit_error(
            "Document search is temporarily unavailable.",
            error_code=ErrorCode.SERVICE_UNAVAILABLE.value,
        )
        duration_ms = int((time.monotonic() - _doc_rag_start) * 1000)
        yield emitter.emit_stream_end(reason="error", duration_ms=duration_ms)
        return

    document_ids = [uuid.UUID(str(d)) for d in request.document_ids] if request.document_ids else None

    yield emitter.emit_status(
        StructuredStatusCode.context_enhancement("retrieving"),
        stage=StatusCode.PREPARATION.value,
    )
    yield _narrate(
        emitter,
        request.language,
        "Pretražujem tvoju knjižnicu po sadržaju…",
        "Searching your library by content…",
    )

    retrieved_docs: list = []
    try:
        retrieved_docs = await retriever.similarity_search(
            prompt=request.prompt,
            k=15,
            collection_ids=list(effective_collection_ids) if effective_collection_ids else None,
            document_ids=document_ids,
        )
    except Exception as e:
        logger.warning("similarity_search failed in CE document RAG: %s", str(e))
        retrieved_docs = []

    # No grounded sources — fall back to a plain direct LLM answer rather than
    # fabricating citations.
    if not retrieved_docs:
        logger.info("No documents retrieved; falling back to direct LLM chat")
        from src.main.service.rag.rag_utils import process_direct_llm_chat

        async for packet in process_direct_llm_chat(request, user_id, emitter):
            yield packet
        return

    logger.info("Retrieved %d chunks for CE document RAG", len(retrieved_docs))

    # Build the numbered context block the model cites against.
    context_parts: list[str] = []
    for idx, doc in enumerate(retrieved_docs, start=1):
        title = ""
        try:
            title = doc.metadata.get("title") or doc.metadata.get("document_title") or ""
        except Exception as meta_err:
            logger.debug("Could not read doc metadata: %s", meta_err)
        snippet = (getattr(doc, "page_content", "") or "")[:1500]
        header = f"[{idx}]" + (f" {title}" if title else "")
        context_parts.append(f"{header}\n{snippet}")
    context_block = "\n\n".join(context_parts)
    if len(context_block) > 14000:
        context_block = context_block[:14000] + "\n\n[Content truncated...]"

    summary_block = ""
    if document_summaries:
        lines = [f"- {info['title']}: {info['summary'][:300]}" for info in document_summaries.values()]
        summary_block = "Document overviews:\n" + "\n".join(lines) + "\n\n"

    response_length = _read_response_length(db, str(user_id))
    length_hint = {
        "short": "Keep the answer concise (a few sentences).",
        "medium": "Write a focused answer of a few paragraphs.",
        "long": "Write a thorough, well-structured answer with context.",
    }.get(response_length, "Write a thorough, well-structured answer with context.")

    conversation_prefix = _build_conversation_prefix(request)
    prefix_block = f"{conversation_prefix}\n\n" if conversation_prefix else ""

    llm_prompt = (
        "Answer the user's question using ONLY the numbered sources below. "
        "Cite the sources you use with inline markers like [1], [2]. "
        f"{length_hint}\n"
        f"{_language_directive(request.language, prompt=request.prompt)}\n\n"
        f"{prefix_block}"
        f"{summary_block}"
        f"---\nSources:\n{context_block}\n---\n\n"
        f"Question: {request.prompt}"
    )

    yield emitter.emit_status(
        StructuredStatusCode.context_enhancement("generating_answer"),
        stage=StatusCode.PREPARATION.value,
    )

    citation_processor = StreamingCitationProcessor(
        context_docs=list(retrieved_docs),
        max_citation_num=len(retrieved_docs),
        user_query=request.prompt,
    )

    message_started = False
    try:
        # Stream the synthesized answer, routing tokens through the citation
        # processor so inline [n] markers become structured citation packets.
        async for chunk in orchestrator_llm.astream(llm_prompt):
            text = chunk.content if hasattr(chunk, "content") else str(chunk)
            if not text:
                continue
            if not message_started:
                yield emitter.emit_message_start()
                yield emitter.emit_citation_start()
                message_started = True
            display_text, citations = citation_processor.process_token(text)
            for citation in citations:
                yield emitter.emit(citation)
            if display_text:
                yield emitter.emit_message_delta(display_text)

        # Flush any buffered tail + fall back to document-level citations.
        final_text, final_citations = citation_processor.flush()
        for citation in final_citations:
            yield emitter.emit(citation)
        if final_text:
            yield emitter.emit_message_delta(final_text)
        for citation in citation_processor.fallback_cite_top_docs():
            yield emitter.emit(citation)
    except Exception as gen_err:
        logger.warning("Streaming synthesis failed, falling back to single invoke: %s", str(gen_err))
        if not message_started:
            yield emitter.emit_message_start()
        try:
            response = await orchestrator_llm.ainvoke(llm_prompt)
            answer = response.content if hasattr(response, "content") else str(response)
            for i in range(0, len(answer), 50):
                yield emitter.emit_message_delta(answer[i : i + 50])
        except Exception as invoke_err:
            logger.exception("Document RAG synthesis failed: %s", str(invoke_err))
            yield emitter.emit_error(
                "Failed to generate an answer from the retrieved documents.",
                error_code=ErrorCode.PROCESS_FAILED.value,
            )
            yield emitter.emit_stream_end(reason="error")
            return

    duration_ms = int((time.monotonic() - _doc_rag_start) * 1000)
    from src.main.service.llm.token_metrics_callback import extract_token_metrics_from_llm

    token_metrics = extract_token_metrics_from_llm(orchestrator_llm)
    yield emitter.emit_stream_end(reason="completed", duration_ms=duration_ms, **token_metrics)
    logger.info("CE document RAG completed in %dms", duration_ms)
