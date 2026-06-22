from abc import ABC, abstractmethod
from collections.abc import AsyncGenerator
import json
import time
from uuid import UUID

from langchain_core.documents import Document
from langchain_core.language_models.chat_models import BaseChatModel

from src.main.constants.error_codes import ErrorCode
from src.main.constants.status_codes import StatusCode
from src.main.dto.chat import ChatRequest
from src.main.service.rag.citations.citation_generator import CitationGenerator
from src.main.service.rag.rag_utils import process_chat_request_base, process_direct_llm_chat, store_qa_pair
from src.main.service.streaming.citation_processor import StreamingCitationProcessor
from src.main.service.streaming.packet_emitter import PacketEmitter
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# Sparse-document threshold: when normal retrieval returns fewer chunks
# than this, we top up with a web search so the LLM still has something
# to ground a long descriptive answer in. Three is a deliberate sweet
# spot — enough that "the agent found some relevant pages" carries the
# answer on its own; less than that and pure-LLM hallucination risk
# climbs without the web supplement.
SPARSE_DOCS_THRESHOLD = 3

# How many web results to fetch as supplementary context. Smaller than
# the per-query DDG default (5) because we are ADDING to existing doc
# chunks — don't want web noise to drown out the user's library.
WEB_SUPPLEMENT_TOP_K = 5


async def _fetch_web_supplementary(query: str, top_k: int = WEB_SUPPLEMENT_TOP_K) -> list[Document]:
    """Run a DuckDuckGo search and convert hits into Document objects the
    citation processor can index alongside library chunks.

    Returns an empty list on any failure (network, parsing, missing
    config) — web supplement is a best-effort cascade tier, NEVER a
    hard requirement. The caller decides what to do with no results.

    Each returned Document gets:
      - page_content = result.snippet (DDG already condenses)
      - metadata.document_id = stable "web_<idx>" key so the citation
        processor can deduplicate across rounds
      - metadata.source = result.source (domain, e.g. "wikipedia.org")
      - metadata.title = result.title
      - metadata.url = result.link
      - metadata.source_type = "web" so the UI can render it with a
        different icon than library chunks if it wants to
    """
    try:
        web_cfg = resolved_config.get("web_search", {})
        if not web_cfg.get("enabled", True):
            return []
        # Local import: keeps rag_strategy.py importable in contexts
        # where web_search providers aren't installed yet.
        from src.main.service.web_search.duckduckgo_provider import DuckDuckGoProvider

        provider = DuckDuckGoProvider(web_cfg)
        results = await provider.search(query)
    except Exception as e:
        logger.warning("Web supplementary fetch failed: %s", e)
        return []

    docs: list[Document] = []
    for idx, r in enumerate(results[:top_k]):
        snippet = (r.snippet or "").strip()
        if not snippet:
            continue
        docs.append(
            Document(
                page_content=snippet,
                metadata={
                    "document_id": f"web_{idx}",
                    "source": r.source or r.link or "Web",
                    "title": r.title or r.source or r.link or "Web result",
                    "url": r.link or "",
                    "source_type": "web",
                },
            )
        )
    return docs


class RAGStrategy(ABC):
    def __init__(self, llm: BaseChatModel, retriever=None, packet_emitter=None):
        """
        Initialize the RAG strategy.

        Args:
            llm: The language model to use for generating responses
            retriever: The retriever for document search (optional, set by subclass)
            packet_emitter: PacketEmitter for streaming packets (optional)
        """
        self.llm = llm
        self.retriever = retriever
        self.packet_emitter = packet_emitter
        self.vectorstore = None
        self.citation_generator = CitationGenerator()
        self.retrieved_documents = []
        # Query hints from agentic routing (keyword_importance, rare_terms, preferred_search_mode, etc.)
        self.query_hints: dict | None = None

    @abstractmethod
    async def execute(
        self,
        query: str,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
        top_k: int | None = None,
        similarity_threshold: float | None = None,
    ) -> AsyncGenerator[str, None]:
        """
        Execute the RAG strategy and yield packets during processing.

        Yields:
            Packet strings (e.g., reasoning_start, reasoning_delta, section_end)

        Returns:
            None (documents are stored in self.retrieved_documents)
        """
        # Must use: yield packet_str
        # Must store documents in: self.retrieved_documents
        # Must end with: return (no value)

    def get_citation_generator(self) -> CitationGenerator:
        """
        Get the citation generator instance for this strategy.

        Returns:
            CitationGenerator instance
        """
        return self.citation_generator

    async def retrieve_documents_for_realtime_citations(
        self,
        query: str,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
        top_k: int | None = None,
        similarity_threshold: float | None = None,
    ) -> AsyncGenerator[str, list[Document]]:
        """
        Retrieve documents before streaming for real-time citation processing.
        This allows the citation processor to extract citations as the model generates text.
        Now yields packets during execution (e.g., thinking tokens from HyDE).

        Args:
            query: The user's query
            collection_ids: Optional collection IDs to search
            document_ids: Optional specific document IDs
            top_k: Number of documents to retrieve (default: 15)
            similarity_threshold: Minimum similarity score (default: 0.5)

        Yields:
            Packet strings emitted during document retrieval

        Returns:
            List of retrieved documents
        """
        if not collection_ids or len(collection_ids) == 0:
            self.retrieved_documents = []
            return

        try:
            # Execute the strategy and iterate through packets
            # Note: execute() is an async generator that yields packets
            # noinspection PyTypeChecker
            async for packet in self.execute(
                query=query,
                collection_ids=collection_ids,
                document_ids=document_ids,
                top_k=top_k,
                similarity_threshold=similarity_threshold,
            ):
                # Yield packets during retrieval (e.g., thinking tokens from HyDE)
                yield packet

            # Documents are now stored in self.retrieved_documents by execute()
            logger.info(
                "Retrieved %d documents for real-time citation processing (collection_ids=%s, top_k=%s)",
                len(self.retrieved_documents),
                collection_ids,
                top_k,
            )
            if not self.retrieved_documents:
                logger.warning("No documents retrieved! This will result in 0 citations.")
            return
        except Exception as e:
            logger.error("Error retrieving documents for real-time citations: %s", str(e))
            self.retrieved_documents = []
            return

    async def process_chat_request(self, request: ChatRequest) -> AsyncGenerator[str, None]:
        """
        Process a chat request using this RAG strategy with direct packet emission.

        This method:
        1. Check if this is a direct LLM interaction (no collections)
        2. If direct, use the direct LLM chat path
        3. Otherwise, use the normal RAG flow with document retrieval
        4. Emit packets directly (no adapter needed)
        5. Process citations in real-time as the model generates

        Args:
                request: The chat request containing prompt, collection info, etc.

        Yields:
                Packet-format JSON strings (indexed packets with type-safe structure)
        """
        # Use injected packet_emitter if available, otherwise create new one
        emitter = getattr(self, "packet_emitter", None) or PacketEmitter()

        # Check if this is a direct LLM interaction (no collections)
        if not request.collection_ids or len(request.collection_ids) == 0:
            # Use a direct LLM chat path without RAG
            # Pass user_id from request (required for process_direct_llm_chat)
            user_id = request.user_id or "unknown"
            async for chunk in process_direct_llm_chat(request, user_id, emitter):
                yield chunk
            # Skip context fetching for direct LLM chats
            return

        # Normal RAG flow with context retrieval
        full_response = ""
        citation_processor = None
        _rag_start_time = time.monotonic()

        # Attach per-request TokenMetricsCallback to capture token usage
        _metrics_callback = None
        if self.llm:
            try:
                from src.main.service.llm.token_metrics import TokenMetricsTracker
                from src.main.service.llm.token_metrics_callback import TokenMetricsCallback

                _metrics_callback = TokenMetricsCallback(
                    metrics_tracker=TokenMetricsTracker(),
                    db=None,  # type: ignore[arg-type]
                    provider=getattr(request, "provider_type", "unknown") or "unknown",
                    model=getattr(request, "model_name", "unknown") or "unknown",
                    user_id=getattr(request, "user_id", None),
                )
                if not hasattr(self.llm, "callbacks") or self.llm.callbacks is None:
                    self.llm.callbacks = []
                # noinspection PyUnresolvedReferences
                self.llm.callbacks.append(_metrics_callback)
            except Exception as cb_err:
                logger.debug("Failed to attach per-request metrics callback: %s", cb_err)

        # Check if documents were already retrieved (for real-time citations)
        if not self.retrieved_documents:
            # Emit status: retrieving documents
            yield emitter.emit_status(StatusCode.RETRIEVING_DOCUMENTS.value, stage="retrieval")

            # Narrator beat #6: the user has been waiting ~10-20s by now
            # for collection selector + orchestrator to finish. Tell them
            # the retrieval is starting with a human sentence — what
            # strategy was picked, in what scope. `request.language`
            # picks HR/EN.
            _strategy_label_hr = self.__class__.__name__.replace("RAG", "")
            _scope_label = f"{len(request.collection_ids)} kolekciji" if getattr(request, "collection_ids", None) else "tvojoj knjižnici"
            _lang = (getattr(request, "language", None) or "").lower()
            _is_hr = not _lang or _lang.startswith("hr")
            yield emitter.emit_reasoning_delta(
                f"Pretražujem semantički po {_scope_label} ({_strategy_label_hr})."
                if _is_hr
                else f"Searching semantically across {len(request.collection_ids) if getattr(request, 'collection_ids', None) else 'your library'} ({_strategy_label_hr})."
            )

            # First, execute the RAG strategy to get retrieved documents
            # execute() is a generator - iterate and yield packets
            try:
                execute_gen = self.execute(
                    query=request.prompt,
                    collection_ids=request.collection_ids,
                    document_ids=request.document_ids,
                )

                # Yield all packets from execute (e.g., thinking tokens from HyDE)
                # noinspection PyTypeChecker
                async for packet_str in execute_gen:
                    yield packet_str

                # Documents are now stored in self.retrieved_documents by execute()
                logger.info(
                    "Retrieved %d documents for citation generation",
                    len(self.retrieved_documents),
                )

                # Narrator beat #7: report what retrieval actually found.
                # This is the single most reassuring datapoint — "agent
                # has N candidates" is concrete progress.
                _n = len(self.retrieved_documents)
                _is_hr = not _lang or _lang.startswith("hr")
                if _n > 0:
                    yield emitter.emit_reasoning_delta(
                        f"Pronašao sam {_n} relevantnih odlomaka — sad ih prosudim po kvaliteti."
                        if _is_hr
                        else f"Found {_n} relevant passages — judging them by quality next."
                    )
                else:
                    yield emitter.emit_reasoning_delta(
                        "Pretraga nije vratila ništa relevantno — pisat ću iz općeg znanja s napomenom."
                        if _is_hr
                        else "Search returned nothing relevant — I'll answer from general knowledge with a note."
                    )

                # (CE) Cross-encoder precision reranking is a hosted-only feature — skipped here.

            except Exception as e:
                logger.error("Error retrieving documents for citations: %s", str(e))
                yield emitter.emit_error(
                    f"Error retrieving documents: {e!s}",
                    error_code=ErrorCode.PROCESS_FAILED.value,
                )
                self.retrieved_documents = []
        else:
            logger.info(
                "Using %d pre-retrieved documents for real-time citations",
                len(self.retrieved_documents),
            )

            # (CE) Cross-encoder precision reranking is a hosted-only feature — skipped here.

        # Step 2 cascade: when the library retrieval is sparse (or fully
        # empty) top up with a DuckDuckGo supplementary search so the LLM
        # has *something* to cite for a long descriptive answer. The user's
        # preferred priority is library-first, web-second, LLM-third — so
        # web docs land AFTER library docs in the same retrieved_documents
        # list, and the augmented prompt naturally surfaces them as
        # secondary sources. Web supplement is best-effort: a failure here
        # never blocks the response.
        _doc_count_before_web = len(self.retrieved_documents) if self.retrieved_documents else 0
        if _doc_count_before_web < SPARSE_DOCS_THRESHOLD:
            _lang_w = (getattr(request, "language", None) or "").lower()
            _is_hr_w = not _lang_w or _lang_w.startswith("hr")
            if _doc_count_before_web == 0:
                yield emitter.emit_reasoning_delta(
                    "Knjižnica nije pokrila pitanje — dopunjavam web pretragom."
                    if _is_hr_w
                    else "Library didn't cover the question — supplementing with a web search."
                )
            else:
                yield emitter.emit_reasoning_delta(
                    f"Pronašao sam samo {_doc_count_before_web} odlomaka u knjižnici — dodajem web rezultate."
                    if _is_hr_w
                    else f"Only {_doc_count_before_web} library passages — adding web results."
                )
            web_docs = await _fetch_web_supplementary(request.prompt, top_k=WEB_SUPPLEMENT_TOP_K)
            if web_docs:
                self.retrieved_documents = (self.retrieved_documents or []) + web_docs
                yield emitter.emit_reasoning_delta(
                    f"Dodano {len(web_docs)} web izvora — krećem sa odgovorom utemeljenim na knjižnici + webu."
                    if _is_hr_w
                    else f"Added {len(web_docs)} web sources — drafting an answer grounded in both library and web."
                )
                logger.info(
                    "Web cascade: %d library + %d web docs (was sparse at %d)",
                    _doc_count_before_web,
                    len(web_docs),
                    _doc_count_before_web,
                )
            else:
                logger.info("Web cascade returned 0 results — proceeding with library-only context")

        # Initialize a citation processor for real-time extraction
        if self.retrieved_documents:
            citation_processor = StreamingCitationProcessor(
                context_docs=self.retrieved_documents,
                max_citation_num=len(self.retrieved_documents),
                user_query=getattr(request, "prompt", None),
            )
            # Note: citation_start is now emitted in the controller before streaming starts
            logger.info(
                "🔧 Initialized citation processor with %d documents",
                len(self.retrieved_documents),
            )
        else:
            logger.warning("⚠️ No retrieved documents - citation processor NOT initialized")

        # Emit status: generating response
        yield emitter.emit_status(StatusCode.GENERATING_RESPONSE.value, stage="generation")

        # Narrator beat #8: announce the generation phase. From here on
        # tokens stream in token-by-token, so this is the last "thinking"
        # line the user sees before the answer body starts. Mention the
        # citation contract — that's what users care about ("am I getting
        # a sourced answer or LLM-from-memory?").
        _lang2 = (getattr(request, "language", None) or "").lower()
        _is_hr2 = not _lang2 or _lang2.startswith("hr")
        _n2 = len(self.retrieved_documents) if self.retrieved_documents else 0
        if _n2 > 0:
            yield emitter.emit_reasoning_delta(
                f"Sastavljam odgovor — povezujem {_n2} izvora u koherentan tekst s citacijama."
                if _is_hr2
                else f"Drafting the answer — weaving {_n2} sources together with citations."
            )

        # Emit RAG debug info with strategy name for frontend trace UI
        yield emitter.emit_rag_debug_info(
            strategy_name=self.__class__.__name__,
            context_document_count=len(self.retrieved_documents) if self.retrieved_documents else 0,
        )

        # Pass retrieved documents directly to process_chat_request_base.
        # Propagate the query characteristics so the synthesis
        # path can prepend a category-conditioned prompt variant. Falls
        # through to the default prompt when `self.query_hints` is None
        # (e.g. manual-strategy mode without agentic routing).
        chunk_count = 0
        async for chunk in process_chat_request_base(
            request,
            retrieved_documents=self.retrieved_documents,
            query_characteristics=self.query_hints,
        ):
            # Try to accumulate the response for storage and process citations
            try:
                if isinstance(chunk, str):
                    chunk_data = json.loads(chunk.rstrip())
                    # Packets are indexed: {"ind": N, "obj": {"type": ..., "content": ...}}
                    obj = chunk_data.get("obj", chunk_data)
                    chunk_type = obj.get("type")
                    content = obj.get("content") or ""

                    chunk_count += 1
                    if chunk_count <= 3 or chunk_type == "message_delta":
                        logger.debug(
                            "🔍 Chunk #%s: type=%s, content_len=%s, has_processor=%s",
                            chunk_count,
                            chunk_type,
                            len(content),
                            citation_processor is not None,
                        )

                    if chunk_type == "message_delta" and content:
                        # Accumulate for storage
                        full_response += content

                        # Process through citation processor if enabled
                        if citation_processor:
                            # Debug: Log content being processed for citations
                            if "[" in content or "]" in content:
                                logger.debug(
                                    "🔍 Processing content with brackets: %s",
                                    content[:100],
                                )

                            display_text, citations = citation_processor.process_token(content)

                            # Debug: Log if no citations found but content has brackets
                            if not citations and ("[" in content or "]" in content):
                                logger.debug(
                                    "⚠️ No citations found in content with brackets: %s, buffer: %s",
                                    content[:100],
                                    citation_processor.buffer[:50],
                                )

                            # Emit citations first
                            if citations:
                                logger.info(
                                    "📌 Emitting %s citation(s) from token: %s",
                                    len(citations),
                                    content[:50],
                                )
                            for citation in citations:
                                logger.info("📌 Emitting citation packet: %s", citation)
                                yield emitter.emit(citation)

                            # Then emit display text
                            if display_text:
                                yield emitter.emit_message_delta(display_text)
                        else:
                            logger.warning(
                                "⚠️ Citation processor is None but we have content: %s",
                                content[:30],
                            )
                            # Packet already has a correct format, just pass through
                            yield chunk

                    else:
                        # All other packet types (status, error, reasoning_delta, etc.) pass through
                        yield chunk

            except json.JSONDecodeError:
                # If we can't parse it, skip
                logger.warning("Failed to parse chunk as JSON")
            except Exception as e:
                logger.exception("Error processing chunk: %s", e)
                yield emitter.emit_error(
                    f"Error processing stream: {e!s}",
                    error_code=ErrorCode.PROCESS_FAILED.value,
                )

        # Only attempt to store if we have a complete response and collections
        if full_response and request.collection_ids and len(request.collection_ids) > 0:
            # Store the Q&A pair in the primary collection
            primary_collection_id: UUID = request.collection_ids[0]
            try:
                # Try to store using retriever's vectorstore attribute
                if hasattr(self, "retriever") and hasattr(self.retriever, "vectorstore") and self.retriever.vectorstore is not None:
                    await store_qa_pair(
                        self.retriever.vectorstore,
                        request.prompt,
                        full_response,
                        primary_collection_id,
                    )
                # Try to store using the vectorstore attribute directly
                elif hasattr(self, "vectorstore") and self.vectorstore is not None:
                    await store_qa_pair(
                        self.vectorstore,
                        request.prompt,
                        full_response,
                        primary_collection_id,
                    )
                # Fallback to using retriever
                elif hasattr(self, "retriever") and self.retriever is not None:
                    await store_qa_pair(
                        self.retriever,
                        request.prompt,
                        full_response,
                        primary_collection_id,
                    )
            except Exception as e:
                logger.warning("Failed to store Q&A pair: %s", str(e))

        # Flush citation processor if active
        if citation_processor:
            try:
                remaining_text, remaining_citations = citation_processor.flush()

                # Emit any remaining citations
                for citation in remaining_citations:
                    yield emitter.emit(citation)

                # Emit any remaining text
                if remaining_text:
                    yield emitter.emit_message_delta(remaining_text)

                # Emit section end
                yield emitter.emit_section_end()

                logger.info("Flushed citation processor")

                # Smart Citations (Scite): re-emit with stance classification.
                # Runs post-synthesis so initial response is not delayed. Frontend
                # merges by citation_num and colours the existing chips.
                try:
                    updated_citations = await citation_processor.classify_stance_batch()
                    for citation in updated_citations:
                        yield emitter.emit(citation)
                except Exception as stance_err:
                    logger.warning("Stance classification skipped: %s", stance_err)

            except Exception as e:
                logger.error("Error flushing citation processor: %s", str(e))
                yield emitter.emit_error(
                    f"Error processing citations: {e!s}",
                    error_code=ErrorCode.PROCESS_FAILED.value,
                )

        # Get context documents and include them in the response
        try:
            # Use already retrieved documents to avoid double execution
            # Context documents are already emitted as citation_info packets
            # No need to emit additional context status packets
            context = self.retrieved_documents if self.retrieved_documents else []
            if not context:
                logger.warning("No retrieved documents available for context display")
        except Exception as e:
            logger.error("Error including context documents: %s", str(e))
            yield emitter.emit_error(
                f"Error including context: {e!s}",
                error_code=ErrorCode.PROCESS_FAILED.value,
            )
        finally:
            _duration_ms = int((time.monotonic() - _rag_start_time) * 1000)

            # Extract token metrics from per-request callback
            token_metrics: dict = {}
            if _metrics_callback and _metrics_callback.last_metrics is not None:
                m = _metrics_callback.last_metrics
                # noinspection PyUnresolvedReferences
                token_metrics = {
                    "input_tokens": m.input_tokens,
                    "output_tokens": m.output_tokens,
                    "total_tokens": m.total_tokens,
                    "tokens_per_second": m.tokens_per_second,
                    "cost_usd": m.cost_usd,
                    "latency_ms": m.latency_ms,
                    "provider": m.provider,
                    "model": m.model,
                }

            # Remove per-request callback to prevent accumulation on cached LLM
            if _metrics_callback and self.llm and hasattr(self.llm, "callbacks") and self.llm.callbacks:
                try:
                    # noinspection PyUnresolvedReferences
                    self.llm.callbacks.remove(_metrics_callback)
                except ValueError:
                    # Callback already absent from the cached LLM; nothing to clean up.
                    pass

            yield emitter.emit_stream_end(reason="completed", duration_ms=_duration_ms, **token_metrics)

            # Clear retrieved documents to prevent state pollution between requests
            self.retrieved_documents = []
            logger.debug("Cleared retrieved documents after request completion")
