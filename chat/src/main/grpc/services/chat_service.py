"""
ChatService gRPC Implementation

Implements the ChatService defined in chat.proto (v3.0.0).
Each RPC calls service-layer functions directly (not FastAPI controllers).
Kotlin owns orchestration; Python owns AI/ML execution.
"""

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime
import inspect
import json
import time
from uuid import UUID

import grpc
from sqlalchemy import text

from src.main.grpc import chat_pb2, chat_pb2_grpc, common_pb2
from src.main.grpc.grpc_utils import build_grpc_user_dto, grpc_sqlmodel_session
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def _create_timestamp():
    now = datetime.now(UTC)
    return common_pb2.Timestamp(seconds=int(now.timestamp()), nanos=now.microsecond * 1000)


async def _fetch_web_context(query: str, max_results: int = 5, timeout: float = 10.0) -> str:
    """Fetch lightweight web search snippets for hybrid RAG+web mode.

    Uses the configured search provider (DuckDuckGo by default) to get
    web snippets without LLM synthesis. Returns formatted context string
    or empty string on failure (graceful degradation).

    Args:
        query: Search query
        max_results: Maximum number of results to fetch
        timeout: Timeout in seconds

    Returns:
        Formatted web context string, or empty string on failure
    """
    try:
        from src.main.service.web_search.search_provider_factory import SearchProviderFactory

        provider = SearchProviderFactory.get_provider()
        results = await asyncio.wait_for(provider.search(query), timeout=timeout)

        if not results:
            return ""

        snippets = []
        for r in results[:max_results]:
            snippets.append(f"[{r.title}]({r.link}): {r.snippet}")

        return "\n\n---\nWeb Search Context:\n" + "\n".join(snippets) + "\n---\n"

    except TimeoutError:
        logger.warning("Web search timeout after %.1fs, continuing without web context", timeout)
        return ""
    except Exception as e:
        logger.warning("Web search failed, continuing without web context: %s", str(e))
        return ""


# noinspection PyUnresolvedReferences
async def _stream_packets(async_gen, _context, counter=None, trace_capture=None) -> AsyncIterator[chat_pb2.ChatResponsePacket]:
    """Convert an async generator of JSON packet strings to gRPC ChatResponsePacket messages.

    Args:
        async_gen: Async generator yielding JSON packet strings
        context: gRPC service context
        counter: Optional shared mutable counter (list with single int element).
                 If provided, the packet index continues from the current value.
                 Pass [0] and reuse across multiple calls for sequential indexing.
        trace_capture: Optional dict to capture trace-relevant data from packets.
                       When not None, stream_end, rag_debug_info, and response_preview
                       are captured for persistent tracing. Zero overhead when None.
    """
    if counter is None:
        counter = [0]
    _preview_parts = []
    _preview_len = 0

    async for packet_str in async_gen:
        if not packet_str or not isinstance(packet_str, str):
            continue
        try:
            packet_data = json.loads(packet_str)
            # Handle both PacketEmitter format {"ind":X,"obj":{...}} and flat format {"type":"...","content":"..."}
            if "obj" in packet_data and isinstance(packet_data["obj"], dict):
                packet_obj = packet_data["obj"]
            else:
                packet_obj = packet_data
            packet_type = packet_obj.get("type", "unknown")

            # Capture trace-relevant packets (zero overhead when trace_capture is None)
            if trace_capture is not None:
                if packet_type == "stream_end":
                    trace_capture["stream_end"] = packet_obj
                elif packet_type == "rag_debug_info":
                    trace_capture["rag_debug_info"] = packet_obj
                elif packet_type == "message_delta" and _preview_len < 500:
                    content = packet_obj.get("content", "")
                    _preview_parts.append(content)
                    _preview_len += len(content)

            yield chat_pb2.ChatResponsePacket(
                type=packet_type,
                index=counter[0],
                data=json.dumps(packet_obj),
                timestamp=_create_timestamp(),
            )
            counter[0] += 1
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            logger.warning("Skipping malformed packet: %s", str(e))
            continue

    # Finalize response preview
    if trace_capture is not None and _preview_parts:
        trace_capture["response_preview"] = "".join(_preview_parts)[:500]


async def _yield_single_message(emitter, msg: str) -> AsyncIterator[str]:
    """7.8 v3 — emit a single user-facing message as one delta + a
    stream_end packet. Used when tutor mode runs against a collection
    without a built curriculum."""
    yield emitter.emit_message_delta(msg)
    yield emitter.emit_stream_end()


async def _yield_tutor_tokens(
    emitter,
    db,
    user_id,
    curriculum_id,
    user_message: str,
    locale: str,
) -> AsyncIterator[str]:
    """7.8 v3 — bridge the tutor orchestrator's plain-string token
    stream into PacketEmitter message_delta + stream_end packets so
    the existing chat UI renders tutor output without changes."""
    from src.main.service.tutor.tutor_orchestrator import run_tutor_turn

    async for token in run_tutor_turn(
        db,
        user_id=user_id,
        curriculum_id=curriculum_id,
        user_message=user_message,
        locale=locale,
    ):
        yield emitter.emit_message_delta(token)
    yield emitter.emit_stream_end()


def _apply_thought_partner_prepend(prompt: str, request) -> str:
    """7.7 — replace the user's prompt with a Thought Partner system
    block + their query so the LLM responds with 3-5 numbered probing
    questions instead of answering. Used by GenerateDirectLLM only;
    thought partner intentionally skips retrieval (context-light).

    Returns the original prompt unchanged when thought_partner_mode is
    off or the prompt block is missing — degrade open.
    """
    if not getattr(request, "thought_partner_mode", False):
        return prompt
    from src.main.utils.config.loader import resolved_prompts as _all_prompts

    tp_prepend = (_all_prompts.get("modes", {}) or {}).get("thought_partner", "")
    if not tp_prepend:
        return prompt
    logger.info("Thought Partner mode active — replaced prompt with TP system block")
    return f"{tp_prepend.rstrip()}\n\nUser query: {prompt}"


def _apply_tutor_prepend(prompt: str, request) -> str:
    """7.8 v2 — wrap a chat prompt with the Socratic-tutor instruction
    block from prompts.yaml's `modes.tutor` section.

    Used by every chat path that wants to honor `tutor_mode` —
    GenerateRAG, GenerateAgenticRAG, GenerateDirectLLM,
    GenerateWebSearch — so the user's mode flag works regardless of
    which orchestrator the Kotlin router picked. v1 only wired this in
    GenerateRAG, which silently broke for users with
    `agentic_rag_enabled=true` in their general settings.

    Returns the original prompt unchanged when tutor_mode is off or the
    prompt block is missing from prompts.yaml — degrade open.
    """
    if not getattr(request, "tutor_mode", False):
        return prompt
    from src.main.utils.config.loader import resolved_prompts as _all_prompts

    tutor_prepend = (_all_prompts.get("modes", {}) or {}).get("tutor", "")
    if not tutor_prepend:
        return prompt
    logger.info("Tutor mode active — prepended Socratic instructions")
    return f"{tutor_prepend.rstrip()}\n\nUser question: {prompt}"


def _resolve_saved_search_ids(saved_search_ids, user_id) -> list:
    """Evaluate saved searches and return deduplicated document IDs."""
    if not saved_search_ids:
        return []
    # noinspection PyUnresolvedReferences
    from src.main.config.db_config import grpc_db_session
    from src.main.service.search.saved_search_service import evaluate_saved_search

    doc_ids = set()
    with grpc_db_session() as db:
        for ss_id in saved_search_ids:
            try:
                doc_ids.update(evaluate_saved_search(db, ss_id, user_id))
            except Exception as e:
                logger.warning("Failed to evaluate saved search %s: %s", ss_id, e)
    return list(doc_ids)


# noinspection PyUnusedLocal
def _resolve_user_language(user_id) -> str | None:
    """Read the user's stored UI language (``user_settings.settings_general.language``).

    This is the AUTHORITATIVE answer language: it must be enforced server-side so
    the model replies in the user's language even when a caller (an API client /
    test) sends a different or default ``language`` — never relying on the UI to
    propagate the locale.
    """
    if not user_id:
        return None
    try:
        from src.main.config.database import SessionLocal
        from src.main.service.user_settings_service import get_user_settings_service

        db = SessionLocal()
        try:
            general = get_user_settings_service(db).get_setting(str(user_id), "settings_general")
            if isinstance(general, dict):
                lang = general.get("language")
                if isinstance(lang, str) and lang.strip():
                    return lang.strip().lower()
        finally:
            db.close()
    except Exception as e:
        logger.debug("Could not resolve user language preference: %s", str(e))
    return None


def _build_chat_request_dto(
    prompt,
    user_id,
    model_name,
    provider_type,
    language="en",
    session_namespace=None,
    subscription_tier="researcher",
    collection_ids=None,
    document_ids=None,
    web_search_enabled=False,
    deep_research_enabled=False,
    research_breadth=4,
    research_depth=2,
    agentic_rag_enabled=False,
    source_preferences=None,
    min_confidence_threshold=0.5,
    max_sources=5,
    similarity_threshold=0.5,
    top_k=15,
    workspace_id=None,
    assistant_message_id=None,
    conversation_history=None,
    is_repeat=False,
    attachments=None,
    metadata=None,
):
    """Build a ChatRequest DTO for Python service functions."""
    from src.main.dto.chat import ChatAttachmentDTO
    from src.main.dto.chat import ChatRequest as ChatRequestDTO

    # The user's stored language preference is authoritative and MANDATORY — it
    # overrides whatever `language` the caller sent (UI, API client, or test), so
    # the model always answers in the user's language.
    language = _resolve_user_language(user_id) or language

    # Convert proto ConversationMessage objects to plain dicts
    history_dicts = []
    for msg in conversation_history or []:
        if isinstance(msg, dict):
            history_dicts.append(msg)
        else:
            history_dicts.append({"role": msg.role, "content": msg.content})

    return ChatRequestDTO(
        prompt=prompt,
        session_id=session_namespace,
        user_id=user_id,
        workspace_id=workspace_id,
        collection_ids=collection_ids or [],
        document_ids=document_ids or [],
        model_name=model_name,
        provider_type=provider_type,
        language=language,
        web_search_enabled=web_search_enabled,
        deep_research_enabled=deep_research_enabled,
        research_breadth=research_breadth,
        research_depth=research_depth,
        agentic_rag_enabled=agentic_rag_enabled,
        source_preferences=source_preferences or {},
        min_confidence_threshold=min_confidence_threshold,
        max_sources=max_sources,
        similarity_threshold=similarity_threshold,
        top_k=top_k,
        conversation_history=history_dicts,
        is_repeat=is_repeat,
        attachments=[
            ChatAttachmentDTO(
                type=att.type,
                filename=att.filename,
                content=att.content,
                mime_type=att.mime_type,
            )
            for att in (attachments or [])
        ],
        metadata=metadata,
    )


class ChatServiceServicer(chat_pb2_grpc.ChatServiceServicer):
    """ChatService gRPC implementation with specialized RPCs."""

    async def GenerateDirectLLM(
        self,
        request: chat_pb2.DirectLLMRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[chat_pb2.ChatResponsePacket]:
        """Direct LLM chat without RAG or documents."""
        logger.info(
            "GenerateDirectLLM - user_id=%s, model=%s, provider=%s",
            request.user_id,
            request.model_name,
            request.provider_type,
        )

        try:
            from src.main.config.database import SessionLocal
            from src.main.service.chat.model_reflection import with_model_reflection
            from src.main.service.rag.rag_utils import process_direct_llm_chat
            from src.main.service.streaming.packet_emitter import PacketEmitter
            from src.main.service.tracing.tracing_service import is_tracing_enabled, persist_llm_trace

            _tracing_enabled = is_tracing_enabled(SessionLocal, UUID(request.user_id))

            # 7.7 + 7.8 — apply mode-specific prompt transformations.
            # Thought-partner replaces the prompt entirely (LLM only
            # asks questions); tutor prepends Socratic instructions.
            # If both flags somehow arrive set, thought-partner wins
            # because retrieval is skipped — they are mutually
            # exclusive in the UI.
            mode_prompt = _apply_thought_partner_prepend(request.prompt, request)
            if mode_prompt == request.prompt:
                mode_prompt = _apply_tutor_prepend(request.prompt, request)

            chat_request = _build_chat_request_dto(
                prompt=mode_prompt,
                user_id=request.user_id,
                model_name=request.model_name,
                provider_type=request.provider_type,
                language=request.language,
                session_namespace=request.session_namespace,
                subscription_tier=request.subscription_tier,
                conversation_history=list(request.conversation_history),
                is_repeat=request.is_repeat,
                attachments=list(request.attachments),
                # Carry the active workspace so the direct path can resolve the
                # user's library and search it on demand (no-collection chat).
                workspace_id=request.workspace_id if request.HasField("workspace_id") else None,
            )

            emitter = PacketEmitter(buffer_mode=False)
            _trace_data = {} if _tracing_enabled else None
            # force_reflection=True: when the no-collection path supplements the
            # answer with a live web search it emits web citations, and the
            # reflection wrapper then appends a visible "model insight" below the
            # web-grounded answer (saw_sources gate). A pure general-knowledge
            # reply emits no citations, so the extra thinking-model call is skipped.
            async for packet in _stream_packets(
                with_model_reflection(
                    process_direct_llm_chat(chat_request, request.user_id, emitter),
                    request=chat_request,
                    emitter=emitter,
                    user_id=request.user_id,
                    force_reflection=True,
                ),
                context,
                trace_capture=_trace_data,
            ):
                yield packet

            # Fire-and-forget: persist LLM trace
            if _tracing_enabled and _trace_data:
                _raw_session = request.session_namespace
                if ":" in _raw_session:
                    _raw_session = _raw_session.split(":", 1)[1]
                _se = _trace_data.get("stream_end", {})
                _rdi = _trace_data.get("rag_debug_info", {})
                asyncio.create_task(
                    persist_llm_trace(
                        db_session_factory=SessionLocal,
                        session_id=UUID(_raw_session),
                        user_id=UUID(request.user_id),
                        query=request.prompt,
                        chat_mode="direct_llm",
                        system_prompt_length=_rdi.get("system_prompt_length", 0),
                        context_token_estimate=_rdi.get("context_token_estimate", 0),
                        history_message_count=_rdi.get("history_message_count", 0),
                        has_conversation_summary=_rdi.get("has_conversation_summary", False),
                        provider=_se.get("provider"),
                        model=_se.get("model"),
                        input_tokens=_se.get("input_tokens"),
                        output_tokens=_se.get("output_tokens"),
                        total_tokens=_se.get("total_tokens"),
                        cost_usd=_se.get("cost_usd"),
                        latency_ms=int(_se["latency_ms"]) if _se.get("latency_ms") else None,
                        duration_ms=_se.get("duration_ms"),
                        response_preview=_trace_data.get("response_preview"),
                    )
                )

        except Exception as e:
            logger.exception("Error in GenerateDirectLLM: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, f"Direct LLM generation failed: {e!s}")

    async def GenerateRAG(
        self,
        request: chat_pb2.RAGRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[chat_pb2.ChatResponsePacket]:
        """Traditional RAG with 18 strategies."""
        logger.info(
            "GenerateRAG - user_id=%s, model=%s, collections=%s, document_ids=%s",
            request.user_id,
            request.model_name,
            list(request.collection_ids),
            list(request.document_ids),
        )

        try:
            from src.main.config.database import SessionLocal
            from src.main.main import Main
            from src.main.service.streaming.packet_emitter import PacketEmitter
            from src.main.service.tracing.tracing_service import (
                is_tracing_enabled,
                persist_llm_trace,
                serialize_retrieved_chunks,
            )
            from src.main.utils.rag.strategy_service import RAGStrategyService

            _tracing_enabled = is_tracing_enabled(SessionLocal, UUID(request.user_id))

            with grpc_sqlmodel_session() as db:
                main_instance = Main.get_instance()

                subscription_tier = request.subscription_tier or "researcher"

                # Get LLM
                request_llm = await main_instance.llm_manager.get_llm(
                    model_name=request.model_name,
                    provider_type=request.provider_type,
                    enable_metrics=True,
                    subscription_tier=subscription_tier,
                    db=db,
                    user_id=request.user_id,
                )
                if not request_llm:
                    await context.abort(grpc.StatusCode.INTERNAL, "Failed to initialize LLM")
                    return

                # Get retriever
                from src.main.service.retriever.retriever_manager import retriever_manager
                from src.main.utils.documents.utils import get_user_retriever_type

                user_retriever_type = get_user_retriever_type(db, request.user_id)
                user_retriever = await retriever_manager.get_retriever(
                    request.user_id,
                    user_retriever_type,
                    model_name=request.model_name,
                    provider_type=request.provider_type,
                )
                if not user_retriever:
                    await context.abort(grpc.StatusCode.INTERNAL, "Failed to get retriever")
                    return

                # Shared counter for sequential packet indices across phases
                packet_counter = [0]

                # Resolve saved search IDs to additional document IDs (RAG integration)
                extra_doc_ids = _resolve_saved_search_ids(
                    list(request.saved_search_ids) if request.saved_search_ids else [],
                    request.user_id,
                )
                # Merge saved search document IDs into the request's document_ids for downstream use
                merged_document_ids = list(request.document_ids) + extra_doc_ids

                # Select RAG strategy (returns RoutingResult with strategy + source analysis)
                collection_ids = list(request.collection_ids)
                routing = await RAGStrategyService.select_strategy_sync(
                    query=request.prompt,
                    collection_ids=collection_ids,
                    user_id=request.user_id,
                    db=db,
                )
                rag_strategy_name = routing.strategy_name
                strategy_type = routing.strategy_type
                rag_strategy_class = routing.strategy_class

                # Emit strategy_selected packet so frontend knows which orchestrator was chosen
                strategy_packet_content = {
                    "strategy_name": rag_strategy_name,
                    "strategy_type": strategy_type,
                    "mode": "sync_selection",
                }
                if routing.source_analysis:
                    strategy_packet_content["sources"] = routing.source_analysis.primary_sources
                if routing.routing_tier is not None:
                    strategy_packet_content["routing_tier"] = routing.routing_tier
                    strategy_packet_content["routing_tier_name"] = routing.routing_tier_name
                yield chat_pb2.ChatResponsePacket(
                    type="strategy_selected",
                    index=packet_counter[0],
                    data=json.dumps(
                        {
                            "type": "strategy_selected",
                            "content": strategy_packet_content,
                        }
                    ),
                    timestamp=_create_timestamp(),
                )
                packet_counter[0] += 1

                # Emit intent routing packet for UI indicator
                if routing.source_analysis:
                    intent_data = {
                        "type": "intent_routing",
                        "sources": routing.source_analysis.primary_sources,
                        "strategy_name": rag_strategy_name,
                        "confidence": routing.confidence,
                        "reasoning": routing.reasoning,
                    }
                    yield chat_pb2.ChatResponsePacket(
                        type="intent_routing",
                        index=packet_counter[0],
                        data=json.dumps(intent_data),
                        timestamp=_create_timestamp(),
                    )
                    packet_counter[0] += 1

                # Emit a strategy_transparency packet so the "Search strategy" panel
                # renders in manual/sync mode too. The agentic path emits this from
                # chat_agentic_rag; the sync path previously emitted only
                # strategy_selected (which the UI does not map to the panel), so the
                # badge stayed empty in manual mode.
                #
                # Sync routing skips query analysis, so RoutingResult is usually
                # minimal here (strategy name only). Populate the panel from whatever
                # we already have — real routing facts when present, otherwise the
                # strategy's own preset — so it is informative instead of an empty
                # expander. No extra LLM call: that would defeat the point of manual.
                from src.main.service.rag.strategy_presets import get_strategy_preset

                _preset = get_strategy_preset(rag_strategy_name)
                _t_sources = (
                    list(routing.source_analysis.primary_sources)
                    if (routing.source_analysis and routing.source_analysis.primary_sources)
                    else ["documents"]
                )
                if getattr(request, "web_search_enabled", False) and "web" not in _t_sources:
                    _t_sources.append("web")
                _t_filters: dict[str, str] = {}
                if isinstance(routing.query_characteristics, dict):
                    for _fkey in ("intent", "complexity", "domain", "information_depth"):
                        _fval = routing.query_characteristics.get(_fkey)
                        if _fval:
                            _t_filters[_fkey] = str(_fval)
                yield chat_pb2.ChatResponsePacket(
                    type="strategy_transparency",
                    index=packet_counter[0],
                    data=json.dumps(
                        {
                            "type": "strategy_transparency",
                            # Sync routing does not decompose the query, so no sub-queries.
                            "sub_queries": [],
                            "filters_applied": _t_filters,
                            "sources_queried": _t_sources,
                            "strategy_name": rag_strategy_name,
                            # Prefer the router's own reasoning; fall back to the
                            # strategy preset's description of how it retrieves.
                            "rationale": (routing.reasoning or _preset.get("prompt_bias")) or None,
                            # In the sync path the named strategy actually executes
                            # retrieval (unlike the agentic tool-agent path), so leave
                            # executor unset rather than imply the agentic note.
                            "executor": None,
                        }
                    ),
                    timestamp=_create_timestamp(),
                )
                packet_counter[0] += 1

                # Instantiate strategy
                rag_emitter = PacketEmitter(buffer_mode=False)
                strategy_kwargs = dict(retriever=user_retriever, llm=request_llm, packet_emitter=rag_emitter)

                # Inject neo4j_service for orchestrators that support graph search (e.g., EnhancedTriModal)
                if "neo4j_service" in inspect.signature(rag_strategy_class.__init__).parameters:
                    from src.main.service.graph.neo4j_service import get_neo4j_service

                    strategy_kwargs["neo4j_service"] = get_neo4j_service()

                # Inject db_session for strategies that need database access (e.g., SectionExpansion, AgenticExpansion)
                if "db_session" in inspect.signature(rag_strategy_class.__init__).parameters:
                    strategy_kwargs["db_session"] = SessionLocal()

                rag_strategy_instance = rag_strategy_class(**strategy_kwargs)
                _rag_start_time = time.time()

                # Thread query characteristics hints to strategy for adaptive behaviour
                if routing.query_characteristics:
                    rag_strategy_instance.query_hints = routing.query_characteristics

                # Hybrid mode: fetch web context if source analysis recommends it
                # or if the request was routed as hybrid (web_search + collections from Kotlin)
                web_context = ""
                needs_web = (routing.source_analysis and "web" in routing.source_analysis.primary_sources) or getattr(
                    request, "web_search_enabled", False
                )
                # Launch web search as background task (runs parallel with RAG retrieval)
                web_task = None
                if needs_web:
                    logger.info("Hybrid mode: launching parallel web search")
                    yield chat_pb2.ChatResponsePacket(
                        type="status",
                        index=packet_counter[0],
                        data=json.dumps({"type": "status", "content": "webSearchStarting", "stage": "hybrid_search"}),
                        timestamp=_create_timestamp(),
                    )
                    packet_counter[0] += 1
                    web_task = asyncio.create_task(_fetch_web_context(request.prompt))

                # Build a request DTO for the strategy
                prompt_with_context = request.prompt

                # Augment prompt with attachment context (documents, YouTube transcripts)
                if request.attachments:
                    from src.main.service.chat.attachment_processor import augment_prompt_with_attachments

                    prompt_with_context = augment_prompt_with_attachments(prompt_with_context, list(request.attachments))

                # Augment prompt with user annotation context (highlighted sections)
                try:
                    from src.main.service.rag.annotation_context import format_annotation_context, get_annotation_chunks

                    annotation_doc_ids = merged_document_ids if merged_document_ids else collection_ids
                    annotation_chunks = get_annotation_chunks(
                        document_ids=annotation_doc_ids,
                        user_id=request.user_id,
                        max_annotations=20,
                    )
                    annotation_context = format_annotation_context(annotation_chunks)
                    if annotation_context:
                        prompt_with_context = prompt_with_context + "\n\n" + annotation_context
                except Exception as ann_err:
                    logger.debug("Annotation context enrichment skipped: %s", str(ann_err))

                # Await parallel web search result (ran during RAG retrieval prep)
                if web_task:
                    try:
                        web_context = await web_task
                        if web_context:
                            prompt_with_context = prompt_with_context + "\n" + web_context
                            logger.info("Hybrid mode: web context merged (%d chars)", len(web_context))
                    except Exception as web_err:
                        logger.warning("Hybrid web search failed (graceful): %s", str(web_err))

                # 7.8 v1 — AI Tutor Mode prepend.  Adds Socratic-tutor
                # instructions to the user prompt so the LLM responds
                # didactically (introduce → check understanding → drill
                # → recap).  Retrieval already ran against the raw
                # prompt above, so the tutor framing only affects
                # generation.  v2 (after 1.1 + 4.2) replaces this
                # with a state-machine driven curriculum walker.
                # 7.8 v2 — shared helper used by every chat path
                prompt_with_context = _apply_tutor_prepend(prompt_with_context, request)

                chat_request = _build_chat_request_dto(
                    prompt=prompt_with_context,
                    user_id=request.user_id,
                    model_name=request.model_name,
                    provider_type=request.provider_type,
                    language=request.language,
                    session_namespace=request.session_namespace,
                    subscription_tier=subscription_tier,
                    collection_ids=collection_ids,
                    document_ids=merged_document_ids,
                    similarity_threshold=request.similarity_threshold,
                    top_k=request.top_k,
                    conversation_history=list(request.conversation_history),
                    is_repeat=request.is_repeat,
                    attachments=list(request.attachments),
                    metadata=dict(request.metadata) if request.metadata else None,
                )
                # "Thinking" toggle → append an own-knowledge model reflection.
                chat_request.deep_synthesis_enabled = (chat_request.metadata or {}).get("deep_synthesis_enabled") == "true"

                # Retrieve documents
                retrieval_gen = rag_strategy_instance.retrieve_documents_for_realtime_citations(
                    query=request.prompt,
                    collection_ids=collection_ids,
                    document_ids=merged_document_ids,
                    top_k=request.top_k,
                    similarity_threshold=request.similarity_threshold,
                )
                async for packet in _stream_packets(retrieval_gen, context, packet_counter):
                    yield packet

                # Document scope filter — when the user @-mentioned specific
                # documents (or selected via the Knowledge Stacks dialog)
                # the retrieval result MUST contain only chunks from those
                # docs. Some strategies (orchestrator fallback paths, graph
                # search, junction-table merges) drop document_ids during
                # internal downscoping, so chunks from sibling documents in
                # the same collection sometimes slip through to the LLM
                # context. This defense-in-depth pass guarantees the user's
                # explicit scope is honoured regardless of which strategy
                # the router picked.
                if merged_document_ids:
                    requested_doc_set = {str(did) for did in merged_document_ids}
                    existing_docs = list(getattr(rag_strategy_instance, "retrieved_documents", None) or [])
                    if existing_docs:
                        filtered_by_scope = [doc for doc in existing_docs if str((doc.metadata or {}).get("document_id", "")) in requested_doc_set]
                        if len(filtered_by_scope) != len(existing_docs):
                            rag_strategy_instance.retrieved_documents = filtered_by_scope
                            logger.info(
                                "Document scope filter: %d -> %d chunks (requested docs=%d)",
                                len(existing_docs),
                                len(filtered_by_scope),
                                len(requested_doc_set),
                            )

                # Annotation color filter + boost — when the user picked a
                # color subset on the UI chip row, restrict the strategy's
                # retrieved chunks to pages overlapping with their highlights
                # and rescore by per-color boost. Empty filter list is a no-op.
                color_filter = list(request.annotation_color_filter)
                if color_filter:
                    try:
                        from src.main.service.rag.annotation_color_filter import (
                            build_color_page_index,
                            filter_and_rescore_documents,
                        )

                        primary_collection = collection_ids[0] if collection_ids else None
                        cf = build_color_page_index(
                            user_id=request.user_id,
                            color_filter=color_filter,
                            document_ids=merged_document_ids or None,
                            collection_id=primary_collection,
                        )
                        existing_docs = list(getattr(rag_strategy_instance, "retrieved_documents", None) or [])
                        if existing_docs and cf.index:
                            filtered = filter_and_rescore_documents(existing_docs, cf.index)
                            rag_strategy_instance.retrieved_documents = filtered
                            logger.info(
                                "Annotation color filter: %d -> %d chunks (colors=%s, annotations=%d)",
                                len(existing_docs),
                                len(filtered),
                                sorted(cf.matched_colors),
                                cf.matched_annotations,
                            )
                            yield chat_pb2.ChatResponsePacket(
                                type="status",
                                index=packet_counter[0],
                                data=json.dumps(
                                    {
                                        "type": "status",
                                        "content": "annotationColorFilterApplied",
                                        "stage": "retrieval",
                                    }
                                ),
                                timestamp=_create_timestamp(),
                            )
                            packet_counter[0] += 1
                    except Exception as filter_err:
                        logger.warning("Annotation color filter skipped: %s", str(filter_err))

                # Snapshot retrieved documents for tracing BEFORE streaming (cleared in finally block)
                _traced_chunks = None
                if _tracing_enabled:
                    _traced_chunks = serialize_retrieved_chunks(getattr(rag_strategy_instance, "retrieved_documents", None) or [])

                # Stream response
                from src.main.service.chat.model_reflection import with_model_reflection

                _trace_data = {} if _tracing_enabled else None
                async for packet in _stream_packets(
                    with_model_reflection(
                        rag_strategy_instance.process_chat_request(chat_request),
                        request=chat_request,
                        emitter=rag_emitter,
                        user_id=request.user_id or "",
                    ),
                    context,
                    packet_counter,
                    trace_capture=_trace_data,
                ):
                    yield packet

                # Fire-and-forget: persist RAG evaluation trace (existing)
                _graph_stats = getattr(rag_strategy_instance, "graph_traversal_stats", None)
                if rag_strategy_name and request.session_namespace:
                    try:
                        from src.main.service.evaluation.rag_evaluation_service import persist_rag_trace

                        _raw_session = request.session_namespace
                        if ":" in _raw_session:
                            _raw_session = _raw_session.split(":", 1)[1]

                        _rag_latency_ms = int((time.time() - _rag_start_time) * 1000)
                        _rag_token_count = None
                        if _trace_data:
                            _se_tokens = _trace_data.get("stream_end", {})
                            _rag_token_count = _se_tokens.get("total_tokens")
                        asyncio.create_task(
                            persist_rag_trace(
                                db_session_factory=SessionLocal,
                                session_id=UUID(_raw_session),
                                user_id=UUID(request.user_id),
                                query=request.prompt,
                                selected_strategy=rag_strategy_name,
                                strategy_type=strategy_type or "strategy",
                                mode="hybrid" if web_context else "sync_selection",
                                confidence=routing.confidence,
                                selected_orchestrator=rag_strategy_name if strategy_type == "orchestrator" else None,
                                graph_traversal_stats=_graph_stats,
                                latency_ms=_rag_latency_ms,
                                token_count=_rag_token_count,
                                routing_tier=routing.routing_tier,
                                routing_tier_name=routing.routing_tier_name,
                            )
                        )
                    except Exception as trace_err:
                        logger.debug("Failed to dispatch RAG trace persistence: %s", str(trace_err))

                # Fire-and-forget: persist LLM trace (new tracing system)
                if _tracing_enabled and _trace_data:
                    _raw_session = request.session_namespace
                    if ":" in _raw_session:
                        _raw_session = _raw_session.split(":", 1)[1]
                    _se = _trace_data.get("stream_end", {})
                    _rdi = _trace_data.get("rag_debug_info", {})
                    _source_analysis = None
                    if routing.source_analysis:
                        # noinspection PyBroadException
                        try:
                            _source_analysis = routing.source_analysis.model_dump()
                        except Exception:
                            _source_analysis = {"primary_sources": routing.source_analysis.primary_sources}
                    asyncio.create_task(
                        persist_llm_trace(
                            db_session_factory=SessionLocal,
                            session_id=UUID(_raw_session),
                            user_id=UUID(request.user_id),
                            query=request.prompt,
                            chat_mode="rag",
                            collection_ids=[str(c) for c in collection_ids],
                            document_ids=[str(d) for d in merged_document_ids],
                            top_k=request.top_k,
                            similarity_threshold=request.similarity_threshold,
                            strategy_name=rag_strategy_name,
                            strategy_type=strategy_type,
                            retrieved_chunks=_traced_chunks,
                            system_prompt_length=_rdi.get("system_prompt_length", 0),
                            context_token_estimate=_rdi.get("context_token_estimate", 0),
                            history_message_count=_rdi.get("history_message_count", 0),
                            has_conversation_summary=_rdi.get("has_conversation_summary", False),
                            provider=_se.get("provider"),
                            model=_se.get("model"),
                            input_tokens=_se.get("input_tokens"),
                            output_tokens=_se.get("output_tokens"),
                            total_tokens=_se.get("total_tokens"),
                            cost_usd=_se.get("cost_usd"),
                            latency_ms=int(_se["latency_ms"]) if _se.get("latency_ms") else None,
                            duration_ms=_se.get("duration_ms"),
                            response_preview=_trace_data.get("response_preview"),
                            source_analysis=_source_analysis,
                            routing_tier=routing.routing_tier,
                            routing_tier_name=routing.routing_tier_name,
                        )
                    )

                # After RAG stream completes: generate follow-up suggestions for single @-mentioned document
                _doc_ids = list(request.document_ids)
                if len(_doc_ids) == 1:
                    try:
                        from src.main.service.chat.suggestion_generator import generate_follow_up_suggestions

                        _suggestion_emitter = PacketEmitter()
                        _answer_preview = _trace_data.get("response_preview", "") if _trace_data else ""
                        _suggestion_packet = await generate_follow_up_suggestions(
                            document_id=_doc_ids[0],
                            user_query=request.prompt,
                            ai_answer_preview=_answer_preview[:500],
                            emitter=_suggestion_emitter,
                            counter=packet_counter,
                        )
                        if _suggestion_packet:
                            import json as _sjson

                            _spkt = _sjson.loads(_suggestion_packet)
                            _spkt_obj = _spkt.get("obj", _spkt)
                            yield chat_pb2.ChatResponsePacket(
                                type=_spkt_obj.get("type", "suggestions"),
                                index=packet_counter[0],
                                data=_sjson.dumps(_spkt_obj),
                                timestamp=_create_timestamp(),
                            )
                            logger.info("Emitted follow-up suggestions for document %s", _doc_ids[0])
                    except Exception as _se:
                        logger.warning("Suggestion generation failed: %s", str(_se))

        except Exception as e:
            logger.exception("Error in GenerateRAG: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, "RAG generation failed: %s" % str(e))

    async def GenerateDeepResearch(
        self,
        request: chat_pb2.DeepResearchRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[chat_pb2.ChatResponsePacket]:
        """5-phase deep research pipeline."""
        logger.info(
            "GenerateDeepResearch - user_id=%s, breadth=%d, depth=%d, language=%s",
            request.user_id,
            request.research_breadth,
            request.research_depth,
            request.language,
        )

        try:
            from src.main.main import Main
            from src.main.service.chat.chat_deep_research import process_deep_research
            from src.main.service.streaming.packet_emitter import PacketEmitter

            with grpc_sqlmodel_session() as db:
                main_instance = Main.get_instance()
                emitter = PacketEmitter(buffer_mode=True)
                cancellation_event = asyncio.Event()

                chat_request = _build_chat_request_dto(
                    prompt=request.prompt,
                    user_id=request.user_id,
                    model_name=request.model_name,
                    provider_type=request.provider_type,
                    language=request.language,
                    session_namespace=request.session_namespace,
                    subscription_tier=request.subscription_tier,
                    collection_ids=list(request.collection_ids),
                    document_ids=list(request.document_ids),
                    deep_research_enabled=True,
                    research_breadth=request.research_breadth,
                    research_depth=request.research_depth,
                    conversation_history=list(request.conversation_history),
                    is_repeat=request.is_repeat,
                    attachments=list(request.attachments),
                    metadata=dict(request.metadata) if request.metadata else None,
                )

                assistant_message_id = UUID(request.assistant_message_id) if request.assistant_message_id else None
                chat_session_id = UUID(request.session_id) if request.session_id else None

                async for packet in _stream_packets(
                    process_deep_research(
                        request=chat_request,
                        emitter=emitter,
                        main_instance=main_instance,
                        subscription_tier=request.subscription_tier or "researcher",
                        db=db,
                        user_id=request.user_id or "",
                        chat_session_id=chat_session_id,
                        assistant_message_id=assistant_message_id,
                        cancellation_event=cancellation_event,
                    ),
                    context,
                ):
                    yield packet

        except Exception as e:
            logger.exception("Error in GenerateDeepResearch: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, "Deep research failed: %s" % str(e))

    async def GenerateWebSearch(
        self,
        request: chat_pb2.WebSearchRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[chat_pb2.ChatResponsePacket]:
        """Web search enhanced chat."""
        logger.info("GenerateWebSearch - user_id=%s, prompt=%s", request.user_id, request.prompt[:50])

        try:
            from src.main.config.database import SessionLocal
            from src.main.main import Main
            from src.main.service.chat.chat_web_search import process_web_search
            from src.main.service.streaming.packet_emitter import PacketEmitter
            from src.main.service.tracing.tracing_service import is_tracing_enabled, persist_llm_trace

            _tracing_enabled = is_tracing_enabled(SessionLocal, UUID(request.user_id))

            with grpc_sqlmodel_session() as db:
                main_instance = Main.get_instance()
                emitter = PacketEmitter(buffer_mode=True)
                cancellation_event = asyncio.Event()

                chat_request = _build_chat_request_dto(
                    prompt=_apply_tutor_prepend(request.prompt, request),
                    user_id=request.user_id,
                    model_name=request.model_name,
                    provider_type=request.provider_type,
                    language=request.language,
                    session_namespace=request.session_namespace,
                    subscription_tier=request.subscription_tier,
                    web_search_enabled=True,
                    conversation_history=list(request.conversation_history),
                    is_repeat=request.is_repeat,
                    attachments=list(request.attachments),
                )

                assistant_message_id = UUID(request.assistant_message_id) if request.assistant_message_id else None

                _trace_data = {} if _tracing_enabled else None
                async for packet in _stream_packets(
                    process_web_search(
                        request=chat_request,
                        emitter=emitter,
                        main_instance=main_instance,
                        subscription_tier=request.subscription_tier or "researcher",
                        db=db,
                        user_id=request.user_id or "",
                        _assistant_message_id=assistant_message_id,
                        cancellation_event=cancellation_event,
                    ),
                    context,
                    trace_capture=_trace_data,
                ):
                    yield packet

                # Fire-and-forget: persist LLM trace
                if _tracing_enabled and _trace_data:
                    _raw_session = request.session_namespace
                    if ":" in _raw_session:
                        _raw_session = _raw_session.split(":", 1)[1]
                    _se = _trace_data.get("stream_end", {})
                    _rdi = _trace_data.get("rag_debug_info", {})
                    asyncio.create_task(
                        persist_llm_trace(
                            db_session_factory=SessionLocal,
                            session_id=UUID(_raw_session),
                            user_id=UUID(request.user_id or ""),
                            query=request.prompt,
                            chat_mode="web_search",
                            assistant_message_id=assistant_message_id,
                            system_prompt_length=_rdi.get("system_prompt_length", 0),
                            context_token_estimate=_rdi.get("context_token_estimate", 0),
                            history_message_count=_rdi.get("history_message_count", 0),
                            has_conversation_summary=_rdi.get("has_conversation_summary", False),
                            provider=_se.get("provider"),
                            model=_se.get("model"),
                            input_tokens=_se.get("input_tokens"),
                            output_tokens=_se.get("output_tokens"),
                            total_tokens=_se.get("total_tokens"),
                            cost_usd=_se.get("cost_usd"),
                            latency_ms=int(_se["latency_ms"]) if _se.get("latency_ms") else None,
                            duration_ms=_se.get("duration_ms"),
                            response_preview=_trace_data.get("response_preview"),
                        )
                    )

        except Exception as e:
            logger.exception("Error in GenerateWebSearch: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, "Web search failed: %s" % str(e))

    async def GenerateAgenticRAG(
        self,
        request: chat_pb2.AgenticRAGRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[chat_pb2.ChatResponsePacket]:
        """Multi-source agentic RAG orchestration."""
        logger.info(
            "GenerateAgenticRAG - user_id=%s, max_sources=%d, document_ids=%s, collection_ids=%s",
            request.user_id,
            request.max_sources,
            list(request.document_ids),
            list(request.collection_ids),
        )

        try:
            from src.main.config.database import SessionLocal
            from src.main.main import Main
            from src.main.service.chat.chat_agentic_rag import process_agentic_rag
            from src.main.service.chat.model_reflection import with_model_reflection
            from src.main.service.collection_workspace_cache import upsert_collection_workspace
            from src.main.service.streaming.packet_emitter import PacketEmitter
            from src.main.service.tracing.tracing_service import is_tracing_enabled, persist_llm_trace

            _tracing_enabled = is_tracing_enabled(SessionLocal, UUID(request.user_id))

            with grpc_sqlmodel_session() as db:
                main_instance = Main.get_instance()
                emitter = PacketEmitter(buffer_mode=True)
                current_user = build_grpc_user_dto(request.user_id)

                collection_ids = list(request.collection_ids)
                workspace_id = request.workspace_id if request.HasField("workspace_id") else None

                # Resolve saved search IDs to additional document IDs (RAG integration)
                extra_doc_ids = _resolve_saved_search_ids(
                    list(request.saved_search_ids) if request.saved_search_ids else [],
                    request.user_id,
                )
                merged_document_ids = list(request.document_ids) + extra_doc_ids

                # Cache collection-workspace mapping for downstream services
                if workspace_id:
                    for cid in collection_ids:
                        try:
                            upsert_collection_workspace(db, UUID(cid), UUID(workspace_id), UUID(request.user_id))
                        except Exception as e:
                            logger.warning("Failed to upsert collection_workspace_map for %s: %s", cid, str(e))

                chat_request = _build_chat_request_dto(
                    prompt=_apply_tutor_prepend(request.prompt, request),
                    user_id=request.user_id,
                    model_name=request.model_name,
                    provider_type=request.provider_type,
                    language=request.language,
                    session_namespace=request.session_namespace,
                    subscription_tier=request.subscription_tier,
                    collection_ids=collection_ids,
                    document_ids=merged_document_ids,
                    workspace_id=workspace_id,
                    agentic_rag_enabled=True,
                    source_preferences=dict(request.source_preferences),
                    min_confidence_threshold=request.min_confidence_threshold,
                    max_sources=request.max_sources,
                    conversation_history=list(request.conversation_history),
                    is_repeat=request.is_repeat,
                    attachments=list(request.attachments),
                    metadata=dict(request.metadata) if request.metadata else None,
                )

                assistant_message_id = UUID(request.assistant_message_id) if request.assistant_message_id else None

                # "Thinking" toggle → append an own-knowledge model reflection after
                # the sourced answer. Sourced from a proto field when present, else
                # the metadata bag (lets the feature ship before the proto regen).
                chat_request.deep_synthesis_enabled = (
                    getattr(request, "deep_synthesis_enabled", False) or (chat_request.metadata or {}).get("deep_synthesis_enabled") == "true"
                )

                _trace_data = {} if _tracing_enabled else None
                async for packet in _stream_packets(
                    with_model_reflection(
                        process_agentic_rag(
                            request=chat_request,
                            emitter=emitter,
                            main_instance=main_instance,
                            subscription_tier=request.subscription_tier or "researcher",
                            db=db,
                            user_id=request.user_id or "",
                            current_user=current_user,
                            assistant_message_id=assistant_message_id,
                        ),
                        request=chat_request,
                        emitter=emitter,
                        user_id=request.user_id or "",
                    ),
                    context,
                    trace_capture=_trace_data,
                ):
                    yield packet

                # Fire-and-forget: persist LLM trace
                if _tracing_enabled and _trace_data:
                    _raw_session = request.session_namespace
                    if ":" in _raw_session:
                        _raw_session = _raw_session.split(":", 1)[1]
                    _se = _trace_data.get("stream_end", {})
                    _rdi = _trace_data.get("rag_debug_info", {})
                    asyncio.create_task(
                        persist_llm_trace(
                            db_session_factory=SessionLocal,
                            session_id=UUID(_raw_session),
                            user_id=UUID(request.user_id or ""),
                            query=request.prompt,
                            chat_mode="agentic_rag",
                            collection_ids=[str(c) for c in collection_ids],
                            document_ids=[str(d) for d in merged_document_ids],
                            workspace_id=UUID(workspace_id) if workspace_id else None,
                            assistant_message_id=assistant_message_id,
                            agentic_routing=True,
                            system_prompt_length=_rdi.get("system_prompt_length", 0),
                            context_token_estimate=_rdi.get("context_token_estimate", 0),
                            history_message_count=_rdi.get("history_message_count", 0),
                            has_conversation_summary=_rdi.get("has_conversation_summary", False),
                            provider=_se.get("provider"),
                            model=_se.get("model"),
                            input_tokens=_se.get("input_tokens"),
                            output_tokens=_se.get("output_tokens"),
                            total_tokens=_se.get("total_tokens"),
                            cost_usd=_se.get("cost_usd"),
                            latency_ms=int(_se["latency_ms"]) if _se.get("latency_ms") else None,
                            duration_ms=_se.get("duration_ms"),
                            response_preview=_trace_data.get("response_preview"),
                        )
                    )

        except Exception as e:
            logger.exception("Error in GenerateAgenticRAG: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, "Agentic RAG failed: %s" % str(e))

    async def GenerateDocumentQA(
        self,
        request: chat_pb2.DocumentQARequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[chat_pb2.ChatResponsePacket]:
        """Document QA for unprocessed documents."""
        logger.info(
            "GenerateDocumentQA - user_id=%s, document_id=%s",
            request.user_id,
            request.document_id,
        )

        try:
            from sqlmodel import select

            from src.main.config.database import SessionLocal
            from src.main.models.sqlmodel_models import Document
            from src.main.service.chat.chat_document import process_document_qa
            from src.main.service.streaming.packet_emitter import PacketEmitter
            from src.main.service.tracing.tracing_service import is_tracing_enabled, persist_llm_trace

            _tracing_enabled = is_tracing_enabled(SessionLocal, UUID(request.user_id)) if request.user_id else False

            with grpc_sqlmodel_session() as db:
                emitter = PacketEmitter(buffer_mode=False)

                # Fetch the document from the database. Use scalars() so we get the
                # Document instance, not a Row — process_document_qa accesses
                # document.id / .processing_status / .filename directly, and a Row
                # would raise KeyError('id').
                document = db.execute(select(Document).where(Document.id == request.document_id)).scalars().first()
                if not document:
                    await context.abort(grpc.StatusCode.NOT_FOUND, "Document %s not found" % request.document_id)
                    return

                assistant_message_id = UUID(request.assistant_message_id) if request.assistant_message_id else None
                user_id = UUID(request.user_id) if request.user_id else None

                _trace_data = {} if _tracing_enabled else None
                async for packet in _stream_packets(
                    process_document_qa(
                        query=request.prompt,
                        document=document,
                        db=db,
                        emitter=emitter,
                        assistant_message_id=assistant_message_id,
                        user_id=user_id,
                        model_name=request.model_name,
                        provider_type=request.provider_type,
                        subscription_tier=request.subscription_tier,
                    ),
                    context,
                    trace_capture=_trace_data,
                ):
                    yield packet

                # Fire-and-forget: persist LLM trace
                if _tracing_enabled and _trace_data and user_id:
                    _raw_session = getattr(request, "session_namespace", "") or ""
                    if ":" in _raw_session:
                        _raw_session = _raw_session.split(":", 1)[1]
                    elif not _raw_session:
                        _raw_session = str(user_id)  # Fallback for document QA (no session)
                    _se = _trace_data.get("stream_end", {})
                    _rdi = _trace_data.get("rag_debug_info", {})
                    asyncio.create_task(
                        persist_llm_trace(
                            db_session_factory=SessionLocal,
                            session_id=UUID(_raw_session) if _raw_session != str(user_id) else user_id,
                            user_id=user_id,
                            query=request.prompt,
                            chat_mode="document_qa",
                            document_ids=[request.document_id],
                            assistant_message_id=assistant_message_id,
                            system_prompt_length=_rdi.get("system_prompt_length", 0),
                            context_token_estimate=_rdi.get("context_token_estimate", 0),
                            history_message_count=_rdi.get("history_message_count", 0),
                            has_conversation_summary=_rdi.get("has_conversation_summary", False),
                            provider=_se.get("provider"),
                            model=_se.get("model"),
                            input_tokens=_se.get("input_tokens"),
                            output_tokens=_se.get("output_tokens"),
                            total_tokens=_se.get("total_tokens"),
                            cost_usd=_se.get("cost_usd"),
                            latency_ms=int(_se["latency_ms"]) if _se.get("latency_ms") else None,
                            duration_ms=_se.get("duration_ms"),
                            response_preview=_trace_data.get("response_preview"),
                        )
                    )

        except Exception as e:
            logger.exception("Error in GenerateDocumentQA: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, "Document QA failed: %s" % str(e))

    async def GenerateTitle(
        self,
        request: chat_pb2.TitleRequest,
        context: grpc.aio.ServicerContext,
    ) -> chat_pb2.TitleResponse:
        """Generate a conversation title (non-streaming)."""
        logger.info("GenerateTitle - user_id=%s, model=%s", request.user_id, request.model_name)

        try:
            from src.main.service.history.messages import ChatMessageService

            with grpc_sqlmodel_session() as db:
                title = await ChatMessageService.generate_conversation_title(
                    message_content=request.user_message,
                    db=db,
                    model_name=request.model_name,
                    provider_type=request.provider_type,
                    user_id=request.user_id,
                    subscription_tier=request.subscription_tier,
                    language=request.language or "en",
                )
                return chat_pb2.TitleResponse(title=title, success=True, error="")

        except Exception as e:
            logger.exception("Error in GenerateTitle: %s", str(e))
            return chat_pb2.TitleResponse(title="", success=False, error=str(e))

    async def GenerateChat(
        self,
        request: chat_pb2.ChatRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[chat_pb2.ChatResponsePacket]:
        """Deprecated: Legacy unified chat endpoint. Use mode-specific RPCs instead."""
        logger.warning("GenerateChat called (deprecated) - use mode-specific RPCs instead")

        # Route to the appropriate specialized RPC based on request flags
        logger.info(
            "GenerateChat routing - collection_ids=%s, document_ids=%s, web_search=%s, deep_research=%s",
            list(request.collection_ids),
            list(request.document_ids),
            request.web_search_enabled,
            request.deep_research_enabled,
        )
        if request.deep_research_enabled:
            req = chat_pb2.DeepResearchRequest(
                prompt=request.prompt,
                user_id=request.user_id,
                model_name=request.model_name if request.HasField("model_name") else "",
                provider_type=request.provider_type if request.HasField("provider_type") else "",
                collection_ids=list(request.collection_ids),
                document_ids=list(request.document_ids),
                language=request.language,
                research_breadth=request.research_breadth,
                research_depth=request.research_depth,
                session_namespace=f"{request.user_id}:{request.session_id}" if request.HasField("session_id") else "",
            )
            async for packet in self.GenerateDeepResearch(req, context):
                yield packet
        elif request.web_search_enabled:
            req = chat_pb2.WebSearchRequest(
                prompt=request.prompt,
                user_id=request.user_id,
                model_name=request.model_name if request.HasField("model_name") else "",
                provider_type=request.provider_type if request.HasField("provider_type") else "",
                language=request.language,
                session_namespace=f"{request.user_id}:{request.session_id}" if request.HasField("session_id") else "",
            )
            async for packet in self.GenerateWebSearch(req, context):
                yield packet
        elif request.collection_ids or request.document_ids:
            req = chat_pb2.RAGRequest(
                prompt=request.prompt,
                user_id=request.user_id,
                model_name=request.model_name if request.HasField("model_name") else "",
                provider_type=request.provider_type if request.HasField("provider_type") else "",
                collection_ids=list(request.collection_ids),
                document_ids=list(request.document_ids),
                language=request.language,
                similarity_threshold=request.similarity_threshold if request.HasField("similarity_threshold") else 0.5,
                top_k=request.top_k if request.HasField("top_k") else 15,
                session_namespace=f"{request.user_id}:{request.session_id}" if request.HasField("session_id") else "",
            )
            async for packet in self.GenerateRAG(req, context):
                yield packet
        else:
            req = chat_pb2.DirectLLMRequest(
                prompt=request.prompt,
                user_id=request.user_id,
                model_name=request.model_name if request.HasField("model_name") else "",
                provider_type=request.provider_type if request.HasField("provider_type") else "",
                language=request.language,
                session_namespace=f"{request.user_id}:{request.session_id}" if request.HasField("session_id") else "",
            )
            async for packet in self.GenerateDirectLLM(req, context):
                yield packet

    async def GenerateChatTutor(
        self,
        request: chat_pb2.TutorChatRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[chat_pb2.ChatResponsePacket]:
        """7.8 v3 — curriculum tutor mode.

        Auto-builds the curriculum from Leiden communities on first
        call (cheap no-op afterwards) then streams a single tutor
        turn: lesson_intro / check_understanding / drill_in / quiz /
        lesson_recap. State machine in
        `service/tutor/tutor_orchestrator.py` decides which prompt to
        run based on the persisted session state.
        """
        logger.info(
            "GenerateChatTutor - user_id=%s, collection_id=%s, prompt_len=%d",
            request.user_id,
            request.collection_id,
            len(request.prompt or ""),
        )

        try:
            from src.main.service.streaming.packet_emitter import PacketEmitter
            from src.main.service.tutor.curriculum_extractor import (
                build_curriculum_for_collection,
            )

            with grpc_sqlmodel_session() as db:
                curriculum_id = build_curriculum_for_collection(db, UUID(request.collection_id), rebuild=False)
                if curriculum_id is None:
                    # No reported communities yet — surface a soft
                    # message so the UI can prompt the user to run
                    # community detection on this collection first.
                    emitter = PacketEmitter(buffer_mode=False)
                    msg = "Tutor mode is not yet available for this collection — run community detection first."
                    counter = [0]
                    async for packet in _stream_packets(_yield_single_message(emitter, msg), context, counter=counter):
                        yield packet
                    return

                # Stream tutor turn tokens through the standard
                # message_delta packet flow so the existing chat UI
                # renders them without changes.
                emitter = PacketEmitter(buffer_mode=False)
                counter = [0]
                async for packet in _stream_packets(
                    _yield_tutor_tokens(
                        emitter,
                        db,
                        UUID(request.user_id),
                        curriculum_id,
                        request.prompt or "",
                        request.language or "en",
                    ),
                    context,
                    counter=counter,
                ):
                    yield packet

        except Exception as e:
            logger.exception("Error in GenerateChatTutor: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, "Tutor failed: %s" % str(e))

    async def GetTutorProgress(
        self,
        request: chat_pb2.GetTutorProgressRequest,
        context: grpc.aio.ServicerContext,
    ) -> chat_pb2.TutorProgressResponse:
        """7.8 v3 — read tutor session + lesson list for the progress
        sidebar. Returns curriculum_status='missing' when no
        curriculum exists for the collection yet."""
        try:
            with grpc_sqlmodel_session() as db:
                cur = db.execute(
                    text(
                        """
                        SELECT id, status, lesson_count
                        FROM tutor_curricula
                        WHERE collection_id = :cid
                        """
                    ),
                    {"cid": request.collection_id},
                ).fetchone()
                if cur is None:
                    return chat_pb2.TutorProgressResponse(
                        curriculum_ready=False,
                        curriculum_status="missing",
                        lesson_count=0,
                    )

                lessons = db.execute(
                    text(
                        """
                        SELECT lesson_ord, title, summary, level
                        FROM tutor_lessons
                        WHERE curriculum_id = :id
                        ORDER BY lesson_ord ASC
                        """
                    ),
                    {"id": str(cur.id)},
                ).fetchall()

                session = db.execute(
                    text(
                        """
                        SELECT current_lesson_ord, current_state,
                               COALESCE(lessons_completed, '[]'::jsonb) AS lessons_completed
                        FROM tutor_sessions
                        WHERE user_id = :uid AND curriculum_id = :cid
                          AND status = 'active'
                        ORDER BY last_active_at DESC
                        LIMIT 1
                        """
                    ),
                    {"uid": request.user_id, "cid": str(cur.id)},
                ).fetchone()

                completed: set[int] = set()
                current_lesson = 0
                current_state = "lesson_intro"
                if session is not None:
                    current_lesson = session.current_lesson_ord
                    current_state = session.current_state
                    raw = session.lessons_completed or []
                    if isinstance(raw, str):
                        import json

                        raw = json.loads(raw)
                    completed = {int(x) for x in raw}

                return chat_pb2.TutorProgressResponse(
                    curriculum_ready=cur.status == "ready",
                    curriculum_status=cur.status,
                    current_lesson_ord=current_lesson,
                    current_state=current_state,
                    lesson_count=cur.lesson_count,
                    lessons=[
                        chat_pb2.TutorLesson(
                            lesson_ord=row.lesson_ord,
                            title=row.title,
                            summary=row.summary,
                            level=row.level,
                            completed=row.lesson_ord in completed,
                        )
                        for row in lessons
                    ],
                )
        except Exception as e:
            logger.exception("Error in GetTutorProgress: %s", str(e))
            return chat_pb2.TutorProgressResponse(
                curriculum_ready=False,
                curriculum_status="failed",
                error=str(e),
            )

    async def GenerateImage(
        self,
        request: chat_pb2.GenerateImageRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[chat_pb2.ChatResponsePacket]:
        """6.1 — generate one or more images for a prompt and stream back
        ``image_attached`` packets, one per persisted artifact.

        The Python orchestrator handles content moderation, the upstream API
        call and on-disk persistence. The gRPC layer's job is to stream
        progress (status_started, image_attached × n, stream_end) so the UI
        can drop placeholders at the right moment.
        """
        from src.main.service.chat.chat_image_generation import (
            ContentModerationBlocked,
            ImageGenerationOrchestrator,
        )
        from src.main.service.chat.image_generation.base import ImageProviderError
        from src.main.service.streaming.packet_emitter import PacketEmitter
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        size = request.size or "1024x1024"
        n = request.n or 1
        quality = request.quality or "standard"
        model_override = request.model_override if request.HasField("model_override") else None

        logger.info(
            "GenerateImage - user_id=%s prompt=%r size=%s n=%d model_override=%s",
            request.user_id,
            request.prompt[:80],
            size,
            n,
            model_override,
        )

        emitter = PacketEmitter(buffer_mode=False)

        async def _gen():
            try:
                agent_config = get_system_agent_model()
            except Exception as e:
                logger.exception("Could not resolve system agent for image generation: %s", e)
                yield emitter.emit_error("System provider not configured for image generation")
                yield emitter.emit_stream_end(reason="error")
                return

            provider_type = agent_config.provider_type
            api_key = agent_config.api_key
            model_name = model_override or "dall-e-3"

            yield emitter.emit_status(
                content="image_generation_started",
                stage=f"{provider_type}:{model_name}",
            )

            orchestrator = ImageGenerationOrchestrator(
                moderation_api_key=api_key if provider_type == "openai" else None,
            )
            try:
                persisted = await orchestrator.generate(
                    prompt=request.prompt,
                    user_id=request.user_id,
                    message_id=request.message_id,
                    provider_type=provider_type,
                    model_name=model_name,
                    api_key=api_key,
                    size=size,  # type: ignore[arg-type]
                    n=n,
                    quality=quality,  # type: ignore[arg-type]
                )
            except ContentModerationBlocked as e:
                yield emitter.emit_error(str(e), error_code="moderation_blocked")
                yield emitter.emit_stream_end(reason="error")
                return
            except ImageProviderError as e:
                yield emitter.emit_error(str(e), error_code="provider_error")
                yield emitter.emit_stream_end(reason="error")
                return
            except Exception as e:
                logger.exception("Unexpected error in GenerateImage: %s", e)
                yield emitter.emit_error(f"Image generation failed: {e}")
                yield emitter.emit_stream_end(reason="error")
                return

            total = len(persisted)
            for image in persisted:
                yield emitter.emit_image_attached(
                    message_id=request.message_id,
                    storage_path=image.storage_path,
                    mime_type=image.mime_type,
                    width=image.width,
                    height=image.height,
                    prompt=image.prompt,
                    revised_prompt=image.revised_prompt,
                    model_name=image.model_name,
                    idx=image.idx,
                    total=total,
                    cost_cents=image.cost_cents,
                )

            yield emitter.emit_stream_end(reason="completed")

        async for packet in _stream_packets(_gen(), context):
            yield packet

    async def HealthCheck(
        self,
        request: common_pb2.Empty,
        context: grpc.aio.ServicerContext,
    ) -> chat_pb2.HealthCheckResponse:
        """Check chat service health."""
        return chat_pb2.HealthCheckResponse(
            healthy=True,
            version="3.0.0",
            status="serving",
            services={"chat": "healthy", "rag": "healthy"},
        )
