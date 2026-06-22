import asyncio
from collections.abc import AsyncIterator

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage

from src.main.constants.error_codes import ErrorCode
from src.main.dto.chat import ChatRequest
from src.main.service.streaming.packet_emitter import PacketEmitter
from src.main.service.web_search.search_provider_factory import SearchProviderFactory
from src.main.service.web_search.web_search_agent import (
    WebSearchAgent,
    WebSearchCallbackHandler,
)
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class WebSearchOrchestrator:
    """Orchestrator for web search functionality that integrates with the chat system."""

    def __init__(self, llm, packet_emitter=None):
        """Initialize the web search orchestrator with an LLM."""
        self.llm = llm
        self.packet_emitter = packet_emitter
        self.web_search_enabled = resolved_config.get("web_search", {}).get("enabled", True)

    async def process_chat_request(self, request: ChatRequest) -> AsyncIterator[str]:
        """
        Process a chat request with web search capabilities.

        Args:
            request: ChatRequest object containing the user's query and settings

        Yields:
            JSON strings with streaming response data in the format:
            {"type": "...", "content": "..."}
        """
        # Use injected emitter or create new one
        emitter = self.packet_emitter or PacketEmitter()

        try:
            # Check if web search is enabled in config and request
            if not self.web_search_enabled:
                yield emitter.emit_error(
                    "Web search is not enabled in the configuration",
                    error_code=ErrorCode.WEB_SEARCH_DISABLED.value,
                )
                yield emitter.emit_stream_end(reason="error")
                return

            logger.info("Starting web search for query: %s", request.prompt[:100])

            # Get current search provider info
            try:
                provider = SearchProviderFactory.get_provider()
                _provider_name = provider.provider_name
                logger.info("Using search provider: %s", _provider_name)
            except Exception as e:
                logger.warning("Could not determine search provider: %s", str(e))

            # Send initial status
            from src.main.constants.status_codes import StatusCode

            yield emitter.emit_status(StatusCode.WEB_SEARCH_STARTING.value, stage="initialization")

            # Create web search agent and callback handler
            chat_history = self._build_chat_history(request.conversation_history)
            agent = WebSearchAgent(self.llm, chat_history=chat_history)
            callback_handler = WebSearchCallbackHandler()

            # Start streaming the callback handler output
            callback_task = asyncio.create_task(self._stream_callback_output(callback_handler))

            # Process the query with the agent (iterate directly over async generator)
            try:
                async for item in self._process_agent_query(agent, request.prompt, callback_handler, emitter):
                    yield item
            finally:
                # Cancel callback streaming
                callback_task.cancel()
                try:
                    await callback_task
                except asyncio.CancelledError:
                    # Expected: we cancelled callback_task above.
                    pass

            # Send final stream end
            yield emitter.emit_stream_end(reason="completed")

        except Exception as e:
            logger.error("Error in WebSearchOrchestrator.process_chat_request: %s", e)
            yield emitter.emit_error(
                f"An error occurred during web search: {e!s}",
                error_code=ErrorCode.WEB_SEARCH_PROCESSING_ERROR.value,
            )
            yield emitter.emit_stream_end(reason="error")

    @staticmethod
    def _build_chat_history(conversation_history: list) -> list[BaseMessage]:
        """Convert conversation history dicts to LangChain BaseMessage objects."""
        messages: list[BaseMessage] = []
        for msg in conversation_history:
            role = msg.get("role", "") if isinstance(msg, dict) else getattr(msg, "role", "")
            content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")
            if not content or not content.strip():
                continue
            if role == "user":
                messages.append(HumanMessage(content=content))
            elif role == "assistant":
                messages.append(AIMessage(content=content))
        return messages

    @staticmethod
    async def _stream_callback_output(callback_handler: WebSearchCallbackHandler):
        """Stream output from the callback handler."""
        try:
            async for _item in callback_handler:
                # The callback handler already formats items as JSON strings
                pass  # Items are yielded through the main process_chat_request method
        except asyncio.CancelledError:
            # Expected on teardown when the callback stream is cancelled.
            pass
        except Exception as e:
            logger.error("Error streaming callback output: %s", e)

    @staticmethod
    async def _process_agent_query(
        agent: WebSearchAgent,
        query: str,
        callback_handler: WebSearchCallbackHandler,
        emitter: PacketEmitter,
    ):
        """Process the agent query and return results."""
        try:
            async for result in agent.process_query(query, callback_handler):
                yield result
        except Exception as e:
            logger.error("Error processing agent query: %s", e)
            yield emitter.emit_error(
                f"Agent processing error: {e!s}",
                error_code=ErrorCode.WEB_SEARCH_AGENT_ERROR.value,
            )


class WebSearchService:
    """Service class for web search functionality."""

    @staticmethod
    async def create_orchestrator(llm) -> WebSearchOrchestrator:
        """Create and return a web search orchestrator."""
        return WebSearchOrchestrator(llm)

    @staticmethod
    def is_web_search_enabled() -> bool:
        """Check if web search is enabled in configuration."""
        return resolved_config.get("web_search", {}).get("enabled", True)

    @staticmethod
    def get_web_search_config() -> dict:
        """Get web search configuration."""
        return resolved_config.get("web_search", {})
