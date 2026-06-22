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
    from src.main.service.agents.rag_agents.agentic_orchestrator import (
        extract_orchestration_result_from_packets,
        orchestrate_agentic_rag_with_streaming,
    )
    from src.main.service.agents.rag_agents.collection_selector import get_collection_selector
    from src.main.utils.workspaces.access import get_user_accessible_collections

    logger.info("Starting agentic RAG with multi-source orchestration for query: %s", request.prompt[:100])

    result = AgenticRAGResult()

    try:
        orchestration_packets = []

        # Triage gate #0: before ANY orchestration, ask one cheap LLM call whether
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
                "Agentic mode: discovering from %d accessible collections",
                len(accessible_collections),
            )
            yield emitter.emit_status(
                StructuredStatusCode.analyzing_collections(len(accessible_collections)),
                stage=StatusCode.COLLECTION_DISCOVERY.value,
            )

            # Narrator beat #2: explain what the agent is about to spend
            # 3-5s doing (the collection selector LLM call). The number
            # makes it feel concrete instead of abstract "thinking".
            yield _narrate(
                emitter,
                request.language,
                f"Imaš {len(accessible_collections)} kolekcija — razmišljam koja je najrelevantnija za ovaj upit.",
                f"You have {len(accessible_collections)} collections — picking the most relevant one for this query.",
            )

            # Use singleton collection selector with system-configured model
            selector = get_collection_selector(db)

            # Select from accessible collections (top_k and min_confidence from settings)
            selection_result = await selector.select_from_collections(
                query=request.prompt,
                collections=accessible_collections,
                db_session=db,
            )

            if selection_result.selected_collections:
                # Validate collection IDs - only use valid UUIDs that exist in accessible collections
                accessible_ids = {c["id"] for c in accessible_collections}
                effective_collection_ids = []
                for col in selection_result.selected_collections:
                    try:
                        col_uuid = uuid.UUID(col.collection_id)
                        if str(col_uuid) in accessible_ids or col.collection_id in accessible_ids:
                            effective_collection_ids.append(col_uuid)
                        else:
                            logger.warning("Collection selector returned invalid ID: %s", col.collection_id)
                    except ValueError:
                        logger.warning("Collection selector returned non-UUID ID: %s", col.collection_id)

                if effective_collection_ids:
                    selected_names = [
                        col.name
                        for col in selection_result.selected_collections
                        if col.collection_id in accessible_ids or str(col.collection_id) in accessible_ids
                    ]
                    logger.info(
                        "Collection selector chose %d collections: %s",
                        len(effective_collection_ids),
                        selected_names,
                    )
                    yield emitter.emit_status(
                        StructuredStatusCode.selected_collections(len(effective_collection_ids)),
                        stage=StatusCode.COLLECTION_DISCOVERY.value,
                    )
                    # Narrator beat #3: tell the user WHICH collections won
                    # and with what confidence — the single most important
                    # piece of context-aware reasoning to surface (it answers
                    # "is the agent looking in the right place?").
                    names_label = ", ".join(f"'{n}'" for n in selected_names[:3])
                    conf_pct = int((selection_result.confidence or 0.0) * 100)
                    yield _narrate(
                        emitter,
                        request.language,
                        f"Najrelevantnije mi izgledaju: {names_label} (pouzdanje {conf_pct}%).",
                        f"Most relevant: {names_label} (confidence {conf_pct}%).",
                    )
                else:
                    # All selected IDs were invalid. With the fixed selector
                    # prompt (placeholders + "verbatim UUID" rule) this should
                    # almost never happen, but if it does, do NOT fall back to
                    # scanning every accessible collection — on a workspace
                    # with 20+ collections that exhausts the pgvector
                    # connection pool ("too many clients already") and the
                    # entire chat fails. Better to retrieve nothing and let
                    # the LLM answer from general knowledge with a clean
                    # "ne nalazim u tvojim dokumentima" framing.
                    # Validation discarded every selected id. Same fallback as the
                    # "no results" branch: search all accessible on a small
                    # workspace rather than vetoing documents entirely.
                    fallback_ids = _all_accessible_scope(accessible_collections)
                    if fallback_ids:
                        effective_collection_ids = fallback_ids
                        logger.warning(
                            "Selector returned 0 valid collection IDs; small workspace (%d) → searching all accessible",
                            len(accessible_collections),
                        )
                        yield _narrate(
                            emitter,
                            request.language,
                            "Nijedna se ne ističe — pretražit ću sve tvoje kolekcije.",
                            "None stands out — I'll search across all your collections.",
                        )
                    else:
                        # Large workspace, name-selector gave nothing usable. Leave
                        # the scope empty for now; the content chunk-probe below gets
                        # a chance to rescue it before we surrender to general
                        # knowledge (so we do NOT narrate that here).
                        effective_collection_ids = []
                        logger.warning(
                            "Selector returned 0 valid collection IDs out of %d candidates; large workspace, will try content chunk-probe",
                            len(selection_result.selected_collections),
                        )
            else:
                # Selector found nothing specific. Do NOT veto documents entirely:
                # "couldn't narrow down" must not collapse to "answer from general
                # knowledge" (that was the cause of ~22% of queries skipping the
                # library). On a SMALL workspace, fall back to searching all
                # accessible collections — the retrieval semaphore bounds
                # concurrency so a handful is safe. Only on a LARGE workspace keep
                # the empty scope to protect the pgvector pool.
                fallback_ids = _all_accessible_scope(accessible_collections)
                if fallback_ids:
                    effective_collection_ids = fallback_ids
                    logger.info(
                        "Selector returned no results; small workspace (%d collections) → searching all accessible",
                        len(accessible_collections),
                    )
                    yield _narrate(
                        emitter,
                        request.language,
                        "Nijedna se ne ističe — pretražit ću sve tvoje kolekcije.",
                        "None stands out — I'll search across all your collections.",
                    )
                else:
                    # Large workspace, name-selector found nothing. Defer the
                    # general-knowledge narration to after the content chunk-probe
                    # rescue below (it scales where name-scoring does not).
                    effective_collection_ids = []
                    logger.info("Selector returned no results; large workspace, will try content chunk-probe")

        # Content chunk-probe rescue: the name-selector left a large workspace with
        # no scope. Before answering from general knowledge, probe the actual chunk
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

        # Check for chart intent — bypass orchestration and go to chart-only agent
        chart_keywords = {
            "chart",
            "graph",
            "plot",
            "visualize",
            "visualise",
            "visualization",
            "bar chart",
            "line chart",
            "pie chart",
            "scatter",
            "diagram",
            "compare visually",
            "show me a chart",
            "draw a chart",
        }
        query_lower = request.prompt.lower()
        has_chart_intent = any(kw in query_lower for kw in chart_keywords)

        if has_chart_intent:
            logger.info("Chart intent detected, bypassing orchestration and routing to chart-only agent")
            async for packet in _process_chart_only_agent(
                request=request,
                emitter=emitter,
                _main_instance=main_instance,
                db=db,
                user_id=user_id,
            ):
                yield packet
            return

        # If user explicitly @-tagged documents, skip orchestration and go straight to document RAG.
        # The orchestration agent has no awareness of explicit document_ids and may choose 'llm' source,
        # completely ignoring the user's intent to query specific documents.
        elif request.document_ids:
            logger.info(
                "Explicit document_ids provided (%d docs), bypassing orchestration and forcing document RAG",
                len(request.document_ids),
            )

            # Ensure we have collection_ids for the tagged documents
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

        else:
            # FAST PATH: tiered routing (Tier 1 regex ~0.5ms, Tier 2 embedding ~15ms)
            # skips the 3-LLM-call orchestrator (~20s of query_analyzer +
            # source_selector + strategy_router) for queries that confidently match a
            # routing rule. Rule matches (relationship, cross-document, comparison,
            # error-code, decomposition…) are inherently DOCUMENT queries, so when
            # collections are in scope the source is unambiguously "documents" — go
            # straight to document RAG with the matched strategy. Greetings/trivia
            # were already peeled off by the upstream triage gate, and ambiguous
            # queries fall through to the full orchestrator (which also weighs
            # web / direct-LLM).
            fast_route = None
            if effective_collection_ids:
                try:
                    from src.main.service.rag.tiered_router import ExemplarRouter, RuleBasedRouter

                    rule_router = RuleBasedRouter()
                    # Tier 1 on the original prompt — English queries match here with
                    # zero translation cost.
                    fast_route = rule_router.route(request.prompt)

                    # The Tier-1 rules are English regex, so a non-English query
                    # (Croatian — often mistagged 'sl'/'bs' by langdetect, now
                    # normalized in translate_query_if_needed) misses them. Translate
                    # ONCE and retry Tier 1, then Tier 2 (embedding similarity) on the
                    # English text. Translation only runs when Tier 1 missed AND the
                    # query is non-English, so English queries pay nothing.
                    if fast_route is None:
                        from src.main.service.rag.cross_language import (
                            detect_language,
                            translate_query_if_needed,
                        )

                        if (detect_language(request.prompt) or "en") != "en":
                            _orig, _translated = await translate_query_if_needed(request.prompt)
                            if _translated:
                                fast_route = rule_router.route(_translated) or ExemplarRouter.get_instance().route(_translated)
                except Exception as e:
                    logger.debug("Tiered fast-route skipped: %s", e)

            if fast_route is not None:
                logger.info(
                    "Fast-path routing: rule '%s' -> strategy '%s' (conf %.2f) — skipping LLM orchestrator",
                    fast_route.rule_id,
                    fast_route.strategy_name,
                    fast_route.confidence,
                )
                yield _narrate(
                    emitter,
                    request.language,
                    "Prepoznajem tip pitanja — pokrećem ciljanu pretragu kroz tvoje dokumente.",
                    "Recognized the question type — running a targeted search across your documents.",
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
                    author_names=[],
                    selected_strategy=fast_route.strategy_name,
                    query_intent=None,
                ):
                    yield packet
                return

            logger.info(
                "Starting improved agentic orchestration for query: %s (user: %s)",
                request.prompt[:50],
                user_id,
            )

            # Narrator beat #5: the next ~10-15s are query analysis + source
            # selection + strategy routing (three LLM calls inside the
            # orchestrator). Tell the user what those phases are — without
            # this the spinner just sits there.
            yield _narrate(
                emitter,
                request.language,
                "Analiziram strukturu pitanja i biram strategiju pretrage.",
                "Analyzing the question structure and picking a search strategy.",
            )

            # Stream complete agentic orchestration: Query Analysis -> Source Selection -> Strategy Routing
            # This implements the improved "shared analysis + specialized routing" architecture
            _agentic_start_time = time.time()
            async for packet in orchestrate_agentic_rag_with_streaming(
                query=request.prompt,
                collection_ids=effective_collection_ids,
                user_id=user_id,
                db=db,
                model_name=request.model_name,
                provider_type=request.provider_type,
            ):
                yield packet
                orchestration_packets.append(packet)

            # Extract orchestration result with all analysis components
            orchestration_result = extract_orchestration_result_from_packets(orchestration_packets)
            result.orchestration_result = orchestration_result

            logger.info(
                "Orchestration completed - Sources: %s, Strategy: %s",
                orchestration_result.source_selection.primary_sources,
                (orchestration_result.strategy_selection.selected_strategy if orchestration_result.strategy_selection else "None"),
            )

            # Emit a Search Strategy transparency packet so the UI can render a
            # collapsible sidebar showing how the answer was constructed. This is
            # the methodological-defensibility signal academic users need when
            # quoting Scrapalot answers in systematic reviews.
            try:
                from src.main.dto.streaming import StrategyTransparencyPacket

                qa = orchestration_result.query_analysis
                ss = orchestration_result.strategy_selection
                sel = orchestration_result.source_selection

                filters: dict[str, str] = {}
                if qa:
                    if getattr(qa, "intent", None):
                        filters["intent"] = str(qa.intent)
                    if getattr(qa, "complexity", None):
                        filters["complexity"] = str(qa.complexity)
                    if getattr(qa, "domain", None):
                        filters["domain"] = str(qa.domain)
                    if getattr(qa, "information_depth", None):
                        filters["depth"] = str(qa.information_depth)

                sub_queries = [request.prompt]
                if qa and getattr(qa, "entities", None):
                    # Surface the entities the analyzer picked out — they are the
                    # most literal decomposition the UI can show without a full
                    # decompose_query tool run.
                    sub_queries += [str(e) for e in qa.entities if e]

                # Report only the sources this request ACTUALLY executes — mirror
                # the dispatch condition below (line ~1022) so the panel never
                # claims a source that produced no citations:
                #  - 'web' never runs in the agentic path (no web_search tool / no
                #    preset declares the 'web' category) → always dropped.
                #  - a document source only runs when collections were selected;
                #    with none, the flow falls back to direct LLM and retrieves
                #    nothing, so claiming 'documents' (with zero citations) misled.
                _src_lower = [s.lower().strip() for s in (sel.primary_sources if sel else [])]
                _will_run_docs = bool(effective_collection_ids) and any(s not in ("web", "llm") for s in _src_lower)
                _queried = []
                if _will_run_docs:
                    _queried.append("documents")
                # Direct LLM is the generator whenever documents don't run, and an
                # explicit 'llm' source is honoured either way.
                if "llm" in _src_lower or not _will_run_docs:
                    _queried.append("llm")
                yield emitter.emit(
                    StrategyTransparencyPacket(
                        sub_queries=sub_queries[:8],
                        filters_applied=filters,
                        sources_queried=_queried,
                        strategy_name=(ss.selected_strategy if ss else None),
                        rationale=(ss.strategy_reasoning if ss else None),
                        # Reflect the real executor: the unified tool-agent when
                        # documents run, otherwise the direct-LLM fallback.
                        executor="agentic_tool_agent" if _will_run_docs else "direct_llm",
                    )
                )
            except Exception as strategy_emit_err:
                logger.debug("Could not emit StrategyTransparencyPacket: %s", strategy_emit_err)

            # Fire-and-forget: persist RAG trace for evaluation metrics (background, no latency impact)
            if request.session_id:
                try:
                    import asyncio

                    from src.main.config.database import SessionLocal
                    from src.main.service.evaluation.rag_evaluation_service import persist_rag_trace

                    strategy_sel = orchestration_result.strategy_selection
                    query_analysis = orchestration_result.query_analysis
                    query_chars = None
                    if query_analysis:
                        query_chars = {
                            "intent": getattr(query_analysis, "intent", None),
                            "complexity": getattr(query_analysis, "complexity", None),
                            "domain": getattr(query_analysis, "domain", None),
                            "entities": getattr(query_analysis, "entities", []),
                        }

                    # session_id format is "userId:sessionId" composite — extract session UUID
                    raw_session = request.session_id
                    if ":" in raw_session:
                        raw_session = raw_session.split(":", 1)[1]

                    selected_strategy = strategy_sel.selected_strategy if strategy_sel else "direct_llm"
                    strategy_confidence = strategy_sel.strategy_confidence if strategy_sel else 1.0
                    strategy_reasoning = strategy_sel.strategy_reasoning if strategy_sel else "LLM-only routing"
                    use_orchestrator = strategy_sel.use_orchestrator if strategy_sel else False

                    # Extract routing tier from strategy selection
                    _routing_tier = getattr(strategy_sel, "routing_tier", None) if strategy_sel else None
                    _routing_tier_name = getattr(strategy_sel, "routing_tier_name", None) if strategy_sel else None

                    _agentic_latency_ms = int((time.time() - _agentic_start_time) * 1000)
                    # Persist the resolved prompt variant alongside
                    # the strategy choice so the admin Data Inspector can
                    # slice by variant. Variant is computed the same way
                    # process_chat_request_base does it for synthesis.
                    _prompt_variant: str | None = None
                    try:
                        from src.main.service.rag.prompt_variants import (
                            resolve_prompt_variant,
                        )

                        _prompt_variant = resolve_prompt_variant(strategy_sel.query_characteristics if strategy_sel else None)
                    except Exception as e:
                        logger.debug("prompt_variant resolution skipped: %s", e)

                    asyncio.create_task(
                        persist_rag_trace(
                            db_session_factory=SessionLocal,
                            session_id=UUID(raw_session),
                            user_id=UUID(user_id),
                            query=request.prompt,
                            selected_strategy=selected_strategy,
                            strategy_type="orchestrator" if use_orchestrator else "strategy",
                            mode="agentic",
                            confidence=strategy_confidence,
                            reasoning=strategy_reasoning,
                            query_characteristics=query_chars,
                            selected_orchestrator=selected_strategy if use_orchestrator else None,
                            graph_traversal_stats=None,  # Agentic RAG uses tool-based agent, not tri-modal orchestrator
                            latency_ms=_agentic_latency_ms,
                            routing_tier=_routing_tier,
                            routing_tier_name=_routing_tier_name,
                            prompt_variant=_prompt_variant,
                        )
                    )
                except Exception as trace_err:
                    logger.debug("Failed to dispatch RAG trace persistence: %s", str(trace_err))

            # Decide execution path based on source selection
            source_selection = orchestration_result.source_selection

            # Normalize primary_sources: LLM may return collection names instead of "documents"
            # Any source that isn't "web" or "llm" is treated as a document source
            normalized_sources = []
            has_document_source = False
            for src in source_selection.primary_sources:
                src_lower = src.lower().strip()
                if src_lower in ("web", "llm"):
                    normalized_sources.append(src_lower)
                else:
                    has_document_source = True
                    if "documents" not in normalized_sources:
                        normalized_sources.append("documents")
            if has_document_source:
                logger.info("Normalized primary_sources %s -> %s", source_selection.primary_sources, normalized_sources)
                source_selection.primary_sources = normalized_sources

            # If documents are selected, proceed with document RAG (strategy_selection may be None if strategy router errored)
            if "documents" in source_selection.primary_sources and effective_collection_ids:
                # Grep activation Trigger 2: extract author_names from
                # the strategy router's QueryCharacteristics so _process_document_rag
                # can resolve them to document_ids and prefer grep over dense.
                _author_names: list[str] = []
                try:
                    _sr = orchestration_result.strategy_selection
                    if _sr is not None and getattr(_sr, "query_characteristics", None) is not None:
                        _author_names = list(getattr(_sr.query_characteristics, "author_names", []) or [])
                except Exception as e:
                    logger.debug("author_names extraction skipped: %s", e)

                _selected_strategy = orchestration_result.strategy_selection.selected_strategy if orchestration_result.strategy_selection else None
                _query_intent = getattr(orchestration_result.query_analysis, "intent", None) if orchestration_result.query_analysis else None
                async for packet in _process_document_rag(
                    request=request,
                    emitter=emitter,
                    main_instance=main_instance,
                    subscription_tier=subscription_tier,
                    db=db,
                    user_id=user_id,
                    assistant_message_id=assistant_message_id,
                    effective_collection_ids=effective_collection_ids,
                    author_names=_author_names,
                    selected_strategy=_selected_strategy,
                    query_intent=_query_intent,
                ):
                    yield packet

            else:
                # Handle other source selections (web, direct LLM, or fallback with intent-aware RAG)
                async for packet in _process_non_document_sources(
                    request=request,
                    emitter=emitter,
                    current_user=current_user,
                    source_selection=source_selection,
                    orchestration_result=orchestration_result,
                    result=result,
                    main_instance=main_instance,
                    subscription_tier=subscription_tier,
                    db=db,
                    assistant_message_id=assistant_message_id,
                ):
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
    """Process document-based RAG using tool-based agent.

    Grep activation: when `request.document_ids` is non-empty
    (Trigger 1 — user @-mentioned) OR `author_names` resolves to one or more
    documents (Trigger 2 — author-scoped), `deps.grep_preferred` is set True
    and the resolved scope is merged into `deps.document_ids` so grep_search /
    cat_document fire against the right slice of `documents.content`.
    """
    from src.main.service.agents.rag_agents.tool_based_rag_agent import create_rag_agent
    from src.main.service.agents.tools.base import RAGToolDependencies
    from src.main.service.retriever.retriever_manager import retriever_manager
    from src.main.utils.llm.agent_model_utils import get_system_agent_model

    _doc_rag_start = time.monotonic()

    # Fetch document summaries for context enhancement
    document_summaries = {}
    try:
        from sqlmodel import select

        from src.main.models.sqlmodel_models import Document, DocumentSummary

        # Get all documents in the selected collections
        if request.document_ids:
            # Use specific document IDs if provided
            doc_ids_to_summarize = [uuid.UUID(str(doc_id)) for doc_id in request.document_ids]
        else:
            # Get all documents from selected collections
            # noinspection PyUnresolvedReferences
            docs_query = select(Document.id).where(Document.collection_id.in_(effective_collection_ids))
            doc_results = db.exec(docs_query).all()
            doc_ids_to_summarize = [doc_id for doc_id in doc_results]

        # Fetch book summaries for these documents
        if doc_ids_to_summarize:
            summaries_query = (
                select(DocumentSummary)
                # noinspection PyUnresolvedReferences
                .where(DocumentSummary.document_id.in_(doc_ids_to_summarize))
                .where(DocumentSummary.summary_type == "book")
            )
            summaries = db.exec(summaries_query).all()

            for summary in summaries:
                # Get document info
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

    # Get the model for document-based RAG
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
            "Failed to get LLM for agentic RAG: %s (Provider: %s)",
            request.model_name,
            request.provider_type,
        )
        error_content = f"Failed to initialize LLM for agentic RAG: {request.model_name}"
        yield emitter.emit_error(
            error_content,
            error_code=ErrorCode.SERVICE_UNAVAILABLE.value,
        )
        duration_ms = int((time.monotonic() - _doc_rag_start) * 1000)
        yield emitter.emit_stream_end(reason="error", duration_ms=duration_ms)
        return

    # Resolve the strategy preset up-front: it decides which optional tool
    # categories the agent gets, AND therefore which retrievers we must pay to
    # initialize. graph_search lives in the 'context' category, so neo4j is only
    # needed when 'context' is requested.
    from src.main.service.rag.strategy_presets import get_strategy_preset

    strategy_preset = get_strategy_preset(selected_strategy)
    _tool_categories = strategy_preset.get("tool_categories") or []
    logger.info(
        "Strategy preset for '%s': categories=%s",
        selected_strategy or "(default)",
        _tool_categories,
    )

    # Use tool-based RAG agent with ExecutionPlan architecture
    # Get pgvector retriever for vector search tools
    retriever = await retriever_manager.get_retriever(
        user_id=str(user_id),
        retriever_type="pgvector",
    )

    # Get neo4j retriever ONLY when the strategy can call graph_search (the
    # 'context' category). A cold neo4j init costs ~14s (driver handshake +
    # reasoning-model load), so for pure 'query' strategies (RAGMultiQuery,
    # RAGDecomposition, …) we skip it entirely and keep it off the critical path.
    graph_retriever = None
    if "context" in _tool_categories:
        try:
            graph_retriever = await retriever_manager.get_retriever(
                user_id=str(user_id),
                retriever_type="neo4j",
            )
        except Exception as e:
            logger.debug("Neo4j retriever not available: %s", str(e))
    else:
        logger.info(
            "Skipping neo4j retriever init — strategy '%s' has no graph tools",
            selected_strategy or "(default)",
        )

    # Get system-configured agent model (from config.yaml, not user's chat model)
    agent_config = get_system_agent_model(agent_type="agentic_rag")
    model = agent_config.get_pydantic_ai_model()

    # Delegation path: when the QueryAnalyzer semantically flags the query as a
    # comparison, fan out one subagent per book in parallel and synthesize,
    # instead of one tool-agent. Only for multi-collection-capable document RAG;
    # the orchestrator degrades gracefully to a single-book summary if <2 books
    # are actually in scope.
    # The QueryAnalyzer labels intent freely ("compare", "Comparison", "comparing",
    # …); normalize its OWN semantic label rather than keyword-matching the query.
    _is_comparison = bool(query_intent) and query_intent.strip().lower().startswith("compar")
    if _is_comparison and effective_collection_ids:
        from src.main.service.rag.orchestrators.cross_book_comparison import cross_book_comparison_stream

        logger.info("Routing to cross-book comparison (intent=%s, %d collections)", query_intent, len(effective_collection_ids))
        async for _pkt in cross_book_comparison_stream(
            query=request.prompt,
            collection_ids=list(effective_collection_ids),
            user_id=str(user_id),
            db=db,
            emitter=emitter,
            retriever=retriever,
            model=model,
        ):
            yield _pkt
        return

    # Create tool-based RAG agent with dynamic tool filtering
    # Pass query for semantic tool selection (~8-12 tools instead of 24).
    # Pass UI language so the agent answers in the user's locale even when the
    # question or sources are English (otherwise hr/de/es users see English).
    # Pass user's response_length preference (from settings_general) so prompt
    # instructs the model to write short / medium / long answers.
    # Pass rag_augmentation so the agent knows whether it may add a labeled
    # general-knowledge paragraph alongside the cited content.
    response_length = _read_response_length(db, str(user_id))
    rag_augmentation = _read_rag_augmentation(db, str(user_id))
    # Settings → Prompts → Custom Templates: the chat toolbar popover
    # injects the picked template's name into request.metadata. Forward
    # to create_rag_agent so Layer 6 of the system-prompt chain can
    # resolve the template body.
    prompt_template_name: str | None = None
    if request.metadata and isinstance(request.metadata, dict):
        raw = request.metadata.get("prompt_template_name")
        if isinstance(raw, str) and raw.strip():
            prompt_template_name = raw.strip()
    # Option-2 unification: the router's chosen strategy is a PRESET (resolved
    # above) that configures the single shared tool-agent — which optional tool
    # categories it gets + a one-line posture nudge.
    rag_agent = create_rag_agent(
        model=model,
        query=request.prompt,
        language=request.language,
        response_length=response_length,
        rag_augmentation=rag_augmentation,
        # Pass the effective collection scope so the
        # agent's system prompt can be layered with per-collection
        # custom_instructions read from collection_workspace_map.
        collection_ids=effective_collection_ids,
        db=db,
        user_id=str(user_id),
        prompt_template_name=prompt_template_name,
        strategy_preset=strategy_preset,
    )

    # Grep activation — resolve author-scoped document scope and merge
    # with the @-mention scope before constructing deps.
    base_document_ids: list = list(request.document_ids) if request.document_ids else []
    grep_preferred = bool(base_document_ids)
    if author_names:
        try:
            from src.main.service.agents.tools.grep_tools import (
                resolve_authors_to_document_ids,
            )

            resolved_author_doc_ids = resolve_authors_to_document_ids(
                db=db,
                user_id=str(user_id),
                author_names=author_names,
                collection_ids=effective_collection_ids,
            )
            if resolved_author_doc_ids:
                existing = {str(d) for d in base_document_ids}
                base_document_ids = base_document_ids + [d for d in resolved_author_doc_ids if d not in existing]
                grep_preferred = True
                logger.info(
                    "grep activation: author_names=%s resolved to %d docs (total scope=%d)",
                    author_names,
                    len(resolved_author_doc_ids),
                    len(base_document_ids),
                )
            else:
                logger.info(
                    "grep activation: author_names=%s resolved to 0 docs — falling through to default routing",
                    author_names,
                )
        except Exception as e:
            logger.warning("Author resolution failed; continuing without grep activation: %s", e)

    # Pull document_hierarchy for any tagged docs — gives the agent a
    # navigable chapter map alongside the summary blurbs. Agent uses it
    # to drive cat_document(start, end) extracts when the user asks
    # about a specific section, chapter title, or topic location.
    document_hierarchies: dict = {}
    if base_document_ids:
        try:
            from src.main.models.sqlmodel_models import Document

            for doc_id in base_document_ids:
                doc_row = db.get(Document, uuid.UUID(str(doc_id)))
                if doc_row and getattr(doc_row, "document_hierarchy", None):
                    document_hierarchies[str(doc_id)] = doc_row.document_hierarchy
        except Exception as e:
            logger.warning("Could not load document_hierarchy for tagged docs: %s", e)

    metadata: dict = {}
    if document_summaries:
        metadata["document_summaries"] = document_summaries
    if document_hierarchies:
        metadata["document_hierarchies"] = document_hierarchies

    # Prepare dependencies with both retrievers and document summaries
    deps = RAGToolDependencies(
        retriever=retriever,
        llm=orchestrator_llm,
        collection_ids=effective_collection_ids,
        document_ids=base_document_ids if base_document_ids else None,
        user_id=str(user_id),
        emitter=emitter,
        db=db,
        # Workspace scope lets inventory tools (list_collections/list_documents)
        # resolve what the user can access for "what books do I have?" questions.
        # Agentic RAG always sets request.workspace_id upstream (it bails out
        # otherwise), so this is reliably populated on this path.
        workspace_id=str(request.workspace_id) if getattr(request, "workspace_id", None) else None,
        graph_retriever=graph_retriever,
        metadata=metadata,
        grep_preferred=grep_preferred,
        # Propagate the gRPC session id so file-artifact delivery
        # can scope artifacts per chat turn. ChatRequest.session_id arrives
        # as "userId:sessionId"; we keep the composite as-is for the store key.
        session_id=getattr(request, "session_id", None) or None,
    )

    # Enrich prompt with document context when user @-tagged specific documents
    enriched_prompt = request.prompt
    if request.document_ids:
        doc_context_parts = []
        if document_summaries:
            for summary_info in document_summaries.values():
                doc_context_parts.append(f"- {summary_info['title']}")
        else:
            # Fallback: look up document filenames from DB
            from src.main.models.sqlmodel_models import Document

            for doc_id in request.document_ids:
                doc = db.get(Document, uuid.UUID(str(doc_id)))
                if doc:
                    doc_context_parts.append(f"- {doc.title or doc.filename}")
        if doc_context_parts:
            doc_list = "\n".join(doc_context_parts)
            hierarchy_hint = (
                " A `document_hierarchies` map is available in the deps metadata — use it to "
                "locate chapter/section ranges before calling `cat_document(start, end)`."
                if document_hierarchies
                else ""
            )
            enriched_prompt = (
                f"[User explicitly tagged these documents: {doc_list}]\n"
                f"Lexical tools (grep_search, cat_document) are PREFERRED for this scope. "
                f"Run grep_search(pattern, document_ids=deps.document_ids) first for any literal "
                f"token, name, number, quoted phrase, or verbatim identifier in the question — "
                f"it is millisecond-fast against a 1-3 document subset and the surrounding text "
                f"window beats dense_search chunks for narrative answers. Use cat_document for "
                f"long contiguous passages (chapters, sections).{hierarchy_hint} "
                f"Fall back to dense_search only for pure synthesis questions "
                f"('summarize the author's argument…').\n\n"
                f"{request.prompt}"
            )
            logger.info(
                "Enriched prompt with %d tagged document(s), grep_preferred=%s, hierarchies=%d",
                len(doc_context_parts),
                grep_preferred,
                len(document_hierarchies),
            )

    # Prepend prior-conversation context so follow-ups ("continue on this
    # topic") keep the thread — the agentic path otherwise ignores history.
    conversation_prefix = _build_conversation_prefix(request)
    if conversation_prefix:
        enriched_prompt = f"{conversation_prefix}\n\n### Current Question:\n{enriched_prompt}"

    # Run agent with streaming and citation processing
    from src.main.service.streaming.citation_processor import StreamingCitationProcessor

    citation_processor = None

    # Attach the user's enabled MCP integrations as additional toolsets for this
    # turn — the agent gains each remote server's tools. Empty when the user has
    # none enabled; per-server failures are logged and skipped (never break chat).
    from src.main.service.agents.mcp_toolsets import build_mcp_toolsets

    mcp_toolsets = build_mcp_toolsets(db, user_id)

    # The agentic emitter runs in buffer_mode (set by GenerateAgenticRAG), so
    # every emit() is appended to emitter.buffer. The retrieval tools
    # (dense_search, sparse_search, reranker) already emit live progress through
    # deps.emitter — but nothing DRAINED that buffer during the agent run, so the
    # progress was lost and the UI sat frozen for the whole ~retrieval+rerank
    # phase. Run the agent in a background task and forward buffered packets in
    # real time so tool progress and answer tokens stream as they happen.
    if emitter.buffer is None:  # defensive: make the drain work for any caller
        emitter.buffer_mode = True
        emitter.buffer = []

    async def _produce() -> None:
        nonlocal citation_processor
        message_started = False

        async def _run_agent_stream(prompt_text: str) -> bool:
            """Stream ONE agent run. Returns True if it produced answer text.

            Shared by the first attempt and the forced-tool retry below, so both
            init the citation processor (once retrieval has populated
            ``deps.retrieved_documents``), emit a single message_start, and track
            usage identically.
            """
            nonlocal citation_processor, message_started
            produced = False
            async with rag_agent.run_stream(prompt_text, deps=deps, toolsets=mcp_toolsets or None) as result:
                async for text in result.stream_text(delta=True):
                    if not text:
                        continue
                    # message_start once before the first answer token, for protocol
                    # parity with the llm/direct path.
                    if not message_started:
                        emitter.emit_message_start()
                        message_started = True
                    # Initialize citation processor on first text token AFTER tools ran.
                    if citation_processor is None and deps.retrieved_documents:
                        # Use the FULL retrieved list IN ORDER — the model numbers
                        # its [n] markers against the sources it actually saw (the
                        # ranked tool results, one entry per retrieved chunk), so
                        # the processor must validate against the SAME list. The
                        # old dedup-by-document_id shrank max_citation_num below the
                        # model's range, so legitimate high markers like [12]/[13]
                        # were rejected as "Invalid citation number" and the
                        # citation was silently dropped (the claim stayed,
                        # ungrounded). Snapshot it — the list is stable once tools
                        # have run for this answer.
                        context_docs = list(deps.retrieved_documents)
                        citation_processor = StreamingCitationProcessor(
                            context_docs=context_docs,
                            max_citation_num=len(context_docs),
                            user_query=request.prompt,
                        )
                        emitter.emit_citation_start()
                        logger.info("Initialized citation processor with %d retrieved sources for agentic RAG", len(context_docs))

                    produced = True

                    if citation_processor:
                        display_text, citations = citation_processor.process_token(text)
                        for citation in citations:
                            emitter.emit(citation)
                        if display_text:
                            emitter.emit_message_delta(display_text)
                    else:
                        emitter.emit_message_delta(text)

                # Fallback: stream_text() yielded nothing (tools-only run).
                if not produced:
                    try:
                        final_output = await result.get_output()
                        if final_output:
                            if not message_started:
                                emitter.emit_message_start()
                                message_started = True
                            emitter.emit_message_delta(str(final_output))
                            produced = True
                    except Exception as fallback_err:
                        logger.warning("Could not get agent result output: %s", str(fallback_err))

                from src.main.utils.llm.usage_tracker import track_stream_usage

                track_stream_usage(result, agent_type="agentic_rag", model=agent_config.get_pydantic_ai_model_string())
            return produced

        produced = await _run_agent_stream(enriched_prompt)

        # Anti-"preamble-only" guard. The model sometimes ends its turn with just
        # a plan ("Prvo da provjerim koje knjige imaš … pa ću potražiti") and
        # NEVER calls a retrieval tool — so deps.retrieved_documents is empty, no
        # citation processor was created, and the user gets an ungrounded
        # non-answer. In the document path retrieval is mandatory, so re-run ONCE
        # with a hard nudge; the grounded answer continues after the short
        # preamble. (tools-only runs set citation_processor/retrieved_documents,
        # so this never fires on a legitimately-grounded reply.)
        if produced and citation_processor is None and not deps.retrieved_documents:
            logger.warning("Agentic RAG produced an answer with ZERO retrieval (preamble-only); retrying with forced tool use")
            emitter.emit_message_delta("\n\n")
            forced_prompt = (
                enriched_prompt + "\n\nCRITICAL: Do NOT answer with only a plan or an 'I will check / "
                "let me search' preamble. In THIS turn you MUST call the retrieval "
                "tools and then answer strictly from the retrieved sources, with "
                "inline [n] citations."
            )
            await _run_agent_stream(forced_prompt)

        # Flush remaining citation buffer (after the final run completes).
        if citation_processor:
            final_text, final_citations = citation_processor.flush()
            for citation in final_citations:
                emitter.emit(citation)
            if final_text:
                emitter.emit_message_delta(final_text)

            # Fallback (C): no inline [N] markers — attribute top docs as
            # document-level citations so the answer is still grounded.
            for citation in citation_processor.fallback_cite_top_docs():
                emitter.emit(citation)

            # Smart Citations (Scite): re-emit with stance classification.
            try:
                updated_citations = await citation_processor.classify_stance_batch()
                for citation in updated_citations:
                    emitter.emit(citation)
            except Exception as stance_err:
                logger.warning("Stance classification skipped: %s", stance_err)

        # Chart data packet (agent called generate_chart()).
        if deps.chart_data:
            from src.main.dto.streaming import ChartDataPacket

            chart = deps.chart_data
            # noinspection PyTypeChecker
            emitter.emit(
                ChartDataPacket(
                    chart_type=chart.get("chart_type", "bar"),
                    title=chart.get("title", ""),
                    labels=chart.get("labels", []),
                    datasets=chart.get("datasets", []),
                    x_label=chart.get("x_label", ""),
                    y_label=chart.get("y_label", ""),
                )
            )
            logger.info("Emitted ChartDataPacket: type=%s, title=%s", chart.get("chart_type"), chart.get("title"))

        duration_ms = int((time.monotonic() - _doc_rag_start) * 1000)
        from src.main.service.llm.token_metrics_callback import extract_token_metrics_from_llm

        token_metrics = extract_token_metrics_from_llm(orchestrator_llm)
        emitter.emit_stream_end(reason="completed", duration_ms=duration_ms, **token_metrics)
        logger.info("Tool-based agentic RAG completed in %dms", duration_ms)

    # Drop packets already streamed by the caller (orchestration narration, setup
    # status) so the drain starts clean, then forward buffered packets as the
    # background agent produces them.
    emitter.buffer.clear()
    producer = asyncio.create_task(_produce())

    # Heartbeat narration: each retrieval/rerank/synthesis tool emits a status at
    # its START but nothing during the multi-second await, so the panel froze on
    # one line for tens of seconds. The event loop stays free during those awaits
    # (verified: websocket heartbeats keep ticking), so we emit a rotating "still
    # working" reasoning line every few seconds of silence. Buffered like any
    # other packet → drained on the next pop.
    _hb_hr = [
        "Pretražujem tvoju knjižnicu po sadržaju…",
        "Probiram najrelevantnije odlomke…",
        "Rangiram pronađene izvore po važnosti…",
        "Slažem odgovor i povezujem citate…",
    ]
    _hb_en = [
        "Searching your library by content…",
        "Selecting the most relevant passages…",
        "Ranking the retrieved sources by relevance…",
        "Composing the answer and linking citations…",
    ]
    _hb_idx = 0
    _heartbeat_s = 6.0
    _last_packet_at = time.monotonic()
    try:
        while True:
            drained_any = False
            while emitter.buffer:
                yield emitter.buffer.pop(0)
                drained_any = True
            if drained_any:
                _last_packet_at = time.monotonic()
            if producer.done():
                break
            # Phase phrases tick at the base cadence; the neutral filler that
            # follows ticks more slowly so a long wait doesn't pile up lines.
            _hb_threshold = _heartbeat_s if _hb_idx < len(_hb_hr) else 15.0
            if time.monotonic() - _last_packet_at >= _hb_threshold:
                # Show each phase phrase AT MOST ONCE; cycling them modulo-N
                # re-printed the same "Searching… Selecting… Ranking… Composing…"
                # block over and over (and falsely claimed "Composing" while still
                # searching). Once the four are shown, fall back to a neutral
                # elapsed-time tick — distinct every time, so it conveys progress
                # without duplicating the phase narration.
                if _hb_idx < len(_hb_hr):
                    _narrate(emitter, request.language, _hb_hr[_hb_idx], _hb_en[_hb_idx])
                else:
                    _elapsed_s = int(time.monotonic() - _doc_rag_start)
                    _narrate(
                        emitter,
                        request.language,
                        f"Još radim na tvom odgovoru… ({_elapsed_s} s)",
                        f"Still working on your answer… ({_elapsed_s}s)",
                    )
                _hb_idx += 1
                _last_packet_at = time.monotonic()
            await asyncio.sleep(0.05)
        while emitter.buffer:
            yield emitter.buffer.pop(0)
        await producer  # surface any exception raised inside the agent run
    except asyncio.CancelledError:
        producer.cancel()
        try:
            await producer
        except asyncio.CancelledError:
            pass
        raise


async def _process_non_document_sources(
    request: ChatRequest,
    emitter: PacketEmitter,
    current_user: User,
    source_selection: Any,
    orchestration_result: Any,
    result: AgenticRAGResult,
    main_instance: Any = None,
    subscription_tier: str = "free",
    db: Any = None,
    assistant_message_id: Any = None,
) -> AsyncGenerator[str, None]:
    """Process non-document sources (web, direct LLM, or fallback)."""
    # Check if agent decided to use direct LLM or web (no documents)
    if "documents" not in source_selection.primary_sources:
        selected_sources = source_selection.primary_sources
        is_web = "web" in selected_sources

        if is_web and main_instance and db:
            # Route to web search
            logger.info("Agent selected web search: %s", selected_sources)

            yield emitter.emit_status(
                StructuredStatusCode.intelligent_routing(*selected_sources, "web_search"),
                stage=StatusCode.SOURCE_ROUTING.value,
            )

            from src.main.service.chat.chat_web_search import process_web_search

            cancellation_event = asyncio.Event()
            # noinspection PyTypeChecker
            async for packet in process_web_search(
                request=request,
                emitter=emitter,
                main_instance=main_instance,
                subscription_tier=subscription_tier,
                db=db,
                user_id=str(current_user.id),
                _assistant_message_id=assistant_message_id,
                cancellation_event=cancellation_event,
            ):
                yield packet
        elif is_web:
            # Web search selected but missing dependencies, fall back to LLM
            logger.warning("Agent selected web search but missing main_instance/db. Falling back to direct LLM.")

            yield emitter.emit_status(
                StructuredStatusCode.intelligent_routing(*selected_sources, "web_fallback_llm"),
                stage=StatusCode.SOURCE_ROUTING.value,
            )

            from src.main.service.rag.rag_utils import process_direct_llm_chat

            async for packet in process_direct_llm_chat(request, current_user.id, emitter):
                yield packet
        else:
            # Direct LLM — but check if query needs tool calling (e.g., chart generation)
            logger.info("Agent selected direct LLM chat (no RAG needed): %s", selected_sources)

            # Check for chart intent — route through tool-based agent for tool calling
            chart_keywords = {
                "chart",
                "graph",
                "plot",
                "visualize",
                "visualise",
                "visualization",
                "bar chart",
                "line chart",
                "pie chart",
                "scatter",
                "diagram",
                "trend",
                "compare visually",
                "show me a chart",
                "draw",
            }
            query_lower = request.prompt.lower()
            has_chart_intent = any(kw in query_lower for kw in chart_keywords)

            if has_chart_intent:
                logger.info("Chart intent detected in direct LLM path, routing through tool-based agent")
                async for packet in _process_chart_only_agent(
                    request=request,
                    emitter=emitter,
                    _main_instance=main_instance,
                    db=db,
                    user_id=str(current_user.id),
                ):
                    yield packet
            else:
                yield emitter.emit_status(
                    StructuredStatusCode.intelligent_routing(*selected_sources, "direct_llm"),
                    stage=StatusCode.SOURCE_ROUTING.value,
                )

                from src.main.service.rag.rag_utils import process_direct_llm_chat

                async for packet in process_direct_llm_chat(request, current_user.id, emitter):
                    yield packet

    else:
        # 'documents' was selected but the caller routed here because there is
        # NO document scope to search — effective_collection_ids was empty (see
        # the `and effective_collection_ids` guard at the _process_document_rag
        # call site). This happens when the user's active workspace holds no
        # collections (e.g. a fresh "My Workspace", or shared workspaces they
        # haven't switched into).
        #
        # This branch used to only stage `result.agentic_strategy_info` and
        # yield NOTHING, on the assumption that traditional document RAG runs
        # afterwards. Nothing downstream consumes that info, so the stream ended
        # with no answer at all and the UI recorded a `streamingError`. Always
        # produce a response instead: the direct-LLM path (web supplement +
        # model insight + direct answer) is exactly the no-collection flow.
        logger.info(
            "Documents selected but no collections in scope (%s); routing to direct LLM chat",
            source_selection.primary_sources,
        )
        yield emitter.emit_status(
            StructuredStatusCode.intelligent_routing(*source_selection.primary_sources, "direct_llm"),
            stage=StatusCode.SOURCE_ROUTING.value,
        )

        from src.main.service.rag.rag_utils import process_direct_llm_chat

        async for packet in process_direct_llm_chat(request, current_user.id, emitter):
            yield packet


async def _process_chart_only_agent(
    request: ChatRequest,
    emitter: PacketEmitter,
    _main_instance: Any,
    db: Any,
    user_id: str,
) -> AsyncGenerator[str, None]:
    """Run a lightweight tool-based agent with only chart generation tool.

    Used when query has chart intent but no document collections are selected.
    The agent uses the system-configured model (not user's chat model) for reliable tool calling.
    """
    from pydantic_ai import Agent
    from pydantic_ai.toolsets import FunctionToolset

    from src.main.service.agents.tools.base import RAGToolDependencies
    from src.main.service.agents.tools.chart_generation_tools import generate_chart
    from src.main.utils.llm.agent_model_utils import get_system_agent_model

    # Use user's chat model from request (system agent model may be quota-exhausted)
    # noinspection PyBroadException
    try:
        model_str = f"{request.provider_type}:{request.model_name}" if request.provider_type and request.model_name else None
        if not model_str:
            agent_config = get_system_agent_model(agent_type="agentic_rag")
            model = agent_config.get_pydantic_ai_model()
        else:
            from pydantic_ai.models import infer_model

            model = infer_model(model_str)
    except Exception:
        agent_config = get_system_agent_model(agent_type="agentic_rag")
        model = agent_config.get_pydantic_ai_model()

    chart_toolset = FunctionToolset(tools=[generate_chart])
    lang_code = request.language or "en"
    lang_names = {"hr": "Croatian", "en": "English", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian"}
    lang_name = lang_names.get(lang_code, lang_code)
    lang_instruction = f" Always respond in {lang_name}." if lang_code != "en" else ""
    agent = Agent(
        model=model,
        deps_type=RAGToolDependencies,
        system_prompt=(
            "You are a data visualization assistant. When the user asks for a chart, "
            "extract or generate the data and call the generate_chart tool. "
            "Always call the tool — never just describe the chart in text."
            f"{lang_instruction}"
        ),
        toolsets=[chart_toolset],
    )

    deps = RAGToolDependencies(
        retriever=None,
        llm=None,
        collection_ids=[],
        user_id=user_id,
        emitter=emitter,
        db=db,
    )

    _start = time.monotonic()
    has_content = False

    # Carry prior-conversation context into chart follow-ups ("make it a bar
    # chart instead", "now show it by year") so they aren't context-blind.
    chart_prefix = _build_conversation_prefix(request)
    chart_prompt = f"{chart_prefix}\n\n### Current Question:\n{request.prompt}" if chart_prefix else request.prompt

    async with agent.run_stream(chart_prompt, deps=deps) as result:
        async for text_chunk in result.stream_text(delta=True):
            if text_chunk:
                if not has_content:
                    yield emitter.emit_message_start()
                has_content = True
                yield emitter.emit_message_delta(text_chunk)

        if not has_content:
            try:
                final_output = result.output
                if final_output:
                    yield emitter.emit_message_start()
                    yield emitter.emit_message_delta(str(final_output))
            except Exception as e:
                logger.debug("Suppressed exception: %s", e)

    # Emit chart data if agent called generate_chart()
    if deps.chart_data:
        from src.main.dto.streaming import ChartDataPacket

        chart = deps.chart_data
        # noinspection PyTypeChecker
        yield emitter.emit(
            ChartDataPacket(
                chart_type=chart.get("chart_type", "bar"),
                title=chart.get("title", ""),
                labels=chart.get("labels", []),
                datasets=chart.get("datasets", []),
                x_label=chart.get("x_label", ""),
                y_label=chart.get("y_label", ""),
            )
        )
        logger.info("Emitted ChartDataPacket from chart-only agent: %s", chart.get("title"))

    duration_ms = int((time.monotonic() - _start) * 1000)
    yield emitter.emit_stream_end(reason="completed", duration_ms=duration_ms)
    logger.info("Chart-only agent completed in %dms", duration_ms)
