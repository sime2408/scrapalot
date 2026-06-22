"""
Web Search Chat Handler

Extracted from chat.py to handle web search requests.
This module processes chat requests with web_search_enabled=True.
"""

import asyncio
from collections.abc import AsyncGenerator
import json
from uuid import UUID

from sqlmodel import Session as SQLModelSession

from src.main.constants.error_codes import ErrorCode
from src.main.constants.status_codes import StatusCode
from src.main.dto.chat import ChatRequest
from src.main.main import Main
from src.main.service.streaming.packet_emitter import PacketEmitter
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class WebSearchResult:
    """Result container for web search processing."""

    def __init__(self):
        self.received_stream_end = False
        self.full_response = ""
        self.was_cancelled = False


async def process_web_search(
    request: ChatRequest,
    emitter: PacketEmitter,
    main_instance: Main,
    subscription_tier: str,
    db: SQLModelSession,
    user_id: str,
    _assistant_message_id: UUID | None,
    cancellation_event: asyncio.Event,
) -> AsyncGenerator[str, None]:
    """
    Process a web search chat request.

    This function handles web search-enhanced chat:
    1. Initialize web search orchestrator
    2. Process query with web search
    3. Stream results back to client

    Args:
        request: The chat request with web_search_enabled=True
        emitter: PacketEmitter for streaming responses
        main_instance: Main application instance for LLM access
        subscription_tier: User's subscription tier
        db: Database session
        user_id: User ID
        _assistant_message_id: Assistant message ID for tracking
        cancellation_event: Event to signal cancellation

    Yields:
        JSON packet strings for streaming response
    """
    from src.main.service.web_search.web_search_orchestrator import (
        WebSearchOrchestrator,
    )

    logger.info("Starting web search for query: %s", request.prompt[:100])

    result = WebSearchResult()

    try:
        # Get the model for web search
        web_search_llm = await main_instance.llm_manager.get_llm(
            model_name=request.model_name,
            provider_type=request.provider_type,
            enable_metrics=True,
            subscription_tier=subscription_tier,
            db=db,
            user_id=str(user_id),
            message_id=None,  # Web search doesn't need message tracking
        )
        if not web_search_llm:
            logger.error(
                "Failed to get LLM for web search: %s (Provider: %s)",
                request.model_name,
                request.provider_type,
            )
            error_content = f"Failed to initialize LLM for web search: {request.model_name}"
            yield emitter.emit_error(
                error_content,
                error_code=ErrorCode.SERVICE_UNAVAILABLE.value,
            )
            yield emitter.emit_stream_end(reason="error")
            return

        # Send status that web search is starting
        yield emitter.emit_status(
            StatusCode.WEB_SEARCH_STARTING.value,
            stage="initialization",
        )

        # Create a web search orchestrator
        web_orchestrator = WebSearchOrchestrator(web_search_llm)

        # Process the request with web search
        async for chunk in web_orchestrator.process_chat_request(request):
            # Check for cancellation
            if cancellation_event.is_set():
                logger.info("Web search cancelled due to timeout")
                yield emitter.emit_status(
                    StatusCode.REQUEST_CANCELLED.value,
                    stage="cancelled",
                )
                yield emitter.emit_stream_end(reason="cancelled")
                result.was_cancelled = True
                break

            # Parse and handle the chunk, converting raw agent output to PacketEmitter format
            try:
                chunk_data = json.loads(chunk)

                # Check if this is already in PacketEmitter format (has "obj" wrapper)
                if "obj" in chunk_data and "ind" in chunk_data:
                    chunk_type = chunk_data.get("obj", {}).get("type", "")
                    if chunk_type == "stream_end":
                        result.received_stream_end = True
                    yield chunk
                    continue

                # Raw agent output - convert to PacketEmitter format
                chunk_type = chunk_data.get("type", "")

                if chunk_type == "stream_end":
                    result.received_stream_end = True

                elif chunk_type == "bot_answer" and "content" in chunk_data:
                    result.full_response += chunk_data["content"]
                    yield emitter.emit_message_delta(chunk_data["content"])

                elif chunk_type == "final_answer_data":
                    content = chunk_data.get("content", {})
                    answer = content.get("answer", "") if isinstance(content, dict) else str(content)
                    if answer:
                        result.full_response += answer
                        yield emitter.emit_message_delta(answer)

                elif chunk_type == "web_search_sources":
                    sources = chunk_data.get("content", [])
                    if sources:
                        for i, source in enumerate(sources):
                            url = source.get("url", "")
                            if not url:
                                continue
                            yield emitter.emit_citation_info(
                                citation_num=i + 1,
                                document_id=url,
                                document_title=source.get("title", source.get("source", "")),
                                url=url,
                                text=source.get("snippet", ""),
                            )

                elif chunk_type in ("step_start", "step_end"):
                    yield emitter.emit_status(
                        chunk_data.get("content", chunk_type),
                        stage="web_search",
                    )

                elif chunk_type == "think":
                    yield emitter.emit_reasoning_delta(chunk_data.get("content", ""), streamed=True)

                elif chunk_type == "error":
                    yield emitter.emit_error(
                        chunk_data.get("content", "Unknown web search error"),
                        error_code=ErrorCode.WEB_SEARCH_PROCESSING_ERROR.value,
                    )

                else:
                    logger.debug("Unhandled web search chunk type: %s", chunk_type)

            except json.JSONDecodeError:
                logger.warning(
                    "Received non-JSON chunk from web search: %s",
                    chunk[:100] if isinstance(chunk, str) else str(chunk)[:100],
                )
                continue
            except Exception as parse_error:
                logger.error(
                    "Error processing web search chunk: %s",
                    str(parse_error),
                )
                continue

    except Exception as web_search_error:
        logger.error(
            "Error in web search processing: %s",
            str(web_search_error),
        )

        # User-friendly error message for the UI
        error_message = "Web search encountered an error and could not complete. Please check your internet connection and try again."

        yield emitter.emit_error(
            error_message,
            error_code=ErrorCode.WEB_SEARCH_PROCESSING_ERROR.value,
        )
        yield emitter.emit_stream_end(reason="error")
        result.was_cancelled = True
